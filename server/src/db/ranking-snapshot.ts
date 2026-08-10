export interface CatalogModelForRanking {
  platform: string;
  modelId: string;
  intelligenceRank: number;
  speedRank: number;
  displayName: string;
  enabled: boolean;
}

type RankedModel = readonly [platform: string, modelId: string];
export type RankUpdate = readonly [rank: number, platform: string, modelId: string];

const arenaCodingOrder: ReadonlyArray<ReadonlyArray<RankedModel>> = [
  [['nvidia', 'z-ai/glm-5.1'], ['huggingface', 'zai-org/GLM-5.1'], ['ollama', 'glm-5.1']],
  [['cloudflare', '@cf/moonshotai/kimi-k2.6'], ['huggingface', 'moonshotai/Kimi-K2.6'], ['nvidia', 'moonshotai/kimi-k2.6'], ['ollama', 'kimi-k2.6']],
  [['google', 'gemini-3.5-flash']],
  [['google', 'gemini-3-flash-preview'], ['ollama', 'gemini-3-flash-preview']],
  [['nvidia', 'deepseek-ai/deepseek-v4-pro'], ['huggingface', 'deepseek-ai/DeepSeek-V4-Pro'], ['ollama', 'deepseek-v4-pro']],
  [['google', 'gemma-4-31b-it'], ['nvidia', 'google/gemma-4-31b-it'], ['openrouter', 'google/gemma-4-31b-it:free'], ['ollama', 'gemma4:31b'], ['huggingface', 'google/gemma-4-31B-it']],
  [['ollama', 'glm-5']],
  [['ollama', 'qwen3.5:397b'], ['huggingface', 'Qwen/Qwen3.5-397B-A17B']],
  [['opencode-zen', 'mimo-v2.5-free']],
  [['huggingface', 'deepseek-ai/DeepSeek-V4-Flash'], ['nvidia', 'deepseek-ai/deepseek-v4-flash'], ['openrouter', 'deepseek/deepseek-v4-flash:free'], ['ollama', 'deepseek-v4-flash'], ['opencode-zen', 'deepseek-v4-flash-free'], ['commandcode', 'deepseek/deepseek-v4-flash']],
  [['google', 'gemma-4-26b-a4b-it'], ['openrouter', 'google/gemma-4-26b-a4b-it:free'], ['cloudflare', '@cf/google/gemma-4-26b-a4b-it'], ['huggingface', 'google/gemma-4-26B-A4B-it']],
  [['cerebras', 'qwen-3-235b-a22b-instruct-2507'], ['huggingface', 'Qwen/Qwen3-235B-A22B-Instruct-2507']],
  [['nvidia', 'minimaxai/minimax-m2.7'], ['huggingface', 'MiniMaxAI/MiniMax-M2.7'], ['ollama', 'minimax-m2.7']],
  [['mistral', 'mistral-large-latest'], ['nvidia', 'mistralai/mistral-large-3-675b-instruct-2512'], ['ollama', 'mistral-large-3:675b']],
  [['sambanova', 'DeepSeek-V3.2'], ['ollama', 'deepseek-v3.2']],
  [['google', 'gemini-3.1-flash-lite-preview']],
  [['openrouter', 'qwen/qwen3-coder:free'], ['nvidia', 'qwen/qwen3-coder-480b-a35b-instruct'], ['ollama', 'qwen3-coder:480b']],
  [['github', 'openai/gpt-4.1']],
  [['opencode-zen', 'minimax-m3-free']],
  [['openrouter', 'minimax/minimax-m2.5:free'], ['opencode-zen', 'minimax-m2.5-free']],
  [['sambanova', 'DeepSeek-V3.1']],
  [['openrouter', 'qwen/qwen3-next-80b-a3b-instruct:free'], ['huggingface', 'Qwen/Qwen3-Coder-Next'], ['ollama', 'qwen3-coder-next']],
  [['openrouter', 'z-ai/glm-4.5-air:free']],
  [['zhipu', 'glm-4.7-flash'], ['cloudflare', '@cf/zai-org/glm-4.7-flash'], ['ollama', 'glm-4.7'], ['cerebras', 'zai-glm-4.7']],
  [['google', 'gemini-2.5-flash']],
  [['openrouter', 'arcee-ai/trinity-large-thinking:free']],
  [['nvidia', 'nvidia/nemotron-3-super-120b-a12b'], ['cloudflare', '@cf/nvidia/nemotron-3-120b-a12b'], ['openrouter', 'nvidia/nemotron-3-super-120b-a12b:free'], ['kilo', 'nvidia/nemotron-3-super-120b-a12b:free']],
  [['groq', 'qwen/qwen3-32b']],
  [['google', 'gemini-2.5-flash-lite']],
  [['cerebras', 'gpt-oss-120b'], ['groq', 'openai/gpt-oss-120b'], ['sambanova', 'gpt-oss-120b'], ['cloudflare', '@cf/openai/gpt-oss-120b'], ['openrouter', 'openai/gpt-oss-120b:free'], ['ollama', 'gpt-oss:120b']],
  [['cohere', 'command-a-03-2025']],
  [['mistral', 'magistral-medium-latest']],
  [['sambanova', 'Llama-4-Maverick-17B-128E-Instruct'], ['nvidia', 'meta/llama-4-maverick-17b-128e-instruct']],
  [['groq', 'openai/gpt-oss-20b'], ['openrouter', 'openai/gpt-oss-20b:free'], ['ollama', 'gpt-oss:20b'], ['llm7', 'gpt-oss-20b'], ['pollinations', 'openai-fast'], ['groq', 'openai/gpt-oss-safeguard-20b']],
  [['nvidia', 'nvidia/nemotron-3-nano-30b-a3b'], ['openrouter', 'nvidia/nemotron-3-nano-30b-a3b:free'], ['openrouter', 'nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free']],
  [['groq', 'meta-llama/llama-4-scout-17b-16e-instruct'], ['cloudflare', '@cf/meta/llama-4-scout-17b-16e-instruct']],
  [['github', 'gpt-4o']],
  [['groq', 'llama-3.3-70b-versatile'], ['sambanova', 'Meta-Llama-3.3-70B-Instruct'], ['openrouter', 'meta-llama/llama-3.3-70b-instruct:free'], ['cloudflare', '@cf/meta/llama-3.3-70b-instruct-fp8-fast'], ['nvidia', 'meta/llama-3.3-70b-instruct']],
  [['nvidia', 'meta/llama-3.1-70b-instruct'], ['cloudflare', '@cf/meta/llama-3.1-70b-instruct']],
  [['cohere', 'command-r-08-2024']],
  [['cohere', 'command-r-plus-08-2024']],
  [['openrouter', 'meta-llama/llama-3.2-3b-instruct:free']],
];

