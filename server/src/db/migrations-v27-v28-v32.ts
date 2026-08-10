import Database from 'better-sqlite3';
import {
  ensureModelBenchmarkColumns,
  reapplyLatestBenchmarkSnapshot,
  reapplyLatestRankingSnapshot,
} from './migration-snapshots.js';

type ModelAddition = readonly [
  platform: string,
  modelId: string,
  displayName: string,
  intelligenceRank: number,
  speedRank: number,
  sizeLabel: string,
  rpmLimit: number | null,
  rpdLimit: number | null,
  tpmLimit: number | null,
  tpdLimit: number | null,
  monthlyTokenBudget: string,
  contextWindow: number | null,
];

function insertModels(db: Database.Database, additions: readonly ModelAddition[]) {
  const insert = db.prepare(`
    INSERT OR IGNORE INTO models
      (platform, model_id, display_name, intelligence_rank, speed_rank,
       size_label, rpm_limit, rpd_limit, tpm_limit, tpd_limit,
       monthly_token_budget, context_window)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const update = db.prepare(`
    UPDATE models SET
      display_name = ?, intelligence_rank = ?, speed_rank = ?,
      size_label = ?, rpm_limit = ?, rpd_limit = ?,
      tpm_limit = ?, tpd_limit = ?, monthly_token_budget = ?,
      context_window = ?
    WHERE platform = ? AND model_id = ?
  `);
  let inserted = false;
  for (const model of additions) {
    const result = insert.run(...model);
    if (result.changes > 0) inserted = true;
    update.run(model[2], model[3], model[4], model[5], model[6], model[7], model[8], model[9], model[10], model[11], model[0], model[1]);
  }
  return inserted;
}

function refreshSnapshots(db: Database.Database) {
  const setRank = db.prepare('UPDATE models SET intelligence_rank = ? WHERE platform = ? AND model_id = ?');
  const setBenchmark = db.prepare('UPDATE models SET arena_elo = ?, artificial_analysis_coding_index = ? WHERE platform = ? AND model_id = ?');
  reapplyLatestRankingSnapshot(db, setRank);
  reapplyLatestBenchmarkSnapshot(db, setBenchmark);
}

function appendFallbackRows(db: Database.Database, additions: readonly ModelAddition[]) {
  const maxPriority = (db.prepare('SELECT COALESCE(MAX(priority), 0) AS value FROM fallback_config').get() as { value: number }).value;
  const addFallback = db.prepare(`
    INSERT OR IGNORE INTO fallback_config (model_db_id, priority, enabled)
    SELECT id, ?, 1 FROM models WHERE platform = ? AND model_id = ?
  `);
  let offset = 0;
  for (const model of additions) {
    const row = db.prepare('SELECT id FROM models WHERE platform = ? AND model_id = ?').get(model[0], model[1]);
    if (row) {
      addFallback.run(maxPriority + offset + 1, model[0], model[1]);
      offset++;
    }
  }
}

export function migrateModelsV27(db: Database.Database) {
  ensureModelBenchmarkColumns(db);
  const additions: ModelAddition[] = [
    ['bazaarlink', 'deepseek-v4-pro', 'DeepSeek V4 Pro (Bazaarlink)', 5, 9, 'Frontier', null, null, null, null, 'free', 1048576],
    ['bazaarlink', 'deepseek-v4-flash', 'DeepSeek V4 Flash (Bazaarlink)', 10, 9, 'Frontier', null, null, null, null, 'free', 1048576],
    ['bazaarlink', 'qwen3.7-max', 'Qwen 3.7 Max (Bazaarlink)', 3, 9, 'Frontier', null, null, null, null, 'free', 1048576],
    ['bazaarlink', 'qwen3-235b-a22b', 'Qwen 3 235B (Bazaarlink)', 6, 9, 'Frontier', null, null, null, null, 'free', 1048576],
    ['bazaarlink', 'glm-5', 'GLM-5 (Bazaarlink)', 6, 9, 'Frontier', null, null, null, null, 'free', 1048576],
    ['bazaarlink', 'kimi-k3', 'Kimi K3 (Bazaarlink)', 4, 9, 'Frontier', null, null, null, null, 'free', 1048576],
    ['bazaarlink', 'gpt-4o-mini', 'GPT-4o Mini (Bazaarlink)', 12, 9, 'Small', null, null, null, null, 'free', 128000],
    ['bazaarlink', 'claude-sonnet-5', 'Claude Sonnet 5 (Bazaarlink)', 3, 9, 'Frontier', null, null, null, null, 'free', 200000],
    ['bazaarlink', 'gemini-2.5-flash', 'Gemini 2.5 Flash (Bazaarlink)', 10, 9, 'Frontier', null, null, null, null, 'free', 1048576],
    ['bazaarlink', 'mimo-v2.5', 'MiMo V2.5 (Bazaarlink)', 9, 9, 'Large', null, null, null, null, 'free', 1048576],
    ['bazaarlink', 'mimo-v2.5-pro', 'MiMo V2.5 Pro (Bazaarlink)', 7, 9, 'Large', null, null, null, null, 'free', 1048576],
    ['bazaarlink', 'deepseek-r1', 'DeepSeek R1 (Bazaarlink)', 2, 9, 'Frontier', null, null, null, null, 'free', 1048576],
    ['bazaarlink', 'mistral-large', 'Mistral Large (Bazaarlink)', 6, 9, 'Frontier', null, null, null, null, 'free', 128000],
    ['deepinfra', 'deepseek-ai/DeepSeek-V4-Pro', 'DeepSeek V4 Pro (DeepInfra)', 5, 9, 'Frontier', null, null, null, null, 'free', 1048576],
    ['deepinfra', 'deepseek-ai/DeepSeek-V4-Flash', 'DeepSeek V4 Flash (DeepInfra)', 10, 9, 'Frontier', null, null, null, null, 'free', 1048576],
    ['deepinfra', 'Qwen/Qwen3.7-Max', 'Qwen 3.7 Max (DeepInfra)', 3, 9, 'Frontier', null, null, null, null, 'free', 1048576],
    ['deepinfra', 'Qwen/Qwen3-235B-A22B-Instruct-2507', 'Qwen 3 235B (DeepInfra)', 6, 9, 'Frontier', null, null, null, null, 'free', 1048576],
    ['deepinfra', 'Qwen/Qwen3-32B', 'Qwen 3 32B (DeepInfra)', 8, 9, 'Large', null, null, null, null, 'free', 1048576],
    ['deepinfra', 'google/gemma-4-31B-it', 'Gemma 4 31B (DeepInfra)', 10, 9, 'Large', null, null, null, null, 'free', 131072],
    ['deepinfra', 'google/gemini-3.1-pro', 'Gemini 3.1 Pro (DeepInfra)', 4, 9, 'Frontier', null, null, null, null, 'free', 1048576],
    ['deepinfra', 'meta-llama/Llama-4-Scout-17B-16E-Instruct', 'Llama 4 Scout (DeepInfra)', 8, 9, 'Large', null, null, null, null, 'free', 524288],
    ['deepinfra', 'XiaomiMiMo/MiMo-V2.5', 'MiMo V2.5 (DeepInfra)', 9, 9, 'Large', null, null, null, null, 'free', 1048576],
    ['deepinfra', 'XiaomiMiMo/MiMo-V2.5-Pro', 'MiMo V2.5 Pro (DeepInfra)', 7, 9, 'Large', null, null, null, null, 'free', 1048576],
    ['novita', 'deepseek/deepseek-v4-pro', 'DeepSeek V4 Pro (Novita)', 5, 9, 'Frontier', null, null, null, null, 'free', 1048576],
    ['novita', 'deepseek/deepseek-v4-flash', 'DeepSeek V4 Flash (Novita)', 10, 9, 'Frontier', null, null, null, null, 'free', 1048576],
    ['novita', 'qwen/qwen3.7-max', 'Qwen 3.7 Max (Novita)', 3, 9, 'Frontier', null, null, null, null, 'free', 1048576],
    ['novita', 'qwen/qwen3-235b-a22b', 'Qwen 3 235B (Novita)', 6, 9, 'Frontier', null, null, null, null, 'free', 1048576],
    ['novita', 'zai-org/glm-5', 'GLM-5 (Novita)', 6, 9, 'Frontier', null, null, null, null, 'free', 1048576],
    ['novita', 'moonshotai/kimi-k3', 'Kimi K3 (Novita)', 4, 9, 'Frontier', null, null, null, null, 'free', 1048576],
    ['novita', 'xiaomimimo/mimo-v2.5', 'MiMo V2.5 (Novita)', 9, 9, 'Large', null, null, null, null, 'free', 1048576],
    ['novita', 'xiaomimimo/mimo-v2.5-pro', 'MiMo V2.5 Pro (Novita)', 7, 9, 'Large', null, null, null, null, 'free', 1048576],
    ['novita', 'meta-llama/llama-4-scout-17b-16e-instruct', 'Llama 4 Scout (Novita)', 8, 9, 'Large', null, null, null, null, 'free', 524288],
    ['novita', 'meta-llama/llama-3.3-70b-instruct', 'Llama 3.3 70B (Novita)', 10, 9, 'Large', null, null, null, null, 'free', 131072],
    ['novita', 'mistralai/mistral-nemo', 'Mistral Nemo (Novita)', 10, 9, 'Medium', null, null, null, null, 'free', 128000],
    ['novita', 'deepseek/deepseek-r1', 'DeepSeek R1 (Novita)', 2, 9, 'Frontier', null, null, null, null, 'free', 1048576],
    ['nousresearch', 'meituan/longcat-2.0', 'LongCat 2.0 (Nous)', 10, 9, 'Large', null, null, null, null, 'free', 131072],
    ['nousresearch', 'thinkingmachines/inkling', 'Inkling (Nous)', 10, 9, 'Large', null, null, null, null, 'free', 131072],
    ['nousresearch', 'moonshotai/kimi-k3', 'Kimi K3 (Nous)', 4, 9, 'Frontier', null, null, null, null, 'free', 1048576],
    ['nousresearch', 'kwaipilot/kat-coder-air-v2.5', 'Kat Coder Air (Nous)', 10, 9, 'Medium', null, null, null, null, 'free', 131072],
    ['nousresearch', 'kwaipilot/kat-coder-pro-v2.5', 'Kat Coder Pro (Nous)', 8, 9, 'Large', null, null, null, null, 'free', 131072],
  ];

  db.transaction(() => {
    const inserted = insertModels(db, additions);
    if (inserted) refreshSnapshots(db);
    const disable = db.prepare('UPDATE models SET enabled = 0 WHERE platform = ?');
    for (const platform of ['bluesminds', 'reka', 'sensenova', 'puter', 'groq']) disable.run(platform);
    appendFallbackRows(db, additions);
  })();
}

export function migrateModelsV28(db: Database.Database) {
  ensureModelBenchmarkColumns(db);
  const additions: ModelAddition[] = [
    ['siliconflow', 'Qwen/Qwen3-8B', 'Qwen 3 8B (SiliconFlow)', 10, 9, 'Medium', 60, null, null, null, 'uncapped', 131072],
    ['siliconflow', 'Qwen/Qwen3.5-4B', 'Qwen 3.5 4B (SiliconFlow)', 10, 9, 'Small', 60, null, null, null, 'uncapped', 262144],
    ['siliconflow', 'Qwen/Qwen2.5-7B-Instruct', 'Qwen 2.5 7B (SiliconFlow)', 10, 9, 'Small', 60, null, null, null, 'uncapped', 33000],
    ['siliconflow', 'THUDM/GLM-Z1-9B-0414', 'GLM Z1 9B (SiliconFlow)', 8, 9, 'Medium', 60, null, null, null, 'uncapped', 131000],
    ['siliconflow', 'THUDM/GLM-4-9B-0414', 'GLM 4 9B (SiliconFlow)', 8, 9, 'Medium', 60, null, null, null, 'uncapped', 128000],
    ['siliconflow', 'tencent/Hunyuan-MT-7B', 'Hunyuan MT 7B (SiliconFlow)', 10, 9, 'Small', 60, null, null, null, 'uncapped', 33000],
    ['siliconflow', 'deepseek-ai/DeepSeek-R1-0528-Qwen3-8B', 'DeepSeek R1 Qwen3 8B (SiliconFlow)', 5, 9, 'Medium', 60, null, null, null, 'uncapped', 131000],
    ['hyperbolic', 'deepseek-ai/DeepSeek-V3', 'DeepSeek V3 (Hyperbolic)', 5, 9, 'Frontier', 60, null, null, null, '~5M signup', 128000],
    ['hyperbolic', 'deepseek-ai/DeepSeek-R1', 'DeepSeek R1 (Hyperbolic)', 2, 9, 'Frontier', 60, null, null, null, '~5M signup', 128000],
    ['hyperbolic', 'meta-llama/Meta-Llama-3.1-8B-Instruct', 'Llama 3.1 8B (Hyperbolic)', 10, 9, 'Medium', 60, null, null, null, '~5M signup', 128000],
    ['hyperbolic', 'meta-llama/Meta-Llama-3.1-70B-Instruct', 'Llama 3.1 70B (Hyperbolic)', 8, 9, 'Large', 60, null, null, null, '~5M signup', 128000],
    ['hyperbolic', 'Qwen/Qwen2.5-7B-Instruct', 'Qwen 2.5 7B (Hyperbolic)', 10, 9, 'Small', 60, null, null, null, '~5M signup', 128000],
    ['hyperbolic', 'Qwen/Qwen2.5-72B-Instruct', 'Qwen 2.5 72B (Hyperbolic)', 8, 9, 'Large', 60, null, null, null, '~5M signup', 128000],
    ['hyperbolic', 'mistralai/Mistral-7B-Instruct-v0.3', 'Mistral 7B (Hyperbolic)', 10, 9, 'Small', 60, null, null, null, '~5M signup', 32000],
    ['scaleway', 'qwen/qwen3.6-35b-a3b:bf16', 'Qwen 3.6 35B (Scaleway)', 8, 9, 'Large', 60, null, null, null, '~1M signup', 256000],
    ['scaleway', 'qwen/qwen3.5-397b-a17b:int4', 'Qwen 3.5 397B (Scaleway)', 3, 9, 'Frontier', 60, null, null, null, '~1M signup', 250000],
    ['scaleway', 'qwen/qwen3-235b-a22b-instruct-2507', 'Qwen 3 235B (Scaleway)', 6, 9, 'Frontier', 60, null, null, null, '~1M signup', 250000],
    ['scaleway', 'google/gemma-4-26b-a4b-it:bf16', 'Gemma 4 26B (Scaleway)', 8, 9, 'Large', 60, null, null, null, '~1M signup', 256000],
    ['scaleway', 'mistral/mistral-small-3.2-24b-instruct-2506:fp8', 'Mistral Small 3.2 24B (Scaleway)', 10, 9, 'Medium', 60, null, null, null, '~1M signup', 128000],
    ['scaleway', 'openai/gpt-oss-120b:fp4', 'GPT OSS 120B (Scaleway)', 6, 9, 'Frontier', 60, null, null, null, '~1M signup', 128000],
    ['nebius', 'meta-llama/Meta-Llama-3.1-8B-Instruct', 'Llama 3.1 8B (Nebius)', 10, 9, 'Medium', 60, null, null, null, '~1M signup', 131000],
    ['nebius', 'meta-llama/Meta-Llama-3.1-70B-Instruct', 'Llama 3.1 70B (Nebius)', 8, 9, 'Large', 60, null, null, null, '~1M signup', 131000],
    ['nebius', 'deepseek-ai/DeepSeek-R1-0528', 'DeepSeek R1 (Nebius)', 2, 9, 'Frontier', 60, null, null, null, '~1M signup', 128000],
    ['nebius', 'Qwen/Qwen2.5-72B-Instruct', 'Qwen 2.5 72B (Nebius)', 8, 9, 'Large', 60, null, null, null, '~1M signup', 128000],
    ['nebius', 'mistralai/Mistral-7B-Instruct-v0.3', 'Mistral 7B (Nebius)', 10, 9, 'Small', 60, null, null, null, '~1M signup', 32000],
    ['morph', 'morph-dsv4flash', 'DeepSeek V4 Flash (Morph)', 10, 9, 'Frontier', 60, null, null, null, '250K + 200req/mo', 1048576],
    ['morph', 'morph-glm52-744b', 'GLM 5.2 744B (Morph)', 6, 9, 'Frontier', 60, null, null, null, '250K + 200req/mo', 1048576],
    ['morph', 'morph-qwen35-397b', 'Qwen 3.5 397B (Morph)', 3, 9, 'Frontier', 60, null, null, null, '250K + 200req/mo', 262000],
    ['morph', 'morph-minimax3-428b', 'MiniMax 3 428B (Morph)', 5, 9, 'Frontier', 60, null, null, null, '250K + 200req/mo', 256000],
    ['morph', 'morph-gemma4-31b', 'Gemma 4 31B (Morph)', 8, 9, 'Large', 60, null, null, null, '250K + 200req/mo', 175000],
    ['publicai', 'swiss-ai/apertus-8b-instruct', 'Apertus 8B (PublicAI)', 10, 9, 'Medium', 20, null, null, null, 'free', 128000],
  ];

  db.transaction(() => {
    const inserted = insertModels(db, additions);
    if (inserted) refreshSnapshots(db);
    appendFallbackRows(db, additions);
  })();
}

export function migrateModelsV32(db: Database.Database) {
  ensureModelBenchmarkColumns(db);
  const additions: ModelAddition[] = [
    ['nvidia', 'nvidia/nemotron-3-ultra-550b-a55b', 'Nemotron Ultra 550B (NV)', 1, 9, 'Frontier', 40, null, null, null, 'free', 131072],
    ['nvidia', 'nvidia/llama-3.1-nemotron-ultra-253b-v1', 'Nemotron Ultra 253B (NV)', 2, 9, 'Frontier', 40, null, null, null, 'free', 131072],
    ['nvidia', 'nvidia/llama-3.3-nemotron-super-49b-v1.5', 'Nemotron Super 49B v1.5 (NV)', 3, 9, 'Large', 40, null, null, null, 'free', 131072],
    ['nvidia', 'nvidia/llama-3.3-nemotron-super-49b-v1', 'Nemotron Super 49B (NV)', 4, 9, 'Large', 40, null, null, null, 'free', 131072],
    ['nvidia', 'nvidia/llama-3.1-nemotron-51b-instruct', 'Nemotron 51B (NV)', 5, 9, 'Large', 40, null, null, null, 'free', 131072],
    ['nvidia', 'nvidia/llama-3.1-nemotron-70b-instruct', 'Nemotron 70B (NV)', 5, 9, 'Large', 40, null, null, null, 'free', 131072],
    ['nvidia', 'nvidia/nemotron-3-nano-omni-30b-a3b-reasoning', 'Nemotron Nano Omni 30B (NV)', 6, 9, 'Large', 40, null, null, null, 'free', 131072],
    ['nvidia', 'nvidia/nemotron-nano-3-30b-a3b', 'Nemotron Nano 3 30B (NV)', 7, 9, 'Large', 40, null, null, null, 'free', 131072],
    ['nvidia', 'nvidia/nvidia-nemotron-nano-9b-v2', 'Nemotron Nano 9B v2 (NV)', 8, 9, 'Medium', 40, null, null, null, 'free', 131072],
    ['nvidia', 'nvidia/llama-3.1-nemotron-nano-8b-v1', 'Nemotron Nano 8B (NV)', 9, 9, 'Medium', 40, null, null, null, 'free', 131072],
    ['nvidia', 'nvidia/nemotron-mini-4b-instruct', 'Nemotron Mini 4B (NV)', 10, 9, 'Small', 40, null, null, null, 'free', 131072],
    ['nvidia', 'openai/gpt-oss-120b', 'GPT-OSS 120B (NV)', 4, 9, 'Frontier', 40, null, null, null, 'free', 131072],
    ['nvidia', 'openai/gpt-oss-20b', 'GPT-OSS 20B (NV)', 9, 9, 'Medium', 40, null, null, null, 'free', 131072],
    ['nvidia', 'minimaxai/minimax-m3', 'MiniMax M3 (NV)', 5, 9, 'Frontier', 40, null, null, null, 'free', 131072],
    ['nvidia', 'stepfun-ai/step-3.7-flash', 'Step 3.7 Flash (NV)', 7, 9, 'Large', 40, null, null, null, 'free', 131072],
    ['nvidia', 'z-ai/glm-5.2', 'GLM 5.2 (NV)', 4, 9, 'Frontier', 40, null, null, null, 'free', 131072],
    ['nvidia', 'thinkingmachines/inkling', 'Inkling (NV)', 8, 9, 'Large', 40, null, null, null, 'free', 131072],
  ];

  db.transaction(() => {
    const inserted = insertModels(db, additions);
    db.prepare("UPDATE models SET enabled = 1 WHERE platform = 'nvidia' AND model_id = 'deepseek-ai/deepseek-v4-pro'").run();
    if (inserted) refreshSnapshots(db);
    appendFallbackRows(db, additions);
  })();
}
