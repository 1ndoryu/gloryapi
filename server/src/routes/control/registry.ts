import { Router } from 'express';
import type { Request, Response } from 'express';
import { z } from 'zod';
import {
  activateProviderDraft,
  getRegistrySnapshot,
  KNOWN_PROVIDER_PLATFORMS,
  recordProviderVerification,
  removeProviderDraft,
  saveProviderDraft,
} from '../../providers/registry.js';
import type { CapabilityProfile, Platform, ProviderAdapterKind } from '@gloryapi/shared/types.js';
import { getDb } from '../../db/index.js';
import { getProvider } from '../../providers/index.js';
import { resolveStoredCredential } from '../../lib/dpapi-vault.js';

export const registryRouter = Router();

const capabilitiesSchema = z.object({
  streaming: z.boolean(),
  tools: z.boolean(),
  reasoning: z.boolean(),
  multimodal: z.boolean(),
  maxContextWindow: z.number().int().positive().max(2_000_000).nullable(),
});

const providerDraftSchema = z.object({
  platform: z.enum(KNOWN_PROVIDER_PLATFORMS),
  displayName: z.string().trim().min(1).max(120),
  adapter: z.enum(['openai-compatible', 'google-gemini', 'cohere', 'cloudflare-workers-ai']),
  endpoint: z.string().url().refine(value => new URL(value).protocol === 'https:', 'endpoint must use https'),
  authScheme: z.enum(['bearer', 'account-and-token']),
  capabilities: capabilitiesSchema,
});

const verificationSchema = z.object({
  check: z.enum(['health', 'chat', 'capabilities']),
  keyId: z.number().int().positive().optional(),
  modelId: z.string().trim().min(1).max(200).optional(),
});

type StoredCredentialForVerification = {
  encrypted_key: string;
  iv: string;
  auth_tag: string;
  encryption_scheme: string;
  fingerprint: string | null;
};

registryRouter.get('/', (_req: Request, res: Response) => {
  res.json(getRegistrySnapshot());
});

function parseDraft(req: Request, res: Response): z.infer<typeof providerDraftSchema> | undefined {
  const parsed = providerDraftSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: { message: parsed.error.errors.map(error => error.message).join(', ') } });
    return undefined;
  }
  return parsed.data;
}

registryRouter.post('/providers', (req: Request, res: Response) => {
  const draft = parseDraft(req, res);
  if (!draft) return;
  try {
    saveProviderDraft({
      ...draft,
      platform: draft.platform as Platform,
      adapter: draft.adapter as ProviderAdapterKind,
      capabilities: draft.capabilities as CapabilityProfile,
    });
    res.status(201).json({ success: true, lifecycle: 'draft', platform: draft.platform });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Provider draft rejected';
    res.status(409).json({ error: { message } });
  }
});

registryRouter.put('/providers/:platform', (req: Request, res: Response) => {
  const platform = typeof req.params.platform === 'string' ? req.params.platform : '';
  const draft = parseDraft(req, res);
  if (!draft || draft.platform !== platform) {
    if (draft) res.status(400).json({ error: { message: 'Path platform must match the definition' } });
    return;
  }
  try {
    saveProviderDraft({
      ...draft,
      platform: draft.platform as Platform,
      adapter: draft.adapter as ProviderAdapterKind,
      capabilities: draft.capabilities as CapabilityProfile,
    });
    res.json({ success: true, lifecycle: 'draft', platform: draft.platform });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Provider draft rejected';
    res.status(409).json({ error: { message } });
  }
});

registryRouter.delete('/providers/:platform', (req: Request, res: Response) => {
  const platform = typeof req.params.platform === 'string' ? req.params.platform : '';
  if (!removeProviderDraft(platform)) {
    res.status(404).json({ error: { message: 'Provider draft not found' } });
    return;
  }
  res.json({ success: true });
});

registryRouter.post('/providers/:platform/verify', async (req: Request, res: Response) => {
  const platform = typeof req.params.platform === 'string' ? req.params.platform : '';
  const parsed = verificationSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: { message: parsed.error.errors.map(error => error.message).join(', ') } });
    return;
  }

  const provider = getProvider(platform as Platform);
  const draft = getDb().prepare("SELECT lifecycle FROM provider_registry WHERE platform = ? AND lifecycle = 'draft'").get(platform);
  if (!draft) {
    res.status(404).json({ error: { message: 'Provider draft not found' } });
    return;
  }
  if (!provider) {
    res.status(409).json({ error: { message: 'Provider adapter is not registered' } });
    return;
  }

  const { check, keyId, modelId } = parsed.data;
  if (check === 'capabilities') {
    recordProviderVerification(platform, check);
    res.json({ success: true, check });
    return;
  }
  if (!keyId) {
    res.status(400).json({ error: { message: 'keyId is required for external verification' } });
    return;
  }
  if (check === 'chat' && !modelId) {
    res.status(400).json({ error: { message: 'modelId is required for chat verification' } });
    return;
  }

  const row = getDb().prepare(`
    SELECT encrypted_key, iv, auth_tag, encryption_scheme, fingerprint
    FROM api_keys WHERE id = ? AND platform = ? AND enabled = 1
  `).get(keyId, platform) as StoredCredentialForVerification | undefined;
  if (!row) {
    res.status(404).json({ error: { message: 'Enabled provider credential not found' } });
    return;
  }

  try {
    const secret = resolveStoredCredential(row);
    if (check === 'health') {
      const valid = await provider.validateKey(secret);
      if (!valid) {
        res.status(422).json({ error: { message: 'Provider health verification failed' } });
        return;
      }
    } else {
      const response = await provider.chatCompletion(
        secret,
        [{ role: 'user', content: 'GloryAPI capability verification ping' }],
        modelId!,
      );
      if (!response.choices?.length) {
        res.status(422).json({ error: { message: 'Provider chat verification returned no choices' } });
        return;
      }
    }
    recordProviderVerification(platform, check);
    res.json({ success: true, check });
  } catch {
    // Provider errors may contain upstream response data; keep them out of the control API.
    res.status(502).json({ error: { message: 'Provider verification failed' } });
  }
});

registryRouter.post('/providers/:platform/activate', (req: Request, res: Response) => {
  const platform = typeof req.params.platform === 'string' ? req.params.platform : '';
  try {
    activateProviderDraft(platform);
    res.json({ success: true, lifecycle: 'active', platform });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Provider activation rejected';
    res.status(409).json({ error: { message } });
  }
});