const analysisFallbackOrder: ReadonlyArray<ReadonlyArray<RankedModel>> = [
  [['cohere', 'command-a-reasoning-08-2025'], ['mistral', 'codestral-latest'], ['llm7', 'codestral-latest']],
  [['mistral', 'devstral-latest'], ['ollama', 'devstral-2:123b'], ['mistral', 'mistral-small-latest']],
  [['groq', 'groq/compound'], ['groq', 'groq/compound-mini'], ['openrouter', 'openrouter/owl-alpha'], ['openrouter', 'baidu/cobuddy:free'], ['openrouter', 'cognitivecomputations/dolphin-mistral-24b-venice-edition:free']],
  [['llm7', 'GLM-4.6V-Flash'], ['mistral', 'ministral-8b-latest'], ['llm7', 'ministral-8b-2512'], ['llm7', 'meta-llama/Meta-Llama-3.1-8B-Instruct-Turbo'], ['groq', 'llama-3.1-8b-instant'], ['cloudflare', '@cf/ibm-granite/granite-4.0-h-micro'], ['cloudflare', '@cf/qwen/qwen3-30b-a3b-fp8'], ['cloudflare', '@cf/deepseek-ai/deepseek-r1-distill-qwen-32b']],
  [['openrouter', 'poolside/laguna-m.1:free'], ['openrouter', 'poolside/laguna-xs.2:free'], ['openrouter', 'nvidia/nemotron-nano-9b-v2:free'], ['openrouter', 'liquid/lfm-2.5-1.2b-instruct:free'], ['openrouter', 'liquid/lfm-2.5-1.2b-thinking:free']],
];

function applyRankGroups(
  groups: ReadonlyArray<ReadonlyArray<RankedModel>>,
  startRank: number,
  presentKeys: Set<string>,
  rankedKeys: Set<string>,
  updates: Array<[number, string, string]>,
) {
  let nextRank = startRank;

  for (const group of groups) {
    let applied = false;

    for (const [platform, modelId] of group) {
      const key = `${platform}:${modelId}`;
      if (!presentKeys.has(key) || rankedKeys.has(key)) continue;

      updates.push([nextRank, platform, modelId]);
      rankedKeys.add(key);
      applied = true;
    }

    if (applied) nextRank++;
  }

  return nextRank;
}

export function buildLatestRankingSnapshot(models: ReadonlyArray<CatalogModelForRanking>): RankUpdate[] {
  const sortedEnabledModels = models.filter(model => model.enabled).sort((left, right) => {
    if (left.intelligenceRank !== right.intelligenceRank) return left.intelligenceRank - right.intelligenceRank;
    if (left.speedRank !== right.speedRank) return left.speedRank - right.speedRank;
    return left.displayName.localeCompare(right.displayName);
  });

  const presentKeys = new Set(models.map(model => `${model.platform}:${model.modelId}`));
  const rankedKeys = new Set<string>();
  const updates: Array<[number, string, string]> = [];
  let nextRank = 1;

  nextRank = applyRankGroups(arenaCodingOrder, nextRank, presentKeys, rankedKeys, updates);
  nextRank = applyRankGroups(analysisFallbackOrder, nextRank, presentKeys, rankedKeys, updates);

  for (const model of sortedEnabledModels) {
    const key = `${model.platform}:${model.modelId}`;
    if (rankedKeys.has(key)) continue;

    updates.push([nextRank, model.platform, model.modelId]);
    rankedKeys.add(key);
    nextRank++;
  }

  return updates;
}