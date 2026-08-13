import { describe, it, expect } from 'vitest'
import { initDb } from '../../db/index.js'

describe('Catalog migration invariants', () => {
  it('V18: curated benchmark metadata annotates Arena Elo and AA coding scores', () => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64)
    const db = initDb(':memory:')
    const rows = db.prepare(`
      SELECT platform, model_id, arena_elo, artificial_analysis_coding_index
        FROM models
       WHERE (platform = 'google' AND model_id IN ('gemini-3.5-flash', 'gemini-3.1-pro-preview', 'gemini-2.5-flash-lite'))
          OR (platform = 'ollama' AND model_id = 'glm-4.7')
          OR (platform = 'github' AND model_id = 'openai/gpt-4.1')
          OR (platform = 'openrouter' AND model_id = 'minimax/minimax-m2.5:free')
       ORDER BY platform, model_id
    `).all() as Array<{
      platform: string
      model_id: string
      arena_elo: number | null
      artificial_analysis_coding_index: number | null
    }>
    const byId = new Map(rows.map(row => [`${row.platform}:${row.model_id}`, row]))

    expect(byId.get('google:gemini-3.1-pro-preview')?.arena_elo).toBe(1525)
    expect(byId.get('google:gemini-3.1-pro-preview')?.artificial_analysis_coding_index).toBeNull()
    expect(byId.get('google:gemini-3.5-flash')?.arena_elo).toBe(1507)
    expect(byId.get('google:gemini-3.5-flash')?.artificial_analysis_coding_index).toBeCloseTo(44.9810606060606, 10)
    expect(byId.get('ollama:glm-4.7')?.arena_elo).toBe(1486)
    expect(byId.get('ollama:glm-4.7')?.artificial_analysis_coding_index).toBeCloseTo(36.2584175084175, 10)
    expect(byId.get('github:openai/gpt-4.1')?.arena_elo).toBe(1456)
    expect(byId.get('github:openai/gpt-4.1')?.artificial_analysis_coding_index).toBeCloseTo(21.783810325477, 10)
    expect(byId.get('openrouter:minimax/minimax-m2.5:free')?.arena_elo).toBe(1448)
    expect(byId.get('openrouter:minimax/minimax-m2.5:free')?.artificial_analysis_coding_index).toBeNull()
    expect(byId.get('google:gemini-2.5-flash-lite')?.arena_elo).toBeNull()
    expect(byId.get('google:gemini-2.5-flash-lite')?.artificial_analysis_coding_index).toBeCloseTo(7.41792929292929, 10)
  })

  it('V19: OpenCode Zen free rows inherit ranking and benchmark aliases', () => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64)
    const db = initDb(':memory:')
    const rows = db.prepare(`
      SELECT platform, model_id, display_name, enabled, intelligence_rank, arena_elo, artificial_analysis_coding_index
        FROM models
       WHERE (platform = 'opencode-zen' AND model_id IN ('deepseek-v4-flash-free', 'minimax-m2.5-free'))
          OR (platform = 'openrouter' AND model_id IN ('deepseek/deepseek-v4-flash:free', 'minimax/minimax-m2.5:free'))
    `).all() as Array<{
      platform: string
      model_id: string
      display_name: string
      enabled: number
      intelligence_rank: number
      arena_elo: number | null
      artificial_analysis_coding_index: number | null
    }>
    const byId = new Map(rows.map(row => [`${row.platform}:${row.model_id}`, row]))

    expect(byId.get('opencode-zen:deepseek-v4-flash-free')?.display_name).toBe('DeepSeek V4 Flash (Zen)')
    expect(byId.get('opencode-zen:deepseek-v4-flash-free')?.enabled).toBe(1)
    expect(byId.get('opencode-zen:deepseek-v4-flash-free')?.intelligence_rank).toBe(byId.get('openrouter:deepseek/deepseek-v4-flash:free')?.intelligence_rank)
    expect(byId.get('opencode-zen:deepseek-v4-flash-free')?.arena_elo).toBe(1481)
    expect(byId.get('opencode-zen:deepseek-v4-flash-free')?.artificial_analysis_coding_index).toBeCloseTo(38.7065095398429, 10)
    expect(byId.get('opencode-zen:minimax-m2.5-free')?.display_name).toBe('MiniMax M2.5 (Zen)')
    expect(byId.get('opencode-zen:minimax-m2.5-free')?.enabled).toBe(1)
    expect(byId.get('opencode-zen:minimax-m2.5-free')?.intelligence_rank).toBe(byId.get('openrouter:minimax/minimax-m2.5:free')?.intelligence_rank)
    expect(byId.get('opencode-zen:minimax-m2.5-free')?.arena_elo).toBe(1448)
    expect(byId.get('opencode-zen:minimax-m2.5-free')?.artificial_analysis_coding_index).toBeNull()
  })

  it('V23: MiniMax M3 is enabled and ranks ahead of M2.5', () => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64)
    const db = initDb(':memory:')
    const rows = db.prepare(`
      SELECT model_id, enabled, intelligence_rank, speed_rank, size_label, monthly_token_budget,
             context_window, arena_elo, artificial_analysis_coding_index
        FROM models
       WHERE platform = 'opencode-zen' AND model_id IN ('minimax-m3-free', 'minimax-m2.5-free')
    `).all() as Array<{
      model_id: string
      enabled: number
      intelligence_rank: number
      speed_rank: number
      size_label: string
      monthly_token_budget: string
      context_window: number | null
      arena_elo: number | null
      artificial_analysis_coding_index: number | null
    }>
    const byId = new Map(rows.map(row => [row.model_id, row]))
    const m3 = byId.get('minimax-m3-free')
    const m25 = byId.get('minimax-m2.5-free')

    expect(m3).toMatchObject({ enabled: 1, size_label: 'Large', monthly_token_budget: '~6M', context_window: 1048576, arena_elo: 1451 })
    expect(m3?.artificial_analysis_coding_index).toBeNull()
    expect(m3?.intelligence_rank).toBeLessThan(m25!.intelligence_rank)
  })

  it('V23: minimax-m3-free has a fallback row ahead of m2.5', () => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64)
    const db = initDb(':memory:')
    const rows = db.prepare(`
      SELECT m.model_id, fc.priority, fc.enabled
        FROM fallback_config fc
        JOIN models m ON m.id = fc.model_db_id
       WHERE m.platform = 'opencode-zen' AND m.model_id IN ('minimax-m3-free', 'minimax-m2.5-free')
    `).all() as Array<{ model_id: string; priority: number; enabled: number }>
    const byId = new Map(rows.map(row => [row.model_id, row]))
    const m3 = byId.get('minimax-m3-free')
    const m25 = byId.get('minimax-m2.5-free')

    expect(m3?.enabled).toBe(1)
    expect(m25?.enabled).toBe(1)
    expect(m3?.priority).toBeLessThan(m25!.priority)
  })

  it('V17: Ollama and HuggingFace preserve frontier model ordering', () => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64)
    const db = initDb(':memory:')
    const rows = db.prepare(`
      SELECT platform, model_id, enabled, intelligence_rank
        FROM models
       WHERE (platform = 'ollama' AND model_id IN ('glm-5.1', 'kimi-k2.6', 'gemini-3-flash-preview', 'glm-5', 'qwen3.5:397b', 'deepseek-v4-flash', 'minimax-m2.7'))
          OR (platform = 'huggingface' AND model_id IN ('zai-org/GLM-5.1', 'google/gemma-4-31B-it', 'google/gemma-4-26B-A4B-it', 'Qwen/Qwen3.5-397B-A17B', 'Qwen/Qwen3-235B-A22B-Instruct-2507', 'MiniMaxAI/MiniMax-M2.7'))
    `).all() as Array<{ platform: string; model_id: string; enabled: number; intelligence_rank: number }>
    expect(rows).toHaveLength(13)
    for (const row of rows) expect(row.enabled).toBe(1)

    const rank = new Map(rows.map(row => [`${row.platform}:${row.model_id}`, row.intelligence_rank]))
    expect(rank.get('huggingface:google/gemma-4-31B-it')).toBeLessThan(rank.get('huggingface:MiniMaxAI/MiniMax-M2.7'))
    expect(rank.get('huggingface:google/gemma-4-26B-A4B-it')).toBeLessThan(rank.get('huggingface:MiniMaxAI/MiniMax-M2.7'))
  })

  it('snapshot ordering keeps Gemini 3.5 Flash ahead across providers', () => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64)
    const db = initDb(':memory:')
    const rows = db.prepare(`
      SELECT platform, model_id, intelligence_rank
        FROM models
       WHERE (platform = 'google' AND model_id IN ('gemini-3.5-flash', 'gemini-3-flash-preview'))
          OR (platform = 'ollama' AND model_id = 'gemini-3-flash-preview')
    `).all() as Array<{ platform: string; model_id: string; intelligence_rank: number }>
    const rank = new Map(rows.map(row => [`${row.platform}:${row.model_id}`, row.intelligence_rank]))

    expect(rank.get('google:gemini-3.5-flash')).toBeLessThan(rank.get('google:gemini-3-flash-preview'))
    expect(rank.get('google:gemini-3.5-flash')).toBeLessThan(rank.get('ollama:gemini-3-flash-preview'))
    expect(rank.get('google:gemini-3-flash-preview')).toBe(rank.get('ollama:gemini-3-flash-preview'))
  })

  it('all enabled catalog platforms have a registered provider', async () => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64)
    const db = initDb(':memory:')
    const { hasProvider } = await import('../../providers/index.js')
    const platforms = (db.prepare('SELECT DISTINCT platform FROM models WHERE enabled = 1').all() as Array<{ platform: string }>).map(row => row.platform)
    expect(platforms.filter(platform => !hasProvider(platform))).toEqual([])
  })
})
