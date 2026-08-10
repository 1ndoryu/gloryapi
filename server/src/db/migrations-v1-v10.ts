import Database from 'better-sqlite3';

function ensureFallbackRows(db: Database.Database) {
  const missing = db.prepare(`
    SELECT m.id FROM models m
    LEFT JOIN fallback_config f ON m.id = f.model_db_id
    WHERE f.id IS NULL ORDER BY m.intelligence_rank ASC
  `).all() as { id: number }[];
  if (missing.length === 0) return;
  const maxPriority = (db.prepare('SELECT COALESCE(MAX(priority), 0) AS value FROM fallback_config').get() as { value: number }).value;
  const insert = db.prepare('INSERT INTO fallback_config (model_db_id, priority, enabled) VALUES (?, ?, 1)');
  for (let index = 0; index < missing.length; index++) insert.run(missing[index].id, maxPriority + index + 1);
}

type ModelAddition = readonly [string, string, string, number, number, string, number | null, number | null, number | null, number | null, string, number | null];

function insertModels(db: Database.Database, additions: readonly ModelAddition[]) {
  const insert = db.prepare(`INSERT OR IGNORE INTO models (platform, model_id, display_name, intelligence_rank, speed_rank, size_label, rpm_limit, rpd_limit, tpm_limit, tpd_limit, monthly_token_budget, context_window) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  for (const model of additions) insert.run(...model);
}

export function migrateModels(db: Database.Database) {
  const renameStmt = db.prepare(`
    UPDATE models SET model_id = ?, display_name = ?, intelligence_rank = ?,
      monthly_token_budget = ?, rpd_limit = COALESCE(?, rpd_limit),
      context_window = COALESCE(?, context_window), size_label = COALESCE(?, size_label)
    WHERE platform = ? AND model_id = ?
  `);
  renameStmt.run('deepseek/deepseek-v3.1:free', 'DeepSeek V3.1 (free)', 2, '~6M', 200, 131072, 'Frontier', 'openrouter', 'deepseek/deepseek-r1:free');
  renameStmt.run('openai/gpt-5', 'GPT-5 (GitHub)', 1, '~18M', null, 128000, 'Frontier', 'github', 'gpt-4o');
  db.prepare("UPDATE models SET rpd_limit = 20, monthly_token_budget = '~3M' WHERE platform = 'google' AND model_id = 'gemini-2.5-flash'").run();
  db.prepare("UPDATE models SET rpm_limit = 20 WHERE platform = 'sambanova' AND model_id = 'Meta-Llama-3.3-70B-Instruct'").run();
  db.prepare("UPDATE models SET tpm_limit = 6000 WHERE platform = 'groq' AND model_id = 'llama-4-scout-17b-16e-instruct'").run();
  db.prepare("UPDATE models SET monthly_token_budget = '~1-2M' WHERE platform = 'cohere' AND model_id = 'command-r-plus-08-2024'").run();
  db.prepare("UPDATE models SET monthly_token_budget = '~1-3M' WHERE platform = 'huggingface' AND model_id = 'accounts/fireworks/models/llama-v3p3-70b-instruct'").run();
  db.prepare("UPDATE models SET monthly_token_budget = 'credits-based', enabled = 0 WHERE platform = 'nvidia' AND model_id = 'meta/llama-3.1-70b-instruct'").run();
  insertModels(db, [
    ['cerebras', 'qwen-3-coder-480b', 'Qwen3-Coder 480B', 2, 1, 'Frontier', 30, null, 60000, 1000000, '~30M', 131072],
    ['cerebras', 'llama-4-maverick-17b-128e-instruct', 'Llama 4 Maverick', 3, 1, 'Frontier', 30, null, 60000, 1000000, '~30M', 131072],
    ['cerebras', 'gpt-oss-120b', 'GPT-OSS 120B', 3, 1, 'Large', 30, null, 60000, 1000000, '~30M', 131072],
    ['openrouter', 'deepseek/deepseek-v3.1:free', 'DeepSeek V3.1 (free)', 2, 10, 'Frontier', 20, 200, null, null, '~6M', 131072],
    ['openrouter', 'moonshotai/kimi-k2:free', 'Kimi K2 (free)', 2, 9, 'Frontier', 20, 200, null, null, '~6M', 131072],
    ['openrouter', 'qwen/qwen3-coder:free', 'Qwen3 Coder (free)', 3, 9, 'Frontier', 20, 200, null, null, '~6M', 262144],
    ['openrouter', 'z-ai/glm-4.5-air:free', 'GLM-4.5 Air (free)', 4, 9, 'Large', 20, 200, null, null, '~6M', 131072],
    ['mistral', 'magistral-medium-latest', 'Magistral Medium', 4, 8, 'Large', 2, null, 500000, null, '~50-100M', 40000],
    ['mistral', 'codestral-latest', 'Codestral', 6, 6, 'Medium', 2, null, 500000, null, '~50-100M', 32000],
    ['zhipu', 'glm-4.5-flash', 'GLM-4.5 Flash', 5, 4, 'Large', null, null, null, 1000000, '~30M', 131072],
    ['moonshot', 'kimi-latest', 'Kimi Latest', 4, 8, 'Large', 60, null, null, 500000, '~15M', 200000],
    ['minimax', 'MiniMax-M1', 'MiniMax M1', 5, 8, 'Large', 20, null, 1000000, null, '~30M', 200000],
  ]);
  db.transaction(() => ensureFallbackRows(db))();
}

export function migrateModelsV2(db: Database.Database) {
  const deleteModel = db.prepare('DELETE FROM models WHERE platform = ? AND model_id = ?');
  const deleteFallback = db.prepare('DELETE FROM fallback_config WHERE model_db_id IN (SELECT id FROM models WHERE platform = ? AND model_id = ?)');
  for (const [platform, modelId] of [
    ['cerebras', 'qwen-3-coder-480b'], ['cerebras', 'llama-4-maverick-17b-128e-instruct'],
    ['cerebras', 'gpt-oss-120b'], ['openrouter', 'deepseek/deepseek-v3.1:free'], ['openrouter', 'moonshotai/kimi-k2:free'],
  ] as const) {
    deleteFallback.run(platform, modelId);
    deleteModel.run(platform, modelId);
  }
  db.prepare("UPDATE models SET model_id = 'gpt-4o', display_name = 'GPT-4o', intelligence_rank = 5, size_label = 'Large', context_window = 8000, monthly_token_budget = '~18M' WHERE platform = 'github' AND model_id = 'openai/gpt-5'").run();
  db.prepare("UPDATE models SET model_id = 'meta-llama/llama-4-scout-17b-16e-instruct' WHERE platform = 'groq' AND model_id = 'llama-4-scout-17b-16e-instruct'").run();
  insertModels(db, [
    ['openrouter', 'nvidia/nemotron-3-super-120b-a12b:free', 'Nemotron 3 Super 120B (free)', 2, 9, 'Frontier', 20, 200, null, null, '~6M', 262144],
    ['openrouter', 'qwen/qwen3-next-80b-a3b-instruct:free', 'Qwen3-Next 80B (free)', 3, 9, 'Large', 20, 200, null, null, '~6M', 262144],
    ['openrouter', 'minimax/minimax-m2.5:free', 'MiniMax M2.5 (free)', 3, 9, 'Large', 20, 200, null, null, '~6M', 196608],
    ['openrouter', 'google/gemma-4-31b-it:free', 'Gemma 4 31B (free)', 5, 9, 'Medium', 20, 200, null, null, '~6M', 262144],
  ]);
  db.transaction(() => ensureFallbackRows(db))();
}

export function migrateModelsV3Ranks(db: Database.Database) {
  const setRank = db.prepare('UPDATE models SET intelligence_rank = ? WHERE platform = ? AND model_id = ?');
  const ranks: Array<[number, string, string]> = [
    [1, 'openrouter', 'minimax/minimax-m2.5:free'], [2, 'openrouter', 'qwen/qwen3-coder:free'],
    [3, 'openrouter', 'qwen/qwen3-next-80b-a3b-instruct:free'], [4, 'moonshot', 'kimi-latest'],
    [5, 'cerebras', 'qwen-3-235b-a22b-instruct-2507'], [6, 'google', 'gemini-2.5-pro'],
    [7, 'openrouter', 'z-ai/glm-4.5-air:free'], [8, 'openrouter', 'openai/gpt-oss-120b:free'],
    [9, 'openrouter', 'nvidia/nemotron-3-super-120b-a12b:free'], [10, 'minimax', 'MiniMax-M1'],
    [11, 'mistral', 'codestral-latest'], [12, 'mistral', 'mistral-large-latest'], [13, 'mistral', 'magistral-medium-latest'],
    [14, 'google', 'gemini-2.5-flash'], [15, 'zhipu', 'glm-4.5-flash'], [16, 'groq', 'llama-3.3-70b-versatile'],
    [16, 'sambanova', 'Meta-Llama-3.3-70B-Instruct'], [16, 'openrouter', 'meta-llama/llama-3.3-70b-instruct:free'],
    [16, 'huggingface', 'accounts/fireworks/models/llama-v3p3-70b-instruct'], [17, 'openrouter', 'nousresearch/hermes-3-llama-3.1-405b:free'],
    [18, 'groq', 'meta-llama/llama-4-scout-17b-16e-instruct'], [19, 'openrouter', 'google/gemma-4-31b-it:free'],
    [20, 'google', 'gemini-2.5-flash-lite'], [21, 'github', 'gpt-4o'], [22, 'nvidia', 'meta/llama-3.1-70b-instruct'],
    [22, 'cloudflare', '@cf/meta/llama-3.1-70b-instruct'], [23, 'cohere', 'command-r-plus-08-2024'],
  ];
  db.transaction(() => { for (const rank of ranks) setRank.run(...rank); })();
}

function insertAndEnsure(db: Database.Database, additions: readonly ModelAddition[]) {
  insertModels(db, additions);
  db.transaction(() => ensureFallbackRows(db))();
}

export function migrateModelsV4(db: Database.Database) {
  const deleteModel = db.prepare('DELETE FROM models WHERE platform = ? AND model_id = ?');
  const deleteFallback = db.prepare('DELETE FROM fallback_config WHERE model_db_id IN (SELECT id FROM models WHERE platform = ? AND model_id = ?)');
  for (const target of [
    ['moonshot', 'kimi-latest'], ['minimax', 'MiniMax-M1'],
    ['openrouter', 'google/gemma-4-31b-it:free'], ['huggingface', 'accounts/fireworks/models/llama-v3p3-70b-instruct'],
  ] as const) {
    deleteFallback.run(...target); deleteModel.run(...target);
  }
  db.prepare("UPDATE models SET model_id = '@cf/meta/llama-3.3-70b-instruct-fp8-fast', display_name = 'Llama 3.3 70B fp8-fast (CF)', context_window = 131072 WHERE platform = 'cloudflare' AND model_id = '@cf/meta/llama-3.1-70b-instruct'").run();
  db.prepare("UPDATE models SET tpm_limit = 12000 WHERE platform = 'groq' AND model_id = 'llama-3.3-70b-versatile'").run();
  db.prepare("UPDATE models SET rpd_limit = 20 WHERE platform = 'sambanova' AND model_id = 'Meta-Llama-3.3-70B-Instruct'").run();
  db.prepare("UPDATE models SET rpd_limit = 14400 WHERE platform = 'cerebras' AND model_id = 'qwen-3-235b-a22b-instruct-2507'").run();
  db.prepare("UPDATE models SET rpd_limit = 250, monthly_token_budget = '~25M' WHERE platform = 'google' AND model_id = 'gemini-2.5-flash'").run();
  db.prepare("UPDATE models SET rpd_limit = 50, monthly_token_budget = '~6M' WHERE platform = 'google' AND model_id = 'gemini-2.5-pro'").run();
  insertAndEnsure(db, [
    ['openrouter', 'inclusionai/ling-2.6-flash:free', 'Ling 2.6 Flash (free)', 7, 9, 'Large', 20, 200, null, null, '~6M', 262144],
    ['openrouter', 'arcee-ai/trinity-large-preview:free', 'Trinity Large Preview (free)', 13, 9, 'Frontier', 20, 200, null, null, '~6M', 131072],
    ['openrouter', 'nvidia/nemotron-3-nano-30b-a3b:free', 'Nemotron 3 Nano 30B (free)', 22, 9, 'Medium', 20, 200, null, null, '~6M', 262144],
    ['openrouter', 'openai/gpt-oss-120b:free', 'GPT-OSS 120B (free)', 6, 9, 'Large', 20, 200, null, null, '~6M', 131072],
    ['openrouter', 'openai/gpt-oss-20b:free', 'GPT-OSS 20B (free)', 18, 9, 'Medium', 20, 200, null, null, '~6M', 131072],
    ['openrouter', 'meta-llama/llama-3.3-70b-instruct:free', 'Llama 3.3 70B (free)', 17, 9, 'Medium', 20, 200, null, null, '~6M', 131072],
    ['sambanova', 'DeepSeek-V3.1', 'DeepSeek V3.1', 5, 9, 'Frontier', 20, 20, null, 200000, '~3M', 131072],
    ['sambanova', 'DeepSeek-V3.2', 'DeepSeek V3.2', 4, 9, 'Frontier', 20, 20, null, 200000, '~3M', 131072],
    ['sambanova', 'Llama-4-Maverick-17B-128E-Instruct', 'Llama 4 Maverick', 11, 9, 'Large', 20, 20, null, 200000, '~3M', 8192],
    ['sambanova', 'gpt-oss-120b', 'GPT-OSS 120B (SambaNova)', 6, 9, 'Large', 20, 20, null, 200000, '~3M', 131072],
    ['groq', 'openai/gpt-oss-120b', 'GPT-OSS 120B (Groq)', 6, 2, 'Large', 30, 1000, 8000, 200000, '~6M', 131072],
    ['groq', 'openai/gpt-oss-20b', 'GPT-OSS 20B (Groq)', 18, 2, 'Medium', 30, 1000, 8000, 200000, '~6M', 131072],
    ['groq', 'qwen/qwen3-32b', 'Qwen3 32B (Groq)', 19, 2, 'Medium', 60, 1000, 6000, 500000, '~15M', 131072],
    ['groq', 'llama-3.1-8b-instant', 'Llama 3.1 8B Instant', 28, 2, 'Small', 30, 14400, 6000, 500000, '~15M', 131072],
    ['mistral', 'devstral-latest', 'Devstral', 16, 8, 'Medium', 2, null, 500000, null, '~50-100M', 131072],
    ['mistral', 'mistral-medium-latest', 'Mistral Medium 3.5', 14, 8, 'Large', 2, null, 500000, null, '~50-100M', 131072],
    ['github', 'openai/gpt-4.1', 'GPT-4.1 (GitHub)', 20, 7, 'Large', 10, 50, null, null, '~9M', 128000],
    ['cohere', 'command-a-03-2025', 'Command-A (03-2025)', 27, 11, 'Large', 20, 33, null, null, '~1-2M', 131072],
    ['cloudflare', '@cf/openai/gpt-oss-120b', 'GPT-OSS 120B (CF)', 6, 11, 'Large', null, null, null, null, '~18-45M', 131072],
    ['cloudflare', '@cf/zai-org/glm-4.7-flash', 'GLM-4.7 Flash (CF)', 10, 11, 'Large', null, null, null, null, '~18-45M', 131072],
    ['cloudflare', '@cf/meta/llama-4-scout-17b-16e-instruct', 'Llama 4 Scout (CF)', 12, 11, 'Large', null, null, null, null, '~18-45M', 131072],
  ]);
  const ranks: Array<[number, string, string]> = [
    [1, 'openrouter', 'minimax/minimax-m2.5:free'], [2, 'openrouter', 'qwen/qwen3-coder:free'], [3, 'openrouter', 'qwen/qwen3-next-80b-a3b-instruct:free'], [4, 'sambanova', 'DeepSeek-V3.2'], [5, 'sambanova', 'DeepSeek-V3.1'], [6, 'cerebras', 'qwen-3-235b-a22b-instruct-2507'], [6, 'openrouter', 'openai/gpt-oss-120b:free'], [6, 'groq', 'openai/gpt-oss-120b'], [6, 'sambanova', 'gpt-oss-120b'], [6, 'cloudflare', '@cf/openai/gpt-oss-120b'], [7, 'openrouter', 'inclusionai/ling-2.6-flash:free'], [8, 'openrouter', 'z-ai/glm-4.5-air:free'], [10, 'cloudflare', '@cf/zai-org/glm-4.7-flash'], [11, 'sambanova', 'Llama-4-Maverick-17B-128E-Instruct'], [12, 'groq', 'meta-llama/llama-4-scout-17b-16e-instruct'], [12, 'cloudflare', '@cf/meta/llama-4-scout-17b-16e-instruct'], [13, 'openrouter', 'arcee-ai/trinity-large-preview:free'], [14, 'google', 'gemini-2.5-pro'], [14, 'mistral', 'mistral-large-latest'], [14, 'mistral', 'mistral-medium-latest'], [16, 'mistral', 'devstral-latest'], [16, 'mistral', 'codestral-latest'], [17, 'groq', 'llama-3.3-70b-versatile'], [17, 'sambanova', 'Meta-Llama-3.3-70B-Instruct'], [17, 'cloudflare', '@cf/meta/llama-3.3-70b-instruct-fp8-fast'], [17, 'openrouter', 'meta-llama/llama-3.3-70b-instruct:free'], [17, 'nvidia', 'meta/llama-3.1-70b-instruct'], [18, 'openrouter', 'openai/gpt-oss-20b:free'], [18, 'groq', 'openai/gpt-oss-20b'], [19, 'groq', 'qwen/qwen3-32b'], [20, 'google', 'gemini-2.5-flash'], [20, 'github', 'openai/gpt-4.1'], [21, 'mistral', 'magistral-medium-latest'], [22, 'openrouter', 'nvidia/nemotron-3-super-120b-a12b:free'], [23, 'openrouter', 'nvidia/nemotron-3-nano-30b-a3b:free'], [24, 'zhipu', 'glm-4.5-flash'], [25, 'github', 'gpt-4o'], [26, 'google', 'gemini-2.5-flash-lite'], [27, 'cohere', 'command-a-03-2025'], [27, 'cohere', 'command-r-plus-08-2024'], [28, 'groq', 'llama-3.1-8b-instant'],
  ];
  db.transaction(() => { for (const rank of ranks) db.prepare('UPDATE models SET intelligence_rank = ? WHERE platform = ? AND model_id = ?').run(...rank); })();
}

export function migrateModelsV5(db: Database.Database) {
  db.prepare("UPDATE models SET enabled = 0 WHERE platform = 'google' AND model_id = 'gemini-2.5-pro'").run();
  insertAndEnsure(db, [['cerebras', 'zai-glm-4.7', 'GLM-4.7 (Cerebras)', 7, 1, 'Frontier', 10, 100, null, null, '~3M', 8192]]);
}

export function migrateModelsV6(db: Database.Database) {
  const deleteModel = db.prepare('DELETE FROM models WHERE platform = ? AND model_id = ?');
  const deleteFallback = db.prepare('DELETE FROM fallback_config WHERE model_db_id IN (SELECT id FROM models WHERE platform = ? AND model_id = ?)');
  deleteFallback.run('openrouter', 'arcee-ai/trinity-large-preview:free'); deleteModel.run('openrouter', 'arcee-ai/trinity-large-preview:free');
  db.prepare("UPDATE models SET rpd_limit = 20, monthly_token_budget = '~3M' WHERE platform = 'google' AND model_id = 'gemini-2.5-flash'").run();
  db.prepare("UPDATE models SET rpd_limit = 20, monthly_token_budget = '~3M' WHERE platform = 'google' AND model_id = 'gemini-2.5-flash-lite'").run();
  insertAndEnsure(db, [
    ['cloudflare', '@cf/moonshotai/kimi-k2.5', 'Kimi K2.5 (CF)', 3, 11, 'Frontier', null, null, null, null, '~10-20M', 262144],
    ['cloudflare', '@cf/qwen/qwen3-30b-a3b-fp8', 'Qwen3 30B-A3B fp8 (CF)', 7, 11, 'Large', null, null, null, null, '~18-45M', 131072],
    ['cloudflare', '@cf/deepseek-ai/deepseek-r1-distill-qwen-32b', 'DeepSeek R1 Distill Qwen 32B (CF)', 9, 11, 'Large', null, null, null, null, '~3-5M', 131072],
    ['google', 'gemini-3.1-flash-lite-preview', 'Gemini 3.1 Flash-Lite Preview', 18, 3, 'Medium', 15, 20, 250000, null, '~3M', 1048576],
    ['google', 'gemini-3-flash-preview', 'Gemini 3 Flash Preview', 11, 5, 'Large', 10, 20, 250000, null, '~3M', 1048576],
    ['google', 'gemini-3.1-pro-preview', 'Gemini 3.1 Pro Preview', 1, 8, 'Frontier', 5, 20, 250000, null, '~3M', 1048576],
    ['openrouter', 'google/gemma-4-31b-it:free', 'Gemma 4 31B (free)', 19, 9, 'Medium', 20, 200, null, null, '~6M', 262144],
    ['openrouter', 'liquid/lfm-2.5-1.2b-instruct:free', 'Liquid LFM 2.5 1.2B (free)', 30, 10, 'Small', 20, 200, null, null, '~6M', 32768],
  ]);
}

export function migrateModelsV7(db: Database.Database) {
  const deleteModel = db.prepare('DELETE FROM models WHERE platform = ? AND model_id = ?');
  const deleteFallback = db.prepare('DELETE FROM fallback_config WHERE model_db_id IN (SELECT id FROM models WHERE platform = ? AND model_id = ?)');
  deleteFallback.run('openrouter', 'inclusionai/ling-2.6-flash:free'); deleteModel.run('openrouter', 'inclusionai/ling-2.6-flash:free');
  insertAndEnsure(db, [
    ['openrouter', 'inclusionai/ling-2.6-1t:free', 'Ling 2.6 1T (free)', 4, 9, 'Frontier', 20, 200, null, null, '~6M', 262144],
    ['openrouter', 'tencent/hy3-preview:free', 'Tencent HY3 Preview (free)', 7, 9, 'Frontier', 20, 200, null, null, '~6M', 262144],
    ['openrouter', 'poolside/laguna-m.1:free', 'Poolside Laguna M.1 (free)', 13, 9, 'Large', 20, 200, null, null, '~6M', 131072],
    ['openrouter', 'google/gemma-4-26b-a4b-it:free', 'Gemma 4 26B-A4B (free)', 22, 9, 'Medium', 20, 200, null, null, '~6M', 262144],
    ['openrouter', 'nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free', 'Nemotron 3 Nano 30B Reasoning (free)', 23, 9, 'Medium', 20, 200, null, null, '~6M', 262144],
    ['openrouter', 'poolside/laguna-xs.2:free', 'Poolside Laguna XS.2 (free)', 26, 10, 'Medium', 20, 200, null, null, '~6M', 131072],
    ['openrouter', 'nvidia/nemotron-nano-9b-v2:free', 'Nemotron Nano 9B v2 (free)', 28, 10, 'Medium', 20, 200, null, null, '~6M', 128000],
    ['openrouter', 'liquid/lfm-2.5-1.2b-thinking:free', 'Liquid LFM 2.5 1.2B Thinking (free)', 30, 10, 'Small', 20, 200, null, null, '~6M', 32768],
    ['zhipu', 'glm-4.7-flash', 'GLM-4.7 Flash', 18, 4, 'Large', null, null, null, 1000000, '~30M', 131072],
  ]);
}

export function migrateModelsV8(db: Database.Database) {
  insertAndEnsure(db, [
    ['sambanova', 'DeepSeek-V3.1-cb', 'DeepSeek V3.1 (CB)', 5, 9, 'Frontier', 20, 20, null, 200000, '~3M', 131072],
    ['sambanova', 'gemma-3-12b-it', 'Gemma 3 12B (SambaNova)', 22, 9, 'Medium', 20, 20, null, 200000, '~3M', 131072],
    ['cloudflare', '@cf/moonshotai/kimi-k2.6', 'Kimi K2.6 (CF)', 2, 11, 'Frontier', null, null, null, null, '~10-20M', 262144],
    ['cloudflare', '@cf/ibm-granite/granite-4.0-h-micro', 'Granite 4.0 H Micro (CF)', 29, 11, 'Small', null, null, null, null, '~5-10M', 131072],
  ]);
}

export function migrateModelsV9(db: Database.Database) {
  db.prepare("UPDATE models SET enabled = 0 WHERE platform = 'cerebras' AND model_id = 'zai-glm-4.7'").run();
}

export function migrateModelsV10(db: Database.Database) {
  insertAndEnsure(db, [
    ['ollama', 'qwen3-coder:480b', 'Qwen3-Coder 480B (Ollama)', 2, 9, 'Frontier', null, null, null, null, '~5-10M', 262144],
    ['ollama', 'mistral-large-3:675b', 'Mistral Large 3 675B (Ollama)', 3, 9, 'Frontier', null, null, null, null, '~5-10M', 131072],
    ['ollama', 'deepseek-v3.2', 'DeepSeek V3.2 (Ollama)', 4, 9, 'Frontier', null, null, null, null, '~5-10M', 131072],
    ['ollama', 'cogito-2.1:671b', 'Cogito 2.1 671B (Ollama)', 4, 9, 'Frontier', null, null, null, null, '~5-10M', 131072],
    ['ollama', 'kimi-k2-thinking', 'Kimi K2 Thinking (Ollama)', 5, 9, 'Frontier', null, null, null, null, '~5-10M', 131072],
    ['ollama', 'glm-4.7', 'GLM-4.7 (Ollama)', 6, 9, 'Frontier', null, null, null, null, '~5-10M', 131072],
    ['ollama', 'gpt-oss:120b', 'GPT-OSS 120B (Ollama)', 6, 9, 'Large', null, null, null, null, '~10-20M', 131072],
    ['ollama', 'devstral-2:123b', 'Devstral 2 123B (Ollama)', 8, 10, 'Large', null, null, null, null, '~10-20M', 131072],
    ['ollama', 'gpt-oss:20b', 'GPT-OSS 20B (Ollama)', 18, 10, 'Medium', null, null, null, null, '~20-30M', 131072],
    ['ollama', 'gemma4:31b', 'Gemma 4 31B (Ollama)', 22, 10, 'Medium', null, null, null, null, '~20-30M', 131072],
  ]);
}
