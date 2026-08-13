export interface CatalogModelForBenchmark {
  platform: string;
  modelId: string;
}

export interface BenchmarkUpdate {
  platform: string;
  modelId: string;
  arenaElo: number | null;
  artificialAnalysisCodingIndex: number | null;
}

type BenchmarkedModel = readonly [platform: string, modelId: string];

interface BenchmarkGroup {
  models: ReadonlyArray<BenchmarkedModel>;
  arenaElo: number | null;
  artificialAnalysisCodingIndex: number | null;
}

/* Curated benchmark metadata for the catalog UI.
 * Arena Elo values come from arena.ai/leaderboard/text/coding.
 * Artificial Analysis coding scores come from the model pages on
 * artificialanalysis.ai. Rows remain null when the catalog alias does not map
 * cleanly to a public benchmark slug. */
const benchmarkGroups: ReadonlyArray<BenchmarkGroup> = [
  {
    models: [['nvidia', 'z-ai/glm-5.1'], ['huggingface', 'zai-org/GLM-5.1'], ['ollama', 'glm-5.1']],
    arenaElo: 1526,
    artificialAnalysisCodingIndex: 43.3712121212121,
  },
  {
    models: [['cloudflare', '@cf/moonshotai/kimi-k2.6'], ['huggingface', 'moonshotai/Kimi-K2.6'], ['nvidia', 'moonshotai/kimi-k2.6'], ['ollama', 'kimi-k2.6']],
    arenaElo: 1521,
    artificialAnalysisCodingIndex: 47.1170033670034,
  },
  {
    models: [['google', 'gemini-3.1-pro-preview']],
    arenaElo: 1525,
    artificialAnalysisCodingIndex: null,
  },
  {
    models: [['google', 'gemini-3.5-flash']],
    arenaElo: 1507,
    artificialAnalysisCodingIndex: 44.9810606060606,
  },
  {
    models: [['google', 'gemini-3-flash-preview'], ['ollama', 'gemini-3-flash-preview']],
    arenaElo: 1509,
    artificialAnalysisCodingIndex: 37.8402076318743,
  },
  {
    models: [['google', 'gemma-4-31b-it'], ['nvidia', 'google/gemma-4-31b-it'], ['openrouter', 'google/gemma-4-31b-it:free'], ['ollama', 'gemma4:31b'], ['huggingface', 'google/gemma-4-31B-it']],
    arenaElo: 1497,
    artificialAnalysisCodingIndex: 38.7100168350168,
  },
  {
    models: [['ollama', 'glm-5']],
    arenaElo: 1494,
    artificialAnalysisCodingIndex: 44.1813973063973,
  },
  {
    models: [['ollama', 'qwen3.5:397b'], ['huggingface', 'Qwen/Qwen3.5-397B-A17B']],
    arenaElo: 1492,
    artificialAnalysisCodingIndex: 41.2773569023569,
  },
  {
    models: [['opencode-zen', 'mimo-v2.5-free']],
    arenaElo: 1490,
    artificialAnalysisCodingIndex: null,
  },
  {
    models: [['huggingface', 'deepseek-ai/DeepSeek-V4-Flash'], ['nvidia', 'deepseek-ai/deepseek-v4-flash'], ['openrouter', 'deepseek/deepseek-v4-flash:free'], ['ollama', 'deepseek-v4-flash'], ['opencode-zen', 'deepseek-v4-flash-free'], ['commandcode', 'deepseek/deepseek-v4-flash']],
    arenaElo: 1481,
    artificialAnalysisCodingIndex: 38.7065095398429,
  },
  {
    models: [['google', 'gemma-4-26b-a4b-it'], ['openrouter', 'google/gemma-4-26b-a4b-it:free'], ['cloudflare', '@cf/google/gemma-4-26b-a4b-it'], ['huggingface', 'google/gemma-4-26B-A4B-it']],
    arenaElo: 1479,
    artificialAnalysisCodingIndex: 22.4420987654321,
  },
  {
    models: [['cerebras', 'qwen-3-235b-a22b-instruct-2507'], ['huggingface', 'Qwen/Qwen3-235B-A22B-Instruct-2507']],
    arenaElo: 1472,
    artificialAnalysisCodingIndex: 22.0994668911336,
  },
  {
    models: [['nvidia', 'minimaxai/minimax-m2.7'], ['huggingface', 'MiniMaxAI/MiniMax-M2.7'], ['ollama', 'minimax-m2.7']],
    arenaElo: 1469,
    artificialAnalysisCodingIndex: 41.9262065095398,
  },
  {
    models: [['mistral', 'mistral-large-latest'], ['nvidia', 'mistralai/mistral-large-3-675b-instruct-2512'], ['ollama', 'mistral-large-3:675b']],
    arenaElo: 1468,
    artificialAnalysisCodingIndex: 22.6816778900112,
  },
  {
    models: [['sambanova', 'DeepSeek-V3.2'], ['ollama', 'deepseek-v3.2']],
    arenaElo: 1468,
    artificialAnalysisCodingIndex: 34.6029741863075,
  },
  {
    models: [['google', 'gemini-3.1-flash-lite-preview']],
    arenaElo: 1462,
    artificialAnalysisCodingIndex: 30.1276655443322,
  },
  {
    models: [['openrouter', 'qwen/qwen3-coder:free'], ['nvidia', 'qwen/qwen3-coder-480b-a35b-instruct'], ['ollama', 'qwen3-coder:480b']],
    arenaElo: 1457,
    artificialAnalysisCodingIndex: 24.5861391694725,
  },
  {
    models: [['github', 'openai/gpt-4.1']],
    arenaElo: 1456,
    artificialAnalysisCodingIndex: 21.783810325477,
  },
  {
    models: [['sambanova', 'DeepSeek-V3.1']],
    arenaElo: 1447,
    artificialAnalysisCodingIndex: 28.3915544332211,
  },
  {
    models: [['openrouter', 'minimax/minimax-m2.5:free'], ['opencode-zen', 'minimax-m2.5-free']],
    arenaElo: 1448,
    artificialAnalysisCodingIndex: null,
  },
  {
    models: [['opencode-zen', 'minimax-m3-free']],
    arenaElo: 1451,
    artificialAnalysisCodingIndex: null,
  },
  {
    models: [['openrouter', 'qwen/qwen3-next-80b-a3b-instruct:free'], ['huggingface', 'Qwen/Qwen3-Coder-Next'], ['ollama', 'qwen3-coder-next']],
    arenaElo: 1446,
    artificialAnalysisCodingIndex: 15.2742704826038,
  },
  {
    models: [['openrouter', 'z-ai/glm-4.5-air:free']],
    arenaElo: 1426,
    artificialAnalysisCodingIndex: 23.8215488215488,
  },
  {
    models: [['zhipu', 'glm-4.7-flash'], ['cloudflare', '@cf/zai-org/glm-4.7-flash'], ['cerebras', 'zai-glm-4.7']],
    arenaElo: 1424,
    artificialAnalysisCodingIndex: 25.8733164983165,
  },
  {
    models: [['ollama', 'glm-4.7']],
    arenaElo: 1486,
    artificialAnalysisCodingIndex: 36.2584175084175,
  },
  {
    models: [['google', 'gemini-2.5-flash']],
    arenaElo: 1423,
    artificialAnalysisCodingIndex: 17.7644500561167,
  },
  {
    models: [['openrouter', 'arcee-ai/trinity-large-thinking:free']],
    arenaElo: 1419,
    artificialAnalysisCodingIndex: 27.1885521885522,
  },
  {
    models: [['nvidia', 'nvidia/nemotron-3-super-120b-a12b'], ['cloudflare', '@cf/nvidia/nemotron-3-120b-a12b'], ['openrouter', 'nvidia/nemotron-3-super-120b-a12b:free'], ['kilo', 'nvidia/nemotron-3-super-120b-a12b:free']],
    arenaElo: 1408,
    artificialAnalysisCodingIndex: 31.1903759820426,
  },
  {
    models: [['google', 'gemini-2.5-flash-lite']],
    arenaElo: null,
    artificialAnalysisCodingIndex: 7.41792929292929,
  },
  {
    models: [['cerebras', 'gpt-oss-120b'], ['groq', 'openai/gpt-oss-120b'], ['sambanova', 'gpt-oss-120b'], ['cloudflare', '@cf/openai/gpt-oss-120b'], ['openrouter', 'openai/gpt-oss-120b:free'], ['ollama', 'gpt-oss:120b']],
    arenaElo: 1390,
    artificialAnalysisCodingIndex: 28.6195286195286,
  },
  {
    models: [['mistral', 'magistral-medium-latest']],
    arenaElo: 1386,
    artificialAnalysisCodingIndex: 15.9564393939394,
  },
  {
    models: [['sambanova', 'Llama-4-Maverick-17B-128E-Instruct'], ['nvidia', 'meta/llama-4-maverick-17b-128e-instruct']],
    arenaElo: 1373,
    artificialAnalysisCodingIndex: 15.5794051627385,
  },
  {
    models: [['groq', 'openai/gpt-oss-20b'], ['openrouter', 'openai/gpt-oss-20b:free'], ['ollama', 'gpt-oss:20b'], ['llm7', 'gpt-oss-20b']],
    arenaElo: 1369,
    artificialAnalysisCodingIndex: 18.5290404040404,
  },
  {
    models: [['groq', 'meta-llama/llama-4-scout-17b-16e-instruct'], ['cloudflare', '@cf/meta/llama-4-scout-17b-16e-instruct']],
    arenaElo: 1362,
    artificialAnalysisCodingIndex: 6.68139730639731,
  },
  {
    models: [['github', 'gpt-4o']],
    arenaElo: 1368,
    artificialAnalysisCodingIndex: 16.6666666666667,
  },
  {
    models: [['groq', 'llama-3.3-70b-versatile'], ['sambanova', 'Meta-Llama-3.3-70B-Instruct'], ['openrouter', 'meta-llama/llama-3.3-70b-instruct:free'], ['cloudflare', '@cf/meta/llama-3.3-70b-instruct-fp8-fast'], ['nvidia', 'meta/llama-3.3-70b-instruct']],
    arenaElo: 1345,
    artificialAnalysisCodingIndex: null,
  },
  {
    models: [['nvidia', 'meta/llama-3.1-70b-instruct'], ['cloudflare', '@cf/meta/llama-3.1-70b-instruct']],
    arenaElo: 1333,
    artificialAnalysisCodingIndex: null,
  },
];

export function buildLatestBenchmarkSnapshot(models: ReadonlyArray<CatalogModelForBenchmark>): BenchmarkUpdate[] {
  const presentKeys = new Set(models.map(model => `${model.platform}:${model.modelId}`));
  const appliedKeys = new Set<string>();
  const updates: BenchmarkUpdate[] = [];

  for (const group of benchmarkGroups) {
    for (const [platform, modelId] of group.models) {
      const key = `${platform}:${modelId}`;
      if (!presentKeys.has(key) || appliedKeys.has(key)) continue;

      updates.push({
        platform,
        modelId,
        arenaElo: group.arenaElo,
        artificialAnalysisCodingIndex: group.artificialAnalysisCodingIndex,
      });
      appliedKeys.add(key);
    }
  }

  return updates;
}
