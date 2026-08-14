import { describe, it, expect } from 'vitest'
import Database from 'better-sqlite3'
import { initDb } from '../../db/index.js'
import { createConfigurationModel } from '../../services/configuration-v2.js'

describe('Migration idempotency', () => {
  it('initDb on a fresh database then re-run produces identical row counts', () => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64)
    const tmpPath = `/tmp/freeapi-idempotency-${Date.now()}.db`
    const db1 = initDb(tmpPath)
    const snapshot = {
      models: (db1.prepare('SELECT COUNT(*) AS c FROM models').get() as { c: number }).c,
      fallback: (db1.prepare('SELECT COUNT(*) AS c FROM fallback_config').get() as { c: number }).c,
      enabledModels: (db1.prepare('SELECT COUNT(*) AS c FROM models WHERE enabled = 1').get() as { c: number }).c,
      disabledModels: (db1.prepare('SELECT COUNT(*) AS c FROM models WHERE enabled = 0').get() as { c: number }).c,
      orphanFallbacks: (db1.prepare(`SELECT COUNT(*) AS c FROM fallback_config f LEFT JOIN models m ON f.model_db_id = m.id WHERE m.id IS NULL`).get() as { c: number }).c,
    }
    db1.close()

    const db2 = initDb(tmpPath)
    const repeated = {
      models: (db2.prepare('SELECT COUNT(*) AS c FROM models').get() as { c: number }).c,
      fallback: (db2.prepare('SELECT COUNT(*) AS c FROM fallback_config').get() as { c: number }).c,
      enabledModels: (db2.prepare('SELECT COUNT(*) AS c FROM models WHERE enabled = 1').get() as { c: number }).c,
      disabledModels: (db2.prepare('SELECT COUNT(*) AS c FROM models WHERE enabled = 0').get() as { c: number }).c,
      orphanFallbacks: (db2.prepare(`SELECT COUNT(*) AS c FROM fallback_config f LEFT JOIN models m ON f.model_db_id = m.id WHERE m.id IS NULL`).get() as { c: number }).c,
    }
    db2.close()

    expect(repeated).toEqual(snapshot)
    expect(repeated.orphanFallbacks).toBe(0)
  })

  it('preserves a user-added model across an operational restart', () => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64)
    const tmpPath = `/tmp/freeapi-user-model-${Date.now()}.db`
    const db1 = initDb(tmpPath, { catalogMode: 'operational' })
    db1.prepare(`
      INSERT INTO models (platform, model_id, display_name, intelligence_rank, speed_rank, context_window, enabled)
      VALUES (?, ?, ?, ?, ?, ?, 1)
    `).run('custom-provider', 'custom/model', 'Modelo añadido por el usuario', 50, 50, 150000)
    db1.close()

    const db2 = initDb(tmpPath, { catalogMode: 'operational' })
    expect(db2.prepare('SELECT display_name FROM models WHERE platform = ? AND model_id = ?').get('custom-provider', 'custom/model'))
      .toEqual({ display_name: 'Modelo añadido por el usuario' })
    db2.close()
  })

  it('keeps a CLI-created catalog slug stable across restart and idempotent replay', () => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64)
    const tmpPath = `/tmp/freeapi-cli-model-${Date.now()}.db`
    const input = {
      platform: 'custom-provider',
      modelId: 'custom/model',
      displayName: 'Modelo CLI',
      addToAuto: false,
      expectedRevision: 0,
      idempotencyKey: 'cli-restart-replay',
      actor: 'test',
      source: 'test',
    }
    const db1 = initDb(tmpPath, { catalogMode: 'operational' })
    const first = createConfigurationModel(input)
    const firstSlug = (db1.prepare('SELECT external_slug FROM client_catalog_entries WHERE model_db_id = ?').get(first.models.find(model => model.modelId === input.modelId)?.modelDbId) as { external_slug: string }).external_slug
    db1.close()

    const db2 = initDb(tmpPath, { catalogMode: 'operational' })
    const second = createConfigurationModel(input)
    const secondSlug = (db2.prepare('SELECT external_slug FROM client_catalog_entries WHERE external_slug LIKE ?').get('%custom/model') as { external_slug: string }).external_slug
    expect(second.revision).toBe(first.revision)
    expect(secondSlug).toBe(firstSlug)
    db2.close()
  })

  it('adds request telemetry columns to an existing operational requests table', () => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64)
    const tmpPath = `/tmp/freeapi-request-telemetry-${Date.now()}.db`
    const legacy = new Database(tmpPath)
    legacy.exec(`
      CREATE TABLE requests (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        platform TEXT NOT NULL,
        model_id TEXT NOT NULL,
        status TEXT NOT NULL,
        input_tokens INTEGER NOT NULL DEFAULT 0,
        output_tokens INTEGER NOT NULL DEFAULT 0,
        latency_ms INTEGER NOT NULL DEFAULT 0,
        error TEXT,
        api_key_id INTEGER,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
    `)
    legacy.close()

    const db = initDb(tmpPath, { catalogMode: 'operational' })
    const columns = db.prepare('PRAGMA table_info(requests)').all() as { name: string }[]
    expect(columns.map(column => column.name)).toEqual(expect.arrayContaining([
      'request_kind',
      'parent_request_id',
      'parent_route_id',
      'parent_configuration_revision',
      'parent_selection_reason',
      'cached_input_tokens',
      'cache_write_tokens',
      'reasoning_effort',
      'reasoning_tokens',
      'reasoning_tokens_source',
    ]))
    db.close()
  })

  it('every enabled catalog row has exactly one fallback_config entry', () => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64)
    const db = initDb(':memory:')
    const rows = db.prepare(`
      SELECT m.id, COUNT(f.id) AS fb_count FROM models m
      LEFT JOIN fallback_config f ON m.id = f.model_db_id
      WHERE m.enabled = 1 GROUP BY m.id HAVING COUNT(f.id) <> 1
    `).all()
    expect(rows).toEqual([])
  })

  it('UNIQUE(platform, model_id) constraint holds', () => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64)
    const db = initDb(':memory:')
    const duplicates = db.prepare(`SELECT platform, model_id, COUNT(*) AS c FROM models GROUP BY platform, model_id HAVING COUNT(*) > 1`).all()
    expect(duplicates).toEqual([])
  })

  it('V12 removes dead free rows and keeps the four replacements', () => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64)
    const db = initDb(':memory:')
    const dead = db.prepare(`SELECT model_id FROM models WHERE platform = 'openrouter' AND model_id IN ('inclusionai/ling-2.6-1t:free', 'tencent/hy3-preview:free')`).all()
    expect(dead).toEqual([])
    const live = db.prepare(`SELECT model_id FROM models WHERE platform = 'openrouter' AND model_id IN ('arcee-ai/trinity-large-thinking:free', 'baidu/cobuddy:free', 'openrouter/owl-alpha', 'nousresearch/hermes-3-llama-3.1-405b:free') ORDER BY model_id`).all() as { model_id: string }[]
    expect(live.map(row => row.model_id)).toEqual([
      'arcee-ai/trinity-large-thinking:free',
      'baidu/cobuddy:free',
      'nousresearch/hermes-3-llama-3.1-405b:free',
      'openrouter/owl-alpha',
    ])
    const widened = db.prepare(`SELECT model_id, context_window FROM models WHERE platform = 'openrouter' AND model_id IN ('nvidia/nemotron-3-super-120b-a12b:free', 'qwen/qwen3-coder:free') ORDER BY model_id`).all() as { model_id: string; context_window: number }[]
    expect(widened).toEqual([
      { model_id: 'nvidia/nemotron-3-super-120b-a12b:free', context_window: 1000000 },
      { model_id: 'qwen/qwen3-coder:free', context_window: 1048576 },
    ])
  })

  it('V13 applies the cross-provider catalog refresh', () => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64)
    const db = initDb(':memory:')
    expect((db.prepare(`SELECT enabled FROM models WHERE platform = 'google' AND model_id = 'gemini-3.1-pro-preview'`).get() as { enabled: number }).enabled).toBe(1)
    const disabled = db.prepare(`SELECT platform, model_id, enabled FROM models WHERE platform = 'ollama' AND model_id IN ('kimi-k2-thinking', 'mistral-large-3:675b', 'deepseek-v3.2') ORDER BY platform, model_id`).all() as { enabled: number }[]
    expect(disabled).toHaveLength(3)
    for (const row of disabled) expect(row.enabled).toBe(0)
    expect(db.prepare(`SELECT model_id FROM models WHERE (platform = 'sambanova' AND model_id = 'DeepSeek-V3.1-cb') OR (platform = 'cloudflare' AND model_id = '@cf/moonshotai/kimi-k2.5')`).all()).toEqual([])
    const additions = db.prepare(`SELECT platform, model_id FROM models WHERE (platform, model_id) IN (VALUES ('groq', 'openai/gpt-oss-safeguard-20b'), ('cloudflare', '@cf/nvidia/nemotron-3-120b-a12b'), ('cloudflare', '@cf/google/gemma-4-26b-a4b-it'), ('google', 'gemini-3.5-flash'), ('nvidia', 'deepseek-ai/deepseek-v4-flash'), ('nvidia', 'z-ai/glm-5.1'), ('nvidia', 'qwen/qwen3-coder-480b-a35b-instruct'), ('mistral', 'mistral-small-latest'), ('mistral', 'ministral-8b-latest'), ('cohere', 'command-a-reasoning-08-2025'), ('cohere', 'command-r-08-2024'), ('ollama', 'qwen3-coder-next'), ('huggingface', 'deepseek-ai/DeepSeek-V4-Flash'), ('huggingface', 'moonshotai/Kimi-K2.6'), ('huggingface', 'Qwen/Qwen3-Coder-Next'))`).all()
    expect(additions).toHaveLength(15)
    expect(db.prepare(`SELECT rpm_limit, rpd_limit, tpm_limit, tpd_limit FROM models WHERE platform = 'cerebras' AND model_id = 'qwen-3-235b-a22b-instruct-2507'`).get()).toEqual({ rpm_limit: 5, rpd_limit: 2400, tpm_limit: 30000, tpd_limit: 1000000 })
    expect((db.prepare(`SELECT context_window FROM models WHERE platform = 'sambanova' AND model_id = 'DeepSeek-V3.2'`).get() as { context_window: number }).context_window).toBe(32768)
    expect((db.prepare(`SELECT context_window FROM models WHERE platform = 'cloudflare' AND model_id = '@cf/meta/llama-3.3-70b-instruct-fp8-fast'`).get() as { context_window: number }).context_window).toBe(24000)
    expect(db.prepare(`SELECT model_id, context_window FROM models WHERE platform = 'mistral' AND model_id IN ('codestral-latest', 'devstral-latest', 'magistral-medium-latest', 'mistral-large-latest') ORDER BY model_id`).all()).toEqual([
      { model_id: 'codestral-latest', context_window: 256000 },
      { model_id: 'devstral-latest', context_window: 262144 },
      { model_id: 'magistral-medium-latest', context_window: 131072 },
      { model_id: 'mistral-large-latest', context_window: 262144 },
    ])
  })

  it('V14 disables deprecated Cerebras rows but keeps gpt-oss-120b', () => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64)
    const db = initDb(':memory:')
    const rows = db.prepare(`SELECT model_id, enabled FROM models WHERE platform = 'cerebras' AND model_id IN ('qwen-3-235b-a22b-instruct-2507', 'llama3.1-8b', 'gpt-oss-120b') ORDER BY model_id`).all()
    expect(rows).toEqual([
      { model_id: 'gpt-oss-120b', enabled: 1 },
      { model_id: 'llama3.1-8b', enabled: 0 },
      { model_id: 'qwen-3-235b-a22b-instruct-2507', enabled: 0 },
    ])
  })

  it('V15 keeps the new OpenRouter free routes in fallback', () => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64)
    const db = initDb(':memory:')
    const rows = db.prepare(`SELECT m.model_id, m.display_name, m.intelligence_rank, fc.enabled AS fallback_enabled FROM models m JOIN fallback_config fc ON fc.model_db_id = m.id WHERE m.platform = 'openrouter' AND m.model_id IN ('deepseek/deepseek-v4-flash:free', 'cognitivecomputations/dolphin-mistral-24b-venice-edition:free', 'meta-llama/llama-3.2-3b-instruct:free') ORDER BY m.intelligence_rank ASC`).all() as { model_id: string; display_name: string; intelligence_rank: number; fallback_enabled: number }[]
    expect(rows).toHaveLength(3)
    for (const row of rows) expect(row.fallback_enabled).toBe(1)
    const byId = new Map(rows.map(row => [row.model_id, row]))
    expect(byId.get('deepseek/deepseek-v4-flash:free')?.display_name).toBe('DeepSeek V4 Flash (free)')
    expect(byId.get('cognitivecomputations/dolphin-mistral-24b-venice-edition:free')?.display_name).toBe('Dolphin Mistral 24B Venice (free)')
    expect(byId.get('meta-llama/llama-3.2-3b-instruct:free')?.display_name).toBe('Llama 3.2 3B Instruct (free)')
    expect(byId.get('deepseek/deepseek-v4-flash:free')?.intelligence_rank).toBeLessThan(byId.get('meta-llama/llama-3.2-3b-instruct:free')?.intelligence_rank ?? Number.MAX_SAFE_INTEGER)
    expect(byId.get('meta-llama/llama-3.2-3b-instruct:free')?.intelligence_rank).toBeLessThan(byId.get('cognitivecomputations/dolphin-mistral-24b-venice-edition:free')?.intelligence_rank ?? Number.MAX_SAFE_INTEGER)
  })

  it('V16 preserves Qwen family ordering', () => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64)
    const db = initDb(':memory:')
    const rows = db.prepare(`SELECT platform, model_id, intelligence_rank FROM models WHERE (platform = 'nvidia' AND model_id IN ('deepseek-ai/deepseek-v4-flash', 'qwen/qwen3-coder-480b-a35b-instruct')) OR (platform = 'cerebras' AND model_id = 'qwen-3-235b-a22b-instruct-2507') OR (platform = 'google' AND model_id = 'gemma-4-31b-it') OR (platform = 'openrouter' AND model_id IN ('google/gemma-4-31b-it:free', 'qwen/qwen3-next-80b-a3b-instruct:free'))`).all() as { platform: string; model_id: string; intelligence_rank: number }[]
    const rank = new Map(rows.map(row => [`${row.platform}:${row.model_id}`, row.intelligence_rank]))
    expect(rank.get('cerebras:qwen-3-235b-a22b-instruct-2507')).toBeLessThan(rank.get('nvidia:qwen/qwen3-coder-480b-a35b-instruct'))
    expect(rank.get('google:gemma-4-31b-it')).toBe(rank.get('openrouter:google/gemma-4-31b-it:free'))
    expect(rank.get('google:gemma-4-31b-it')).toBeLessThan(rank.get('nvidia:deepseek-ai/deepseek-v4-flash'))
    expect(rank.get('nvidia:qwen/qwen3-coder-480b-a35b-instruct')).toBeLessThan(rank.get('openrouter:qwen/qwen3-next-80b-a3b-instruct:free'))
  })
})
