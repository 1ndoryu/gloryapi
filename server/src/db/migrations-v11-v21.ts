import Database from 'better-sqlite3';
import {
  ensureModelBenchmarkColumns,
  reapplyLatestBenchmarkSnapshot,
  reapplyLatestRankingSnapshot,
} from './migration-snapshots.js';

type ModelAddition = readonly [string, string, string, number, number, string, number | null, number | null, number | null, number | null, string, number | null];

function insertModels(db: Database.Database, additions: readonly ModelAddition[]) {
  const insert = db.prepare(`INSERT OR IGNORE INTO models (platform, model_id, display_name, intelligence_rank, speed_rank, size_label, rpm_limit, rpd_limit, tpm_limit, tpd_limit, monthly_token_budget, context_window) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  for (const model of additions) insert.run(...model);
}

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

export function migrateModelsV11(db: Database.Database) {
  db.prepare("UPDATE models SET model_id = 'qwen-3-235b-a22b-instruct-2507' WHERE platform = 'cerebras' AND model_id = 'qwen3-235b'").run();
  db.prepare("UPDATE models SET monthly_token_budget = '~3M (1k credits)' WHERE platform = 'nvidia' AND model_id = 'meta/llama-3.1-70b-instruct'").run();
  insertModels(db, [
    ['nvidia', 'meta/llama-3.3-70b-instruct', 'Llama 3.3 70B (NV)', 17, 6, 'Large', 40, null, null, null, '~3M (credits)', 131072],
    ['nvidia', 'meta/llama-4-maverick-17b-128e-instruct', 'Llama 4 Maverick (NV)', 11, 6, 'Large', 40, null, null, null, '~3M (credits)', 131072],
    ['nvidia', 'mistralai/mistral-large-3-675b-instruct-2512', 'Mistral Large 3 675B (NV)', 3, 9, 'Frontier', 40, null, null, null, '~2M (credits)', 131072],
    ['nvidia', 'minimaxai/minimax-m2.7', 'MiniMax M2.7 (NV)', 3, 9, 'Frontier', 40, null, null, null, '~2M (credits)', 196608],
    ['nvidia', 'nvidia/nemotron-3-super-120b-a12b', 'Nemotron 3 Super 120B (NV)', 22, 9, 'Frontier', 40, null, null, null, '~2M (credits)', 262144],
    ['nvidia', 'nvidia/nemotron-3-nano-30b-a3b', 'Nemotron 3 Nano 30B (NV)', 22, 9, 'Medium', 40, null, null, null, '~3M (credits)', 262144],
    ['nvidia', 'google/gemma-4-31b-it', 'Gemma 4 31B (NV)', 19, 9, 'Medium', 40, null, null, null, '~3M (credits)', 262144],
    ['nvidia', 'moonshotai/kimi-k2.6', 'Kimi K2.6 (NV)', 3, 9, 'Frontier', 40, null, null, null, '~2M (credits)', 131072],
    ['cerebras', 'gpt-oss-120b', 'GPT-OSS 120B (Cerebras)', 6, 1, 'Large', 30, 1000, 60000, 1000000, '~30M', 131072],
    ['cerebras', 'llama3.1-8b', 'Llama 3.1 8B (Cerebras)', 28, 1, 'Small', 30, 1000, 60000, 1000000, '~30M', 131072],
    ['groq', 'groq/compound', 'Compound (Groq)', 6, 2, 'Large', 30, 1000, 8000, 200000, '~6M', 131072],
    ['groq', 'groq/compound-mini', 'Compound Mini (Groq)', 18, 2, 'Medium', 30, 1000, 8000, 200000, '~6M', 131072],
    ['kilo', 'nvidia/nemotron-3-super-120b-a12b:free', 'Nemotron 3 Super 120B (Kilo)', 22, 9, 'Frontier', null, null, null, null, '~2-3M (200/hr)', 262144],
    ['pollinations', 'openai-fast', 'GPT-OSS 20B (Pollinations)', 18, 10, 'Medium', null, null, null, null, '~? (anon)', 131072],
    ['llm7', 'gpt-oss-20b', 'GPT-OSS 20B (LLM7)', 18, 10, 'Medium', 100, null, null, null, '~2-3M (100/hr)', 131072],
    ['llm7', 'meta-llama/Meta-Llama-3.1-8B-Instruct-Turbo', 'Llama 3.1 8B Turbo (LLM7)', 28, 10, 'Small', 100, null, null, null, '~2-3M (100/hr)', 131072],
    ['llm7', 'codestral-latest', 'Codestral (LLM7)', 16, 8, 'Medium', 100, null, null, null, '~2-3M (100/hr)', 32000],
    ['llm7', 'ministral-8b-2512', 'Ministral 8B (LLM7)', 28, 10, 'Small', 100, null, null, null, '~2-3M (100/hr)', 131072],
    ['llm7', 'GLM-4.6V-Flash', 'GLM-4.6V Flash (LLM7)', 15, 9, 'Large', 100, null, null, null, '~2-3M (100/hr)', 131072],
  ]);
  ensureFallbackRows(db);
}

export function migrateModelsV12(db: Database.Database) {
  const deleteModel = db.prepare('DELETE FROM models WHERE platform = ? AND model_id = ?');
  const deleteFallback = db.prepare('DELETE FROM fallback_config WHERE model_db_id IN (SELECT id FROM models WHERE platform = ? AND model_id = ?)');
  for (const target of [['openrouter', 'inclusionai/ling-2.6-1t:free'], ['openrouter', 'tencent/hy3-preview:free'] ] as const) {
    deleteFallback.run(...target); deleteModel.run(...target);
  }
  db.prepare("UPDATE models SET context_window = 1000000 WHERE platform = 'openrouter' AND model_id = 'nvidia/nemotron-3-super-120b-a12b:free'").run();
  db.prepare("UPDATE models SET context_window = 1048576 WHERE platform = 'openrouter' AND model_id = 'qwen/qwen3-coder:free'").run();
  insertModels(db, [
    ['openrouter', 'arcee-ai/trinity-large-thinking:free', 'Trinity Large Thinking (free)', 5, 9, 'Frontier', 20, 200, null, null, '~6M', 262144],
    ['openrouter', 'baidu/cobuddy:free', 'CoBuddy (free)', 6, 9, 'Large', 20, 200, null, null, '~6M', 131072],
    ['openrouter', 'openrouter/owl-alpha', 'Owl Alpha (OR-house)', 5, 9, 'Frontier', 20, 200, null, null, '~6M', 1048576],
    ['openrouter', 'nousresearch/hermes-3-llama-3.1-405b:free', 'Hermes 3 405B (free)', 17, 9, 'Large', 20, 200, null, null, '~6M', 131072],
  ]);
  ensureFallbackRows(db);
}

export function migrateModelsV13(db: Database.Database) {
  const disable = db.prepare('UPDATE models SET enabled = 0 WHERE platform = ? AND model_id = ?');
  for (const target of [['google', 'gemini-3.1-pro-preview'], ['ollama', 'kimi-k2-thinking'], ['ollama', 'mistral-large-3:675b'], ['ollama', 'deepseek-v3.2']] as const) disable.run(...target);
  const deleteModel = db.prepare('DELETE FROM models WHERE platform = ? AND model_id = ?');
  const deleteFallback = db.prepare('DELETE FROM fallback_config WHERE model_db_id IN (SELECT id FROM models WHERE platform = ? AND model_id = ?)');
  for (const target of [['sambanova', 'DeepSeek-V3.1-cb'], ['cloudflare', '@cf/moonshotai/kimi-k2.5']] as const) {
    deleteFallback.run(...target); deleteModel.run(...target);
  }
  db.prepare("UPDATE models SET rpm_limit = 5, rpd_limit = 2400, tpm_limit = 30000, tpd_limit = 1000000 WHERE platform = 'cerebras' AND model_id IN ('qwen-3-235b-a22b-instruct-2507', 'gpt-oss-120b', 'llama3.1-8b')").run();
  db.prepare("UPDATE models SET tpd_limit = 100000 WHERE platform = 'groq' AND model_id = 'llama-3.3-70b-versatile'").run();
  db.prepare("UPDATE models SET tpm_limit = 30000 WHERE platform = 'groq' AND model_id = 'meta-llama/llama-4-scout-17b-16e-instruct'").run();
  db.prepare("UPDATE models SET rpd_limit = 250, tpm_limit = 70000, tpd_limit = NULL WHERE platform = 'groq' AND model_id IN ('groq/compound', 'groq/compound-mini')").run();
  db.prepare("UPDATE models SET context_window = 32768 WHERE platform = 'sambanova' AND model_id = 'DeepSeek-V3.2'").run();
  db.prepare("UPDATE models SET context_window = 24000 WHERE platform = 'cloudflare' AND model_id = '@cf/meta/llama-3.3-70b-instruct-fp8-fast'").run();
  db.prepare("UPDATE models SET context_window = 256000 WHERE platform = 'mistral' AND model_id = 'codestral-latest'").run();
  db.prepare("UPDATE models SET context_window = 262144 WHERE platform = 'mistral' AND model_id = 'devstral-latest'").run();
  db.prepare("UPDATE models SET context_window = 131072 WHERE platform = 'mistral' AND model_id = 'magistral-medium-latest'").run();
  db.prepare("UPDATE models SET context_window = 262144 WHERE platform = 'mistral' AND model_id = 'mistral-large-latest'").run();
  insertModels(db, [
    ['groq', 'openai/gpt-oss-safeguard-20b', 'GPT-OSS Safeguard 20B (Groq)', 18, 2, 'Medium', 30, 1000, 8000, 200000, '~6M', 131072],
    ['cloudflare', '@cf/nvidia/nemotron-3-120b-a12b', 'Nemotron 3 120B (CF)', 9, 11, 'Frontier', null, null, null, null, '~5-10M', 262144],
    ['cloudflare', '@cf/google/gemma-4-26b-a4b-it', 'Gemma 4 26B-A4B it (CF)', 22, 11, 'Medium', null, null, null, null, '~10-20M', 262144],
    ['google', 'gemini-3.5-flash', 'Gemini 3.5 Flash', 3, 5, 'Large', 10, 20, 250000, null, '~3M', 1048576],
    ['nvidia', 'deepseek-ai/deepseek-v4-flash', 'DeepSeek V4 Flash (NV)', 4, 9, 'Frontier', 40, null, null, null, '~3M (credits)', 131072],
    ['nvidia', 'z-ai/glm-5.1', 'GLM-5.1 (NV, slow cold-start)', 5, 9, 'Frontier', 40, null, null, null, '~3M (credits)', 200000],
    ['nvidia', 'qwen/qwen3-coder-480b-a35b-instruct', 'Qwen3-Coder 480B (NV)', 2, 9, 'Frontier', 40, null, null, null, '~3M (credits)', 262144],
    ['mistral', 'mistral-small-latest', 'Mistral Small 4', 14, 8, 'Medium', 2, null, 500000, null, '~50-100M', 262144],
    ['mistral', 'ministral-8b-latest', 'Ministral 3 8B', 28, 8, 'Small', 2, null, 500000, null, '~50-100M', 262144],
    ['cohere', 'command-a-reasoning-08-2025', 'Command A Reasoning (08-2025)', 13, 11, 'Large', 20, 33, null, null, '~1-2M', 256000],
    ['cohere', 'command-r-08-2024', 'Command R (08-2024)', 25, 11, 'Medium', 20, 33, null, null, '~1-2M', 131072],
    ['ollama', 'qwen3-coder-next', 'Qwen3-Coder Next (Ollama)', 3, 9, 'Large', null, null, null, null, '~10-20M', 262144],
    ['huggingface', 'deepseek-ai/DeepSeek-V4-Flash', 'DeepSeek V4 Flash (HF)', 4, 9, 'Frontier', null, null, null, null, '~1-3M', 131072],
    ['huggingface', 'moonshotai/Kimi-K2.6', 'Kimi K2.6 (HF)', 3, 9, 'Frontier', null, null, null, null, '~1-3M', 262144],
    ['huggingface', 'Qwen/Qwen3-Coder-Next', 'Qwen3-Coder Next (HF)', 3, 9, 'Large', null, null, null, null, '~1-3M', 262144],
  ]);
  ensureFallbackRows(db);
}

export function migrateModelsV14(db: Database.Database) {
  db.prepare("UPDATE models SET enabled = 0 WHERE platform = 'cerebras' AND model_id IN ('qwen-3-235b-a22b-instruct-2507', 'llama3.1-8b')").run();
}

export function migrateModelsV15(db: Database.Database) {
  const additions: ModelAddition[] = [
    ['openrouter', 'deepseek/deepseek-v4-flash:free', 'DeepSeek V4 Flash (free)', 4, 9, 'Frontier', 20, 200, null, null, '~6M', 1048576],
    ['openrouter', 'cognitivecomputations/dolphin-mistral-24b-venice-edition:free', 'Dolphin Mistral 24B Venice (free)', 24, 10, 'Medium', 20, 200, null, null, '~6M', 32768],
    ['openrouter', 'meta-llama/llama-3.2-3b-instruct:free', 'Llama 3.2 3B Instruct (free)', 29, 10, 'Small', 20, 200, null, null, '~6M', 131072],
  ];
  const insert = db.prepare(`INSERT OR IGNORE INTO models (platform, model_id, display_name, intelligence_rank, speed_rank, size_label, rpm_limit, rpd_limit, tpm_limit, tpd_limit, monthly_token_budget, context_window) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  const update = db.prepare('UPDATE models SET display_name = ?, intelligence_rank = ?, speed_rank = ?, size_label = ?, rpm_limit = ?, rpd_limit = ?, tpm_limit = ?, tpd_limit = ?, monthly_token_budget = ?, context_window = ? WHERE platform = ? AND model_id = ?');
  let inserted = false;
  for (const entry of additions) { const result = insert.run(...entry); update.run(entry[2], entry[3], entry[4], entry[5], entry[6], entry[7], entry[8], entry[9], entry[10], entry[11], entry[0], entry[1]); if (result.changes > 0) inserted = true; }
  ensureFallbackRows(db);
  if (inserted) db.prepare("UPDATE fallback_config SET enabled = 1 WHERE model_db_id IN (SELECT id FROM models WHERE platform = 'openrouter' AND model_id IN ('deepseek/deepseek-v4-flash:free', 'cognitivecomputations/dolphin-mistral-24b-venice-edition:free', 'meta-llama/llama-3.2-3b-instruct:free'))").run();
}

export function migrateModelsV16(db: Database.Database) {
  ensureModelBenchmarkColumns(db);
  const additions: ModelAddition[] = [
    ['google', 'gemma-4-31b-it', 'Gemma 4 31B IT', 7, 4, 'Large', 10, 20, 250000, null, '~3M', 32768],
    ['google', 'gemma-4-26b-a4b-it', 'Gemma 4 26B A4B IT', 9, 4, 'Large', 10, 20, 250000, null, '~3M', 32768],
  ];
  const update = db.prepare('UPDATE models SET display_name = ?, intelligence_rank = ?, speed_rank = ?, size_label = ?, rpm_limit = ?, rpd_limit = ?, tpm_limit = ?, tpd_limit = ?, monthly_token_budget = ?, context_window = ? WHERE platform = ? AND model_id = ?');
  insertModels(db, additions);
  for (const entry of additions) update.run(entry[2], entry[3], entry[4], entry[5], entry[6], entry[7], entry[8], entry[9], entry[10], entry[11], entry[0], entry[1]);
  ensureFallbackRows(db);
  reapplyLatestRankingSnapshot(db, db.prepare('UPDATE models SET intelligence_rank = ? WHERE platform = ? AND model_id = ?'));
}

export function migrateModelsV17(db: Database.Database) {
  const additions: ModelAddition[] = [
    ['ollama', 'glm-5.1', 'GLM-5.1 (Ollama)', 1, 9, 'Frontier', null, null, null, null, '~5-10M', 202752],
    ['ollama', 'kimi-k2.6', 'Kimi K2.6 (Ollama)', 2, 9, 'Frontier', null, null, null, null, '~5-10M', 262144],
    ['ollama', 'gemini-3-flash-preview', 'Gemini 3 Flash Preview (Ollama)', 3, 9, 'Large', null, null, null, null, '~10-20M', 1048576],
    ['ollama', 'glm-5', 'GLM-5 (Ollama)', 5, 9, 'Large', null, null, null, null, '~10-20M', 202752],
    ['ollama', 'qwen3.5:397b', 'Qwen3.5 397B (Ollama)', 6, 9, 'Frontier', null, null, null, null, '~5-10M', 262144],
    ['ollama', 'deepseek-v4-flash', 'DeepSeek V4 Flash (Ollama)', 7, 9, 'Frontier', null, null, null, null, '~5-10M', 1048576],
    ['ollama', 'minimax-m2.7', 'MiniMax M2.7 (Ollama)', 8, 9, 'Frontier', null, null, null, null, '~5-10M', 196608],
    ['huggingface', 'zai-org/GLM-5.1', 'GLM-5.1 (HF)', 1, 9, 'Frontier', null, null, null, null, '~1-3M', 202752],
    ['huggingface', 'google/gemma-4-31B-it', 'Gemma 4 31B (HF)', 5, 9, 'Medium', null, null, null, null, '~1-3M', 262144],
    ['huggingface', 'google/gemma-4-26B-A4B-it', 'Gemma 4 26B-A4B (HF)', 8, 9, 'Medium', null, null, null, null, '~1-3M', 262144],
    ['huggingface', 'Qwen/Qwen3.5-397B-A17B', 'Qwen3.5 397B (HF)', 6, 9, 'Frontier', null, null, null, null, '~1-3M', 262144],
    ['huggingface', 'Qwen/Qwen3-235B-A22B-Instruct-2507', 'Qwen3 235B (HF)', 9, 9, 'Frontier', null, null, null, null, '~1-3M', 262144],
    ['huggingface', 'MiniMaxAI/MiniMax-M2.7', 'MiniMax M2.7 (HF)', 10, 9, 'Frontier', null, null, null, null, '~1-3M', 196608],
  ];
  insertModels(db, additions);
  const update = db.prepare('UPDATE models SET display_name = ?, intelligence_rank = ?, speed_rank = ?, size_label = ?, rpm_limit = ?, rpd_limit = ?, tpm_limit = ?, tpd_limit = ?, monthly_token_budget = ?, context_window = ? WHERE platform = ? AND model_id = ?');
  for (const entry of additions) update.run(entry[2], entry[3], entry[4], entry[5], entry[6], entry[7], entry[8], entry[9], entry[10], entry[11], entry[0], entry[1]);
  ensureFallbackRows(db);
  reapplyLatestRankingSnapshot(db, db.prepare('UPDATE models SET intelligence_rank = ? WHERE platform = ? AND model_id = ?'));
}

export function migrateModelsV18(db: Database.Database) {
  ensureModelBenchmarkColumns(db);
  reapplyLatestBenchmarkSnapshot(db, db.prepare('UPDATE models SET arena_elo = ?, artificial_analysis_coding_index = ? WHERE platform = ? AND model_id = ?'));
}

export function migrateModelsV19(db: Database.Database) {
  ensureModelBenchmarkColumns(db);
  const additions: ModelAddition[] = [
    ['opencode-zen', 'deepseek-v4-flash-free', 'DeepSeek V4 Flash (Zen)', 9, 9, 'Frontier', null, null, null, null, '~6M', 1048576],
    ['opencode-zen', 'minimax-m2.5-free', 'MiniMax M2.5 (Zen)', 18, 9, 'Large', null, null, null, null, '~6M', 196608],
  ];
  const update = db.prepare('UPDATE models SET display_name = ?, intelligence_rank = ?, speed_rank = ?, size_label = ?, rpm_limit = ?, rpd_limit = ?, tpm_limit = ?, tpd_limit = ?, monthly_token_budget = ?, context_window = ? WHERE platform = ? AND model_id = ?');
  insertModels(db, additions);
  for (const entry of additions) update.run(entry[2], entry[3], entry[4], entry[5], entry[6], entry[7], entry[8], entry[9], entry[10], entry[11], entry[0], entry[1]);
  ensureFallbackRows(db);
  const setRank = db.prepare('UPDATE models SET intelligence_rank = ? WHERE platform = ? AND model_id = ?');
  const setBenchmark = db.prepare('UPDATE models SET arena_elo = ?, artificial_analysis_coding_index = ? WHERE platform = ? AND model_id = ?');
  reapplyLatestRankingSnapshot(db, setRank);
  reapplyLatestBenchmarkSnapshot(db, setBenchmark);
}

export function migrateModelsV20(db: Database.Database) {
  const disableFallback = db.prepare('UPDATE fallback_config SET enabled = 0 WHERE model_db_id = (SELECT id FROM models WHERE platform = ? AND model_id = ?)');
  for (const target of [['ollama', 'glm-5.1'], ['ollama', 'kimi-k2.6'], ['nvidia', 'moonshotai/kimi-k2.6']] as const) disableFallback.run(...target);
}

export function migrateModelsV21(db: Database.Database) {
  const columns = new Set((db.prepare('PRAGMA table_info(models)').all() as { name: string }[]).map(column => column.name));
  if (!columns.has('cold_start_retry_ms')) db.exec('ALTER TABLE models ADD COLUMN cold_start_retry_ms INTEGER DEFAULT NULL');
  db.prepare("UPDATE models SET cold_start_retry_ms = 60000 WHERE platform = 'nvidia' AND model_id = 'z-ai/glm-5.1'").run();
  db.prepare("UPDATE models SET enabled = 1 WHERE platform = 'google' AND model_id = 'gemini-3.1-pro-preview'").run();
}
