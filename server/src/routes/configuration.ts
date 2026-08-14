import { Router } from 'express';
import type { Request, Response } from 'express';
import { z } from 'zod';
import { requireAdmin } from '../lib/admin-auth.js';
import {
  ConfigurationRevisionConflictError,
  ConfigurationValidationError,
  createConfigurationModel,
  createConfigurationProvider,
  getConfigurationSnapshot,
  updateConfigurationModel,
  updateConfigurationProvider,
  updateConfigurationRoute,
} from '../services/configuration-v2.js';

export const configurationRouter = Router();
configurationRouter.use((req: Request, res: Response, next) => {
  if (requireAdmin(req, res)) next();
});

const revisionSchema = z.number().int().nonnegative().optional();
const idempotencyKeySchema = z.string().regex(/^[A-Za-z0-9._:-]{1,128}$/).optional();
const memberSchema = z.object({
  modelDbId: z.number().int().positive(),
  priority: z.number().int().positive(),
  enabled: z.boolean(),
});
const routeSchema = z.object({
  expectedRevision: revisionSchema,
  idempotencyKey: idempotencyKeySchema,
  name: z.string().trim().min(1).max(160).optional(),
  enabled: z.boolean().optional(),
  visible: z.boolean().optional(),
  members: z.array(memberSchema).min(1).max(512),
}).strict();
const modelSchema = z.object({
  expectedRevision: revisionSchema,
  idempotencyKey: idempotencyKeySchema,
  displayName: z.string().trim().min(1).max(200).optional(),
  enabled: z.boolean().optional(),
  contextWindow: z.number().int().positive().max(2_000_000).nullable().optional(),
  nativeVision: z.boolean().optional(),
  supportsReasoning: z.boolean().optional(),
  bridgeVisible: z.boolean().optional(),
}).strict();
const createModelSchema = z.object({
  idempotencyKey: idempotencyKeySchema,
  platform: z.string().trim().regex(/^[a-z][a-z0-9-]{1,63}$/),
  modelId: z.string().trim().min(1).max(200),
  displayName: z.string().trim().min(1).max(200),
  contextWindow: z.number().int().positive().max(2_000_000).nullable().optional(),
  nativeVision: z.boolean().optional(),
  supportsReasoning: z.boolean().optional(),
  intelligenceRank: z.number().int().positive().optional(),
  speedRank: z.number().int().positive().optional(),
  addToAuto: z.boolean().optional(),
}).strict();
const providerCapabilitiesSchema = z.object({
  streaming: z.boolean().optional(),
  tools: z.boolean().optional(),
  reasoning: z.boolean().optional(),
  multimodal: z.boolean().optional(),
  maxContextWindow: z.number().int().positive().max(2_000_000).nullable().optional(),
}).strict();
const providerTransportSchema = z.object({
  messageProfile: z.enum(['none', 'null-assistant', 'deepseek-thinking']).optional(),
  includeStreamUsage: z.boolean().optional(),
  bufferUntilContent: z.boolean().optional(),
  bufferUntilDone: z.boolean().optional(),
  maxReasoningEffort: z.enum(['low', 'medium', 'high', 'max']).optional(),
  modelAliases: z.record(z.string().regex(/^[A-Za-z0-9._:/-]{1,200}$/)).optional(),
  modelReasoningLimits: z.record(z.enum(['low', 'medium', 'high', 'max'])).optional(),
  extraHeadersProfile: z.enum(['none', 'openrouter']).optional(),
}).strict();
const providerPolicySchema = z.object({
  cooldownMs: z.number().int().min(0).max(86_400_000).optional(),
  rateLimitCooldownMs: z.number().int().min(0).max(604_800_000).optional(),
  recordPenalty: z.boolean().optional(),
  recordProviderFailure: z.boolean().optional(),
}).strict();
const providerPatchSchema = z.object({
  expectedRevision: revisionSchema,
  idempotencyKey: idempotencyKeySchema,
  displayName: z.string().trim().min(1).max(200).optional(),
  lifecycle: z.enum(['active', 'archived', 'draft']).optional(),
  enabled: z.boolean().optional(),
  endpoint: z.string().trim().min(1).max(2048).optional(),
  timeoutMs: z.number().int().min(1000).max(300000).optional(),
  capabilities: providerCapabilitiesSchema.optional(),
  transport: providerTransportSchema.optional(),
  failurePolicy: providerPolicySchema.optional(),
}).strict();
const createProviderSchema = z.object({
  expectedRevision: revisionSchema,
  idempotencyKey: idempotencyKeySchema,
  platform: z.string().trim().regex(/^[a-z][a-z0-9-]{1,63}$/),
  displayName: z.string().trim().min(1).max(200),
  endpoint: z.string().trim().min(1).max(2048),
  adapter: z.literal('openai-compatible').optional(),
  authScheme: z.literal('bearer').optional(),
  timeoutMs: z.number().int().min(1000).max(300000).optional(),
  capabilities: providerCapabilitiesSchema.optional(),
  transport: providerTransportSchema.optional(),
  failurePolicy: providerPolicySchema.optional(),
  enabled: z.boolean().optional(),
  lifecycle: z.enum(['active', 'draft']).optional(),
}).strict();

