import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { getDb, initDb } from '../../db/index.js'
import { normalizeGloryCatalog } from '../../db/catalog/normalize.js'

describe('clean GloryAPI catalog', () => {
  it('keeps exactly the operational target models in persisted order', () => {
    initDb(':memory:', { catalogMode: 'operational' })
    const db = getDb()
    normalizeGloryCatalog(db)

    expect(db.prepare('SELECT COUNT(*) AS count FROM models').get()).toEqual({ count: 6 })
    expect(db.prepare(`
      SELECT m.platform, m.model_id, m.display_name, fc.priority
      FROM models m JOIN fallback_config fc ON fc.model_db_id = m.id
      ORDER BY fc.priority
    `).all()).toEqual([
      {
        platform: 'andoryyu',
        model_id: 'deepseek-v4-flash',
        display_name: 'DeepSeek V4 Flash (Andoryyu)',
        priority: 1,
      },
      {
        platform: 'opencode-zen',
        model_id: 'deepseek-v4-flash-free',
        display_name: 'DeepSeek V4 Flash (Zen)',
        priority: 2,
      },
      {
        platform: 'tokenharbor',
        model_id: 'deepseek-v4-flash:free',
        display_name: 'DeepSeek V4 Flash (TokenHarbor Free)',
        priority: 3,
      },
      {
        platform: 'opencode-go',
        model_id: 'deepseek-v4-flash',
        display_name: 'DeepSeek V4 Flash (Go)',
        priority: 4,
      },
    ])
  })

  it('preserves disabled routing preferences when the catalog is normalized again', () => {
    initDb(':memory:')
    const db = getDb()
    normalizeGloryCatalog(db)

    const tokenHarbor = db.prepare(`
      SELECT id FROM models
       WHERE platform = 'tokenharbor' AND model_id = 'deepseek-v4-flash:free'
    `).get() as { id: number }
    db.prepare('UPDATE models SET enabled = 0 WHERE id = ?').run(tokenHarbor.id)
    db.prepare('UPDATE fallback_config SET enabled = 0, priority = 9 WHERE model_db_id = ?').run(tokenHarbor.id)

    normalizeGloryCatalog(db)

    expect(db.prepare('SELECT enabled FROM models WHERE id = ?').get(tokenHarbor.id)).toEqual({ enabled: 0 })
    expect(db.prepare('SELECT enabled, priority FROM fallback_config WHERE model_db_id = ?').get(tokenHarbor.id)).toEqual({
      enabled: 0,
      priority: 9,
    })
  })

  it('does not rerun historical catalog migrations on an operational database restart', () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'gloryapi-catalog-restart-'))
    const dbPath = join(tempDir, 'catalog.db')
    try {
      initDb(dbPath, { catalogMode: 'operational' })
      let db = getDb()
      const tokenHarbor = db.prepare(`
        SELECT id FROM models
         WHERE platform = 'tokenharbor' AND model_id = 'deepseek-v4-flash:free'
      `).get() as { id: number }
      db.prepare('UPDATE models SET enabled = 0 WHERE id = ?').run(tokenHarbor.id)
      db.prepare('UPDATE fallback_config SET enabled = 0, priority = 9 WHERE model_db_id = ?').run(tokenHarbor.id)
      db.close()

      initDb(dbPath)
      db = getDb()

      expect(db.prepare('SELECT enabled FROM models WHERE id = ?').get(tokenHarbor.id)).toEqual({ enabled: 0 })
      expect(db.prepare('SELECT enabled, priority FROM fallback_config WHERE model_db_id = ?').get(tokenHarbor.id)).toEqual({
        enabled: 0,
        priority: 9,
      })
    } finally {
      getDb().close()
      rmSync(tempDir, { recursive: true, force: true })
    }
  })

  it('keeps CommandCode models explicit-only (never in the auto fallback chain)', () => {
    initDb(':memory:', { catalogMode: 'operational' })
    const db = getDb()
    normalizeGloryCatalog(db)

    const commandCodeModels = db.prepare(`
      SELECT model_id, display_name
        FROM models
       WHERE platform = 'commandcode'
       ORDER BY intelligence_rank ASC
    `).all()
    expect(commandCodeModels).toEqual([
      { model_id: 'deepseek/deepseek-v4-flash', display_name: 'DeepSeek V4 Flash (CommandCode)' },
      { model_id: 'meta/muse-spark-1.2-contributor', display_name: 'Muse Spark 1.2 Contributor (CommandCode)' },
    ])
    const inFallback = db.prepare(`
      SELECT COUNT(*) AS count
        FROM fallback_config fc JOIN models m ON m.id = fc.model_db_id
       WHERE m.platform = 'commandcode'
    `).get()
    expect(inFallback).toEqual({ count: 0 })
  })

  it('starts a fresh operational database without the legacy catalog migrations', () => {
    initDb(':memory:', { catalogMode: 'operational' })
    const db = getDb()

    expect(db.prepare('SELECT COUNT(*) AS count FROM models').get()).toEqual({ count: 6 })
    expect(db.prepare('SELECT COUNT(*) AS count FROM fallback_config').get()).toEqual({ count: 4 })
    expect(db.prepare("SELECT value FROM settings WHERE key = 'catalog_schema_version'").get()).toEqual({ value: 'glory-v1' })
    expect(db.prepare("SELECT name FROM pragma_table_info('models') WHERE name = 'monthly_token_budget'").get()).toBeUndefined()
    expect(db.prepare("SELECT name FROM pragma_table_info('requests') WHERE name = 'api_key_id'").get()).toEqual({ name: 'api_key_id' })
  })

  it('is idempotent, removes legacy rows, and preserves the vault', () => {
    const db = getDb()
    db.prepare(`
      INSERT INTO models (platform, model_id, display_name, intelligence_rank, speed_rank, size_label)
      VALUES ('legacy-provider', 'legacy-model', 'Legacy model', 99, 99, 'Legacy')
    `).run()
    db.prepare(`
      INSERT INTO api_keys (platform, label, encrypted_key, iv, auth_tag, encryption_scheme, fingerprint)
      VALUES ('legacy-provider', 'archived credential', 'ciphertext', 'iv', 'tag', 'dpapi-current-user', 'fingerprint')
    `).run()

    normalizeGloryCatalog(db)
    normalizeGloryCatalog(db)

    expect(db.prepare('SELECT COUNT(*) AS count FROM models').get()).toEqual({ count: 6 })
    expect(db.prepare('SELECT COUNT(*) AS count FROM fallback_config').get()).toEqual({ count: 4 })
    expect(db.prepare("SELECT COUNT(*) AS count FROM models WHERE platform = 'legacy-provider'").get()).toEqual({ count: 0 })
    expect(db.prepare('SELECT platform, label, fingerprint FROM api_keys').all()).toEqual([
      { platform: 'legacy-provider', label: 'archived credential', fingerprint: 'fingerprint' },
    ])
    expect(db.prepare("SELECT value FROM settings WHERE key = 'catalog_schema_version'").get()).toEqual({ value: 'glory-v1' })
  })
})
