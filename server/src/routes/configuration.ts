import { Router } from 'express';
import type { Request, Response } from 'express';
import { z } from 'zod';
import { requireAdmin } from '../lib/admin-auth.js';
import {
  ConfigurationRevisionConflictError,
  ConfigurationValidationError,
  createConfigurationModel,
  getConfigurationSnapshot,
  updateConfigurationModel,
  updateConfigurationRoute,
} from '../services/configuration-v2.js';

export const configurationRouter = Router();
configurationRouter.use((req: Request, res: Response, next) => {
  if (requireAdmin(req, res)) next();
});

const revisionSchema = z.number().int().nonnegative().optional();
const memberSchema = z.object({
  modelDbId: z.number().int().positive(),
  priority: z.number().int().positive(),
  enabled: z.boolean(),
});
const routeSchema = z.object({
  expectedRevision: revisionSchema,
  name: z.string().trim().min(1).max(160).optional(),
  enabled: z.boolean().optional(),
  visible: z.boolean().optional(),
  members: z.array(memberSchema).min(1).max(512),
}).strict();
const modelSchema = z.object({
  expectedRevision: revisionSchema,
  displayName: z.string().trim().min(1).max(200).optional(),
  enabled: z.boolean().optional(),
  contextWindow: z.number().int().positive().max(2_000_000).nullable().optional(),
  nativeVision: z.boolean().optional(),
  supportsReasoning: z.boolean().optional(),
}).strict();
const createModelSchema = z.object({
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