function handleConfigurationError(error: unknown, res: Response): void {
  if (error instanceof ConfigurationRevisionConflictError) {
    res.status(409).json({ error: { code: 'configuration_revision_conflict', message: error.message }, currentRevision: error.currentRevision });
    return;
  }
  if (error instanceof ConfigurationValidationError) {
    res.status(400).json({ error: { code: 'invalid_configuration', message: error.message } });
    return;
  }
  throw error;
}

configurationRouter.get('/', (_req, res) => {
  res.json(getConfigurationSnapshot());
});

configurationRouter.put('/routes/:routeId', (req, res) => {
  const routeId = typeof req.params.routeId === 'string' ? req.params.routeId : '';
  const parsed = routeSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: { code: 'invalid_configuration', message: parsed.error.errors.map(error => error.message).join(', ') } });
    return;
  }
  try {
    res.json(updateConfigurationRoute(routeId, { ...parsed.data, actor: 'dashboard', source: 'configuration-api' }));
  } catch (error) {
    handleConfigurationError(error, res);
  }
});

configurationRouter.patch('/models/:modelDbId', (req, res) => {
  const modelDbId = Number(req.params.modelDbId);
  if (!Number.isSafeInteger(modelDbId) || modelDbId <= 0) {
    res.status(400).json({ error: { code: 'invalid_configuration', message: 'modelDbId is invalid' } });
    return;
  }
  const parsed = modelSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: { code: 'invalid_configuration', message: parsed.error.errors.map(error => error.message).join(', ') } });
    return;
  }
  if (Object.keys(parsed.data).length <= (parsed.data.expectedRevision === undefined ? 0 : 1)) {
    res.status(400).json({ error: { code: 'invalid_configuration', message: 'At least one model setting is required' } });
    return;
  }
  try {
    res.json(updateConfigurationModel(modelDbId, { ...parsed.data, actor: 'dashboard', source: 'configuration-api' }));
  } catch (error) {
    handleConfigurationError(error, res);
  }
});

configurationRouter.post('/models', (req, res) => {
  const parsed = createModelSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: { code: 'invalid_configuration', message: parsed.error.errors.map(error => error.message).join(', ') } });
    return;
  }
  try {
    res.status(201).json(createConfigurationModel({ ...parsed.data, actor: 'dashboard', source: 'configuration-api' }));
  } catch (error) {
    handleConfigurationError(error, res);
  }
});

configurationRouter.patch('/providers/:platform', (req, res) => {
  const platform = typeof req.params.platform === 'string' ? req.params.platform : '';
  const parsed = providerPatchSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: { code: 'invalid_configuration', message: parsed.error.errors.map(error => error.message).join(', ') } });
    return;
  }
  try {
    res.json(updateConfigurationProvider(platform, { ...parsed.data, actor: 'dashboard', source: 'configuration-api' }));
  } catch (error) {
    handleConfigurationError(error, res);
  }
});

configurationRouter.post('/providers', (req, res) => {
  const parsed = createProviderSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: { code: 'invalid_configuration', message: parsed.error.errors.map(error => error.message).join(', ') } });
    return;
  }
  try {
    res.status(201).json(createConfigurationProvider({ ...parsed.data, actor: 'dashboard', source: 'configuration-api' }));
  } catch (error) {
    handleConfigurationError(error, res);
  }
});
