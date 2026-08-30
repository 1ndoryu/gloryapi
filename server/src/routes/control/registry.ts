import { Router } from 'express';
import type { Request, Response } from 'express';
import { z } from 'zod';
import {
  getRegistrySnapshot,
  removeProviderDraft,
  saveProviderDraft,
  getProviderModelDrafts,
  replaceProviderModelDrafts,
  setProviderEnabled,
} from '../../providers/registry.js';
import { activateProviderDraft, recordProviderVerification } from '../../providers/catalog/registry-lifecycle.js';
import { getProviderTemplates } from '../../providers/catalog/templates.js';
import type { CapabilityProfile, Platform, ProviderAdapterKind } from '@gloryapi/shared/types.js';
import { getDb } from '../../db/index.js';
import { getProvider } from '../../providers/index.js';
import { resolveStoredCredential } from '../../lib/dpapi-vault.js';
import { requireAdmin } from '../../lib/admin-auth.js';
import { discoverProviderModelsCached } from '../../providers/catalog/model-discovery.js';
import {
  duplicateSchema,
  modelSelectionSchema,
  providerDraftSchema,
  providerStateSchema,
  verificationSchema,
} from './registrySchema.js';

export const registryRouter = Router();

// Registry reads and mutations can expose provider metadata or trigger
// credential-backed verification. Keep the entire management surface behind
// the same local admin key; the public model/proxy routes remain separate.
registryRouter.use((req: Request, res: Response, next) => {
  if (requireAdmin(req, res)) next();
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

registryRouter.get('/templates', (_req: Request, res: Response) => {
  res.json({ schemaVersion: 'glory-provider-templates-v1', templates: getProviderTemplates() });
});

registryRouter.get('/providers/:platform/models', (req: Request, res: Response) => {
  const platform = typeof req.params.platform === 'string' ? req.params.platform : '';
  res.json({ schemaVersion: 'glory-provider-model-drafts-v1', platform, models: getProviderModelDrafts(platform) });
});

registryRouter.get('/providers/:platform/models/discover', async (req: Request, res: Response) => {
  const platform = typeof req.params.platform === 'string' ? req.params.platform : '';
  const keyId = Number(req.query.keyId);
  if (!Number.isSafeInteger(keyId) || keyId <= 0) {
    res.status(400).json({ error: { message: 'keyId is required for model discovery' } });
    return;
  }
  const provider = getRegistrySnapshot().providers.find(candidate => candidate.platform === platform);
  if (!provider || !provider.endpoint) {
    res.status(404).json({ error: { message: 'Provider endpoint not found' } });
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
    const discovery = await discoverProviderModelsCached(provider.endpoint, secret);
    res.json({ schemaVersion: 'glory-provider-model-discovery-v1', platform, ...discovery, selected: getProviderModelDrafts(platform) });
  } catch {
    res.status(502).json({ error: { message: 'Provider model discovery failed' } });
  }
});

registryRouter.post('/providers/:platform/models/select', (req: Request, res: Response) => {
  const platform = typeof req.params.platform === 'string' ? req.params.platform : '';
  const provider = getRegistrySnapshot().providers.find(candidate => candidate.platform === platform);
  const parsed = modelSelectionSchema.safeParse(req.body);
  if (!provider) {
    res.status(404).json({ error: { message: 'Provider not found' } });
    return;
  }
  if (!parsed.success) {
    res.status(400).json({ error: { message: parsed.error.errors.map(error => error.message).join(', ') } });
    return;
  }
  replaceProviderModelDrafts(platform, parsed.data.models.map(model => ({ ...model, platform })));
  res.status(201).json({ schemaVersion: 'glory-provider-model-drafts-v1', platform, selected: parsed.data.models.length, lifecycle: 'draft' });
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
      platform: draft.platform,
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
      platform: draft.platform,
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

registryRouter.get('/providers/:platform/export', (req: Request, res: Response) => {
  const platform = typeof req.params.platform === 'string' ? req.params.platform : '';
  const provider = getRegistrySnapshot().providers.find(candidate => candidate.platform === platform);
  if (!provider) {
    res.status(404).json({ error: { message: 'Provider not found' } });
    return;
  }
  res.json({ schemaVersion: 'glory-provider-export-v1', provider });
});

registryRouter.post('/providers/:platform/duplicate', (req: Request, res: Response) => {
  const sourcePlatform = typeof req.params.platform === 'string' ? req.params.platform : '';
  const source = getRegistrySnapshot().providers.find(candidate => candidate.platform === sourcePlatform);
  const parsed = duplicateSchema.safeParse(req.body);
  if (!source) {
    res.status(404).json({ error: { message: 'Provider not found' } });
    return;
  }
  if (!parsed.success) {
    res.status(400).json({ error: { message: parsed.error.errors.map(error => error.message).join(', ') } });
    return;
  }
  if (!source.endpoint || !source.endpoint.startsWith('https://')) {
    res.status(409).json({ error: { message: 'Archived provider cannot be duplicated without an endpoint' } });
    return;
  }
  try {
    saveProviderDraft({
      platform: parsed.data.platform,
      displayName: parsed.data.displayName ?? `${source.displayName} copy`,
      adapter: source.adapter,
      endpoint: source.endpoint,
      authScheme: source.authScheme,
      capabilities: source.capabilities,
    });
    res.status(201).json({ success: true, lifecycle: 'draft', platform: parsed.data.platform, credentialCount: 0 });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Provider duplication rejected';
    res.status(409).json({ error: { message } });
  }
});

registryRouter.post('/providers/:platform/verify', async (req: Request, res: Response) => {
  const platform = typeof req.params.platform === 'string' ? req.params.platform : '';
  const parsed = verificationSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: { message: parsed.error.errors.map(error => error.message).join(', ') } });
    return;
  }

  const provider = getProvider(platform as Platform, { allowDraft: true });
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

registryRouter.patch('/providers/:platform/state', (req: Request, res: Response) => {
  const platform = typeof req.params.platform === 'string' ? req.params.platform : '';
  const parsed = providerStateSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: { message: 'Request must contain boolean enabled' } });
    return;
  }
  try {
    setProviderEnabled(platform, parsed.data.enabled);
    res.json({ schemaVersion: 'glory-provider-state-v1', platform, enabled: parsed.data.enabled });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Provider state update rejected';
    res.status(409).json({ error: { message } });
  }
});
