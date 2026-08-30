import { getDb } from '../../db/index.js';
import { getConfiguredProviderFromDb } from '../../services/provider-configuration.js';
import { createConfigurationProvider, updateConfigurationProvider } from '../../services/configuration-v2.js';
import {
  type CapabilityProfile,
  type ProviderAdapterKind,
} from '@gloryapi/shared/types.js';

import {
  ACTIVE_PROVIDER_PLATFORMS,
} from './provider-definitions.js';

// Implementación de la operación del registro (drafts, estado, snapshots). El
// módulo de entrada registry.ts es un barrel puro que re-exporta desde aquí,
// provider-definitions.ts y registry-snapshot.ts; mantener este archivo sin
// re-exports evita la regla mixed-barrel-logic-*.

export interface ProviderDraftInput {
  /** Draft slugs may be new; activation still requires a registered adapter. */
  platform: string;
  displayName: string;
  adapter: ProviderAdapterKind;
  endpoint: string;
  authScheme: 'bearer' | 'account-and-token';
  capabilities: CapabilityProfile;
}

export interface ProviderModelDraftInput {
  platform: string;
  modelId: string;
  displayName: string;
  contextWindow: number | null;
  capabilities: CapabilityProfile;
}

export function replaceProviderModelDrafts(platform: string, models: ProviderModelDraftInput[]): void {
  const db = getDb();
  db.transaction(() => {
    db.prepare('DELETE FROM provider_model_drafts WHERE platform = ?').run(platform);
    const insert = db.prepare(`
      INSERT INTO provider_model_drafts (platform, model_id, display_name, context_window, capabilities_json)
      VALUES (?, ?, ?, ?, ?)
    `);
    for (const model of models) {
      insert.run(model.platform, model.modelId, model.displayName, model.contextWindow, JSON.stringify(model.capabilities));
    }
  })();
}

export function getProviderModelDrafts(platform: string): Array<Omit<ProviderModelDraftInput, 'platform'>> {
  const rows = getDb().prepare(`
    SELECT model_id, display_name, context_window, capabilities_json
    FROM provider_model_drafts WHERE platform = ? ORDER BY display_name, model_id
  `).all(platform) as Array<{ model_id: string; display_name: string; context_window: number | null; capabilities_json: string }>;
  return rows.map(row => ({
    modelId: row.model_id,
    displayName: row.display_name,
    contextWindow: row.context_window,
    capabilities: JSON.parse(row.capabilities_json) as CapabilityProfile,
  }));
}

export function isActiveProviderPlatform(platform: string): boolean {
  try {
    const configured = getConfiguredProviderFromDb(getDb(), platform);
    if (configured) return configured.lifecycle === 'active';
  } catch {
    // Continue with the compiled bootstrap registry for isolated legacy tests.
  }
  return (ACTIVE_PROVIDER_PLATFORMS as readonly string[]).includes(platform);
}

export function saveProviderDraft(input: ProviderDraftInput): void {
  const db = getDb();
  const configured = input.adapter === 'openai-compatible' ? getConfiguredProviderFromDb(db, input.platform) : undefined;
  if (configured?.lifecycle === 'active') throw new Error('Active provider definitions cannot be replaced by a draft');
  if (configured) {
    updateConfigurationProvider(input.platform, {
      displayName: input.displayName,
      lifecycle: 'draft',
      enabled: false,
      endpoint: input.endpoint,
      capabilities: input.capabilities,
      actor: 'registry-api',
      source: 'provider-draft',
    });
  } else if (input.adapter === 'openai-compatible') {
    createConfigurationProvider({
      platform: input.platform,
      displayName: input.displayName,
      endpoint: input.endpoint,
      adapter: 'openai-compatible',
      authScheme: 'bearer',
      capabilities: input.capabilities,
      lifecycle: 'draft',
      enabled: false,
      actor: 'registry-api',
      source: 'provider-draft',
    });
  }
  const existing = db.prepare('SELECT lifecycle FROM provider_registry WHERE platform = ?').get(input.platform) as { lifecycle: string } | undefined;
  if (existing?.lifecycle === 'active') throw new Error('Active provider definitions cannot be replaced by a draft');
  db.prepare(`
    INSERT INTO provider_registry (
      platform, display_name, lifecycle, adapter, endpoint, auth_scheme, capabilities_json,
      health_verified_at, chat_verified_at, capabilities_verified_at, updated_at
    ) VALUES (?, ?, 'draft', ?, ?, ?, ?, NULL, NULL, NULL, datetime('now'))
    ON CONFLICT(platform) DO UPDATE SET
      display_name = excluded.display_name,
      lifecycle = 'draft',
      adapter = excluded.adapter,
      endpoint = excluded.endpoint,
      auth_scheme = excluded.auth_scheme,
      capabilities_json = excluded.capabilities_json,
      health_verified_at = NULL,
      chat_verified_at = NULL,
      capabilities_verified_at = NULL,
      updated_at = datetime('now')
  `).run(
    input.platform,
    input.displayName,
    input.adapter,
    input.endpoint,
    input.authScheme,
    JSON.stringify(input.capabilities),
  );
  db.prepare(`
    INSERT INTO provider_runtime_state (platform, enabled, updated_at) VALUES (?, 0, datetime('now'))
    ON CONFLICT(platform) DO UPDATE SET enabled = 0, updated_at = datetime('now')
  `).run(input.platform);
}

export function setProviderEnabled(platform: string, enabled: boolean): void {
  if (!isActiveProviderPlatform(platform)) throw new Error('Only an active provider can be toggled');
  const db = getDb();
  const configured = getConfiguredProviderFromDb(db, platform);
  if (configured) {
    // Keep the old control endpoint useful while routing all durable state
    // through the revisioned configuration service.
    updateConfigurationProvider(platform, {
      enabled,
      actor: 'registry-api',
      source: 'provider-state',
    });
    return;
  }
  db.transaction(() => {
    db.prepare(`
      INSERT INTO provider_runtime_state (platform, enabled, updated_at) VALUES (?, ?, datetime('now'))
      ON CONFLICT(platform) DO UPDATE SET enabled = excluded.enabled, updated_at = datetime('now')
    `).run(platform, enabled ? 1 : 0);
    db.prepare(`UPDATE fallback_config SET enabled = ? WHERE model_db_id IN (SELECT id FROM models WHERE platform = ?)`)
      .run(enabled ? 1 : 0, platform);
  })();
}

export function removeProviderDraft(platform: string): boolean {
  const configured = getConfiguredProviderFromDb(getDb(), platform);
  if (configured?.lifecycle === 'draft') {
    updateConfigurationProvider(platform, { lifecycle: 'archived', enabled: false, actor: 'registry-api', source: 'provider-delete' });
  }
  const result = getDb().prepare("DELETE FROM provider_registry WHERE platform = ? AND lifecycle = 'draft'").run(platform);
  return result.changes > 0 || configured?.lifecycle === 'draft';
}