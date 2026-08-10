import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { initDb, getDb } from '../../db/index.js';
import { encrypt } from '../../lib/crypto.js';
import { routeRequest } from '../../services/router.js';

describe('Router', () => {
  beforeAll(() => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    initDb(':memory:');
  });

  beforeEach(() => {
    const db = getDb();
    db.prepare('DELETE FROM api_keys').run();
    // Reset fallback order to intelligence ranking
    const models = db.prepare('SELECT id, intelligence_rank FROM models ORDER BY intelligence_rank ASC').all() as Array<{ id: number; intelligence_rank: number }>;
    const update = db.prepare('UPDATE fallback_config SET priority = ? WHERE model_db_id = ?');
    for (let i = 0; i < models.length; i++) {
      update.run(i + 1, models[i].id);
    }
  });

  it('should throw when no keys are configured', () => {
    expect(() => routeRequest()).toThrow(/exhausted/i);
  });

  it('should route to highest priority model with available key', () => {
    const db = getDb();
    const { encrypted, iv, authTag } = encrypt('test-groq-key');
    db.prepare(`
      INSERT INTO api_keys (platform, label, encrypted_key, iv, auth_tag, status, enabled)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run('groq', 'test', encrypted, iv, authTag, 'healthy', 1);

    const result = routeRequest();
    expect(result.platform).toBe('groq');
    expect(result.apiKey).toBe('test-groq-key');
  });

  it('should prefer higher-priority model when keys exist for multiple platforms', () => {
    const db = getDb();

    const googleKey = encrypt('test-google-key');
    db.prepare(`
      INSERT INTO api_keys (platform, label, encrypted_key, iv, auth_tag, status, enabled)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run('google', 'test', googleKey.encrypted, googleKey.iv, googleKey.authTag, 'healthy', 1);

    const groqKey = encrypt('test-groq-key');
    db.prepare(`
      INSERT INTO api_keys (platform, label, encrypted_key, iv, auth_tag, status, enabled)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run('groq', 'test', groqKey.encrypted, groqKey.iv, groqKey.authTag, 'healthy', 1);

    // Post-V6: Google's gemini-3.1-pro-preview (rank 1, free-tier-eligible per
    // probe on 2026-04-25) outranks Groq's best free-tier model openai/gpt-oss-120b
    // (rank 6). With keys for both platforms, Google wins.
    const result = routeRequest();
    expect(result.platform).toBe('google');
  });

  it('should skip disabled keys', () => {
    const db = getDb();

    const googleKey = encrypt('test-google-key');
    db.prepare(`
      INSERT INTO api_keys (platform, label, encrypted_key, iv, auth_tag, status, enabled)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run('google', 'disabled', googleKey.encrypted, googleKey.iv, googleKey.authTag, 'healthy', 0);

    const groqKey = encrypt('test-groq-key');
    db.prepare(`
      INSERT INTO api_keys (platform, label, encrypted_key, iv, auth_tag, status, enabled)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run('groq', 'test', groqKey.encrypted, groqKey.iv, groqKey.authTag, 'healthy', 1);

    const result = routeRequest();
    expect(result.platform).toBe('groq');
  });

  it('should skip invalid keys', () => {
    const db = getDb();

    const invalidKey = encrypt('invalid-key');
    db.prepare(`
      INSERT INTO api_keys (platform, label, encrypted_key, iv, auth_tag, status, enabled)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run('google', 'invalid', invalidKey.encrypted, invalidKey.iv, invalidKey.authTag, 'invalid', 1);

    const groqKey = encrypt('test-groq-key');
    db.prepare(`
      INSERT INTO api_keys (platform, label, encrypted_key, iv, auth_tag, status, enabled)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run('groq', 'test', groqKey.encrypted, groqKey.iv, groqKey.authTag, 'healthy', 1);

    const result = routeRequest();
    expect(result.platform).toBe('groq');
  });

  it('should allow explicitly requested models even if their fallback row is disabled', () => {
    const db = getDb();

    const openrouterKey = encrypt('test-openrouter-key');
    db.prepare(`
      INSERT INTO api_keys (platform, label, encrypted_key, iv, auth_tag, status, enabled)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run('openrouter', 'test', openrouterKey.encrypted, openrouterKey.iv, openrouterKey.authTag, 'healthy', 1);

    const explicitModel = db.prepare(`
      SELECT m.id
        FROM models m
       WHERE m.platform = 'openrouter'
         AND m.model_id = 'qwen/qwen3-coder:free'
    `).get() as { id: number };

    db.prepare('UPDATE fallback_config SET enabled = 0 WHERE model_db_id = ?').run(explicitModel.id);

    const autoResult = routeRequest();
    expect(autoResult.modelId).not.toBe('qwen/qwen3-coder:free');

    const explicitResult = routeRequest(1000, undefined, explicitModel.id);
    expect(explicitResult.platform).toBe('openrouter');
    expect(explicitResult.modelId).toBe('qwen/qwen3-coder:free');
    expect(explicitResult.apiKey).toBe('test-openrouter-key');
  });

  it('should quarantine unstable auto-fallback rows but keep them addressable explicitly', () => {
    const db = getDb();

    const quarantinedRows = db.prepare(`
      SELECT m.platform, m.model_id, f.enabled
        FROM models m
        JOIN fallback_config f ON f.model_db_id = m.id
       WHERE (m.platform = 'ollama' AND m.model_id IN ('glm-5.1', 'kimi-k2.6'))
          OR (m.platform = 'nvidia' AND m.model_id = 'moonshotai/kimi-k2.6')
       ORDER BY m.platform, m.model_id
    `).all() as Array<{ platform: string; model_id: string; enabled: number }>;

    expect(quarantinedRows).toEqual([
      { platform: 'nvidia', model_id: 'moonshotai/kimi-k2.6', enabled: 0 },
      { platform: 'ollama', model_id: 'glm-5.1', enabled: 0 },
      { platform: 'ollama', model_id: 'kimi-k2.6', enabled: 0 },
    ]);

    const nvidiaKey = encrypt('test-nvidia-key');
    db.prepare(`
      INSERT INTO api_keys (platform, label, encrypted_key, iv, auth_tag, status, enabled)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run('nvidia', 'test', nvidiaKey.encrypted, nvidiaKey.iv, nvidiaKey.authTag, 'healthy', 1);

    const explicitModel = db.prepare(`
      SELECT m.id
        FROM models m
       WHERE m.platform = 'nvidia'
         AND m.model_id = 'moonshotai/kimi-k2.6'
    `).get() as { id: number };

    const explicitResult = routeRequest(1000, undefined, explicitModel.id);
    expect(explicitResult.platform).toBe('nvidia');
    expect(explicitResult.modelId).toBe('moonshotai/kimi-k2.6');
    expect(explicitResult.apiKey).toBe('test-nvidia-key');
  });
});
