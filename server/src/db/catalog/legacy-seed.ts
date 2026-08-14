import Database from 'better-sqlite3';

export function seedLegacyModels(db: Database.Database, options: { quiet?: boolean } = {}): void {
  const count = db.prepare('SELECT COUNT(*) as cnt FROM models').get() as { cnt: number };
  if (count.cnt > 0) return;

  const insert = db.prepare(`
    INSERT INTO models (platform, model_id, display_name, intelligence_rank, speed_rank, size_label, rpm_limit, rpd_limit, tpm_limit, tpd_limit, monthly_token_budget, context_window)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const models = [
    ['google', 'gemini-2.5-pro', 'Gemini 2.5 Pro', 1, 8, 'Frontier', 5, 100, 250000, null, '~12M', 1048576],
    ['google', 'gemini-2.5-flash', 'Gemini 2.5 Flash', 4, 5, 'Large', 10, 20, 250000, null, '~3M', 1048576],
    ['google', 'gemini-2.5-flash-lite', 'Gemini 2.5 Flash-Lite', 8, 3, 'Medium', 15, 1000, 250000, null, '~120M', 1048576],
    ['openrouter', 'deepseek/deepseek-v3.1:free', 'DeepSeek V3.1 (free)', 2, 10, 'Frontier', 20, 200, null, null, '~6M', 131072],
    ['openrouter', 'moonshotai/kimi-k2:free', 'Kimi K2 (free)', 2, 9, 'Frontier', 20, 200, null, null, '~6M', 131072],
    ['openrouter', 'qwen/qwen3-coder:free', 'Qwen3 Coder (free)', 3, 9, 'Frontier', 20, 200, null, null, '~6M', 262144],
    ['openrouter', 'z-ai/glm-4.5-air:free', 'GLM-4.5 Air (free)', 4, 9, 'Large', 20, 200, null, null, '~6M', 131072],
    ['cerebras', 'qwen-3-coder-480b', 'Qwen3-Coder 480B', 2, 1, 'Frontier', 30, null, 60000, 1000000, '~30M', 131072],
    ['cerebras', 'llama-4-maverick-17b-128e-instruct', 'Llama 4 Maverick', 3, 1, 'Frontier', 30, null, 60000, 1000000, '~30M', 131072],
    ['cerebras', 'qwen3-235b', 'Qwen3 235B', 3, 1, 'Large', 30, null, 60000, 1000000, '~30M', 8192],
    ['cerebras', 'gpt-oss-120b', 'GPT-OSS 120B', 3, 1, 'Large', 30, null, 60000, 1000000, '~30M', 131072],
    ['github', 'openai/gpt-5', 'GPT-5 (GitHub)', 1, 7, 'Frontier', 10, 50, null, null, '~18M', 128000],
    ['sambanova', 'Meta-Llama-3.3-70B-Instruct', 'Llama 3.3 70B', 6, 9, 'Large', 20, null, null, 200000, '~6M', 8192],
    ['mistral', 'mistral-large-latest', 'Mistral Large 3', 7, 8, 'Large', 2, null, 500000, null, '~50-100M', 131072],
    ['mistral', 'magistral-medium-latest', 'Magistral Medium', 4, 8, 'Large', 2, null, 500000, null, '~50-100M', 40000],
    ['mistral', 'codestral-latest', 'Codestral', 6, 6, 'Medium', 2, null, 500000, null, '~50-100M', 32000],
    ['groq', 'llama-3.3-70b-versatile', 'Llama 3.3 70B', 9, 2, 'Medium', 30, 1000, 6000, 500000, '~15M', 131072],
    ['groq', 'llama-4-scout-17b-16e-instruct', 'Llama 4 Scout', 10, 2, 'Medium', 30, 1000, 6000, 1000000, '~30M', 131072],
    ['nvidia', 'meta/llama-3.1-70b-instruct', 'Llama 3.1 70B (NV)', 11, 6, 'Large', 40, null, null, null, 'credits-based', 131072],
    ['cohere', 'command-r-plus-08-2024', 'Command R+ (08-2024)', 12, 11, 'Large', 20, 33, null, null, '~1-2M', 131072],
    ['cloudflare', '@cf/meta/llama-3.1-70b-instruct', 'Llama 3.1 70B (CF)', 13, 11, 'Medium', null, null, null, null, '~18-45M', 131072],
    ['huggingface', 'accounts/fireworks/models/llama-v3p3-70b-instruct', 'Llama 3.3 70B (HF)', 14, 11, 'Medium', null, null, null, null, '~1-3M', 131072],
    ['zhipu', 'glm-4.5-flash', 'GLM-4.5 Flash', 5, 4, 'Large', null, null, null, 1000000, '~30M', 131072],
    ['moonshot', 'kimi-latest', 'Kimi Latest', 4, 8, 'Large', 60, null, null, 500000, '~15M', 200000],
    ['minimax', 'MiniMax-M1', 'MiniMax M1', 5, 8, 'Large', 20, null, 1000000, null, '~30M', 200000],
  ];

  db.transaction(() => {
    for (const model of models) insert.run(...model);
  })();

  const allModels = db.prepare('SELECT id FROM models ORDER BY intelligence_rank ASC').all() as { id: number }[];
  const insertFallback = db.prepare('INSERT INTO fallback_config (model_db_id, priority, enabled) VALUES (?, ?, 1)');
  db.transaction(() => {
    for (let index = 0; index < allModels.length; index++) insertFallback.run(allModels[index].id, index + 1);
  })();
  if (!options.quiet) console.log(`Seeded ${models.length} models and fallback config`);
}
