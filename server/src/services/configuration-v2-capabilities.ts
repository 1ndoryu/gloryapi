import type Database from 'better-sqlite3';

const MODEL_CAPABILITY_DEFAULTS_REVISION = 'configuration_model_capabilities_v2';

/**
 * One-time metadata migration for models already present before V2. New models
 * receive these flags from the configuration API; they must not be inferred
 * from the provider-wide capability profile.
 */
const KNOWN_MODEL_CAPABILITY_DEFAULTS = [
  { platform: 'commandcode', modelId: 'deepseek/deepseek-v4-flash', nativeVision: false, supportsReasoning: true },
  { platform: 'commandcode', modelId: 'meta/muse-spark-1.2-contributor', nativeVision: true, supportsReasoning: true },
] as const;

export function ensureKnownModelCapabilityDefaults(db: Database.Database): void {
  const applied = db.prepare('SELECT 1 FROM settings WHERE key = ?').get(MODEL_CAPABILITY_DEFAULTS_REVISION);
  if (applied) return;

  db.transaction(() => {
    const update = db.prepare(`
      UPDATE models
      SET native_vision = ?, supports_reasoning = ?, capabilities_explicit = 1
      WHERE platform = ? AND model_id = ?
    `);
    for (const model of KNOWN_MODEL_CAPABILITY_DEFAULTS) {
      update.run(model.nativeVision ? 1 : 0, model.supportsReasoning ? 1 : 0, model.platform, model.modelId);
    }
    db.prepare('INSERT INTO settings (key, value) VALUES (?, ?)').run(MODEL_CAPABILITY_DEFAULTS_REVISION, 'applied');
  })();
}
