/* Schemas de validacion del control de proveedores.
 * [por que] Los schemas zod ocupaban mas de la cuenta en routes/control/registry.ts
 * (sobre el limite de 300 lineas); viven aqui para mantener el router delgado. */
import { z } from 'zod';

export const capabilitiesSchema = z.object({
  streaming: z.boolean(),
  tools: z.boolean(),
  reasoning: z.boolean(),
  multimodal: z.boolean(),
  maxContextWindow: z.number().int().positive().max(2_000_000).nullable(),
});

export const providerDraftSchema = z.object({
  platform: z.string().trim().regex(/^[a-z][a-z0-9-]{1,63}$/, 'platform must be a stable lowercase slug'),
  displayName: z.string().trim().min(1).max(120),
  adapter: z.enum(['openai-compatible', 'google-gemini', 'cohere', 'cloudflare-workers-ai']),
  endpoint: z.string().url().refine(value => new URL(value).protocol === 'https:', 'endpoint must use https'),
  authScheme: z.enum(['bearer', 'account-and-token']),
  capabilities: capabilitiesSchema,
});

export const verificationSchema = z.object({
  check: z.enum(['health', 'chat', 'capabilities']),
  keyId: z.number().int().positive().optional(),
  modelId: z.string().trim().min(1).max(200).optional(),
});

export const duplicateSchema = z.object({
  platform: z.string().trim().regex(/^[a-z][a-z0-9-]{1,63}$/, 'platform must be a stable lowercase slug'),
  displayName: z.string().trim().min(1).max(120).optional(),
});

export const modelSelectionSchema = z.object({
  models: z.array(z.object({
    modelId: z.string().trim().min(1).max(200),
    displayName: z.string().trim().min(1).max(200),
    contextWindow: z.number().int().positive().max(2_000_000).nullable(),
    capabilities: capabilitiesSchema,
  })).min(1).max(64).superRefine((models, context) => {
    const seen = new Set<string>();
    models.forEach((model, index) => {
      if (seen.has(model.modelId)) context.addIssue({ code: z.ZodIssueCode.custom, path: [index, 'modelId'], message: 'modelId must be unique within a provider selection' });
      seen.add(model.modelId);
    });
  }),
});

export const providerStateSchema = z.object({ enabled: z.boolean() }).strict();
