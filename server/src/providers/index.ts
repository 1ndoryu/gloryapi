import type { Platform } from '@gloryapi/shared/types.js';
import type { BaseProvider } from './base.js';
import { GoogleProvider } from './google.js';
import { OpenAICompatProvider, replaceNullAssistantContent, ensureReasoningContent } from './openai-compat.js';
import { CohereProvider } from './cohere.js';
import { CloudflareProvider } from './cloudflare.js';
import { ACTIVE_PROVIDER_DEFINITIONS, isActiveProviderPlatform } from './registry.js';

const providers = new Map<Platform, BaseProvider>();

function activeDefinition(platform: Platform) {
  const definition = ACTIVE_PROVIDER_DEFINITIONS.find(candidate => candidate.platform === platform);
  if (!definition) throw new Error(`No active provider definition for ${platform}`);
  return definition;
}

function register(provider: BaseProvider) {
  // Legacy adapters remain available to migration tests and isolated upgrades,
  // but a normal GloryAPI process exposes only the active catalog platforms.
  if (process.env.NODE_ENV !== 'test' && !isActiveProviderPlatform(provider.platform)) return;
  providers.set(provider.platform, provider);
}

// Google - unique Gemini API format
register(new GoogleProvider());

// Groq - OpenAI-compatible
register(new OpenAICompatProvider({
  platform: 'groq',
  name: 'Groq',
  baseUrl: 'https://api.groq.com/openai/v1',
}));

// Cerebras - OpenAI-compatible
register(new OpenAICompatProvider({
  platform: 'cerebras',
  name: 'Cerebras',
  baseUrl: 'https://api.cerebras.ai/v1',
}));

// SambaNova - OpenAI-compatible
register(new OpenAICompatProvider({
  platform: 'sambanova',
  name: 'SambaNova',
  baseUrl: 'https://api.sambanova.ai/v1',
}));

// NVIDIA NIM - OpenAI-compatible
register(new OpenAICompatProvider({
  platform: 'nvidia',
  name: 'NVIDIA NIM',
  baseUrl: 'https://integrate.api.nvidia.com/v1',
  maxReasoningEffort: 'max',
}));

// Mistral - OpenAI-compatible
register(new OpenAICompatProvider({
  platform: 'mistral',
  name: 'Mistral',
  baseUrl: 'https://api.mistral.ai/v1',
}));

// OpenRouter - OpenAI-compatible with extra headers
register(new OpenAICompatProvider({
  platform: 'openrouter',
  name: 'OpenRouter',
  baseUrl: 'https://openrouter.ai/api/v1',
  extraHeaders: {
    'HTTP-Referer': 'http://localhost:3101',
    'X-Title': 'GloryAPI',
  },
  maxReasoningEffort: 'max',
}));

// GitHub Models — OpenAI-compatible. Catalog uses `<publisher>/<model>` ids
// (e.g. `openai/gpt-4.1`); the old Azure endpoint rejects that prefix with
// "Unknown model", so route to the current models.github.ai endpoint.
register(new OpenAICompatProvider({
  platform: 'github',
  name: 'GitHub Models',
  baseUrl: 'https://models.github.ai/inference',
}));

// Cohere - OpenAI-compatible via Cohere compatibility endpoint
register(new CohereProvider());

// Cloudflare Workers AI - OpenAI-compatible endpoint (key = "account_id:token")
register(new CloudflareProvider());

// Zhipu (Z.ai / bigmodel.cn) - OpenAI-compatible
register(new OpenAICompatProvider({
  platform: 'zhipu',
  name: 'Zhipu AI',
  baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
}));

// Hugging Face Inference Providers router — re-added in V13. The V4 removal
// reason ("tool-call format issues") was the legacy serverless route that
// emitted tool calls as text; the new router.huggingface.co meta-router
// uses each backend's native protocol then normalizes the response.
// Recurring $0.10/mo router credit on the free tier, no card required.
register(new OpenAICompatProvider({
  platform: 'huggingface',
  name: 'HuggingFace Router',
  baseUrl: 'https://router.huggingface.co/v1',
}));

// OpenCode Zen — OpenAI-compatible. Free pool includes DeepSeek V4 Flash Free,
// MiniMax M2.5 Free, MiniMax M3 Free, MiMo V2.5 Free, Qwen3.6 Plus Free and
// Nemotron-3 Super Free. The `-free` rows are reachable without an API key.
// Zen preserves `reasoning_content` on assistant turns, but rejects
// `content: null` in follow-up assistant messages, so coerce null assistant
// content to '' while preserving the reasoning fields. The gateway also runs
// DeepSeek in thinking mode (exigiendo `reasoning_content` en toda assistant
// turn), so fill missing reasoning with '' — see ensureReasoningContent.
register(new OpenAICompatProvider({
  platform: 'opencode-zen',
  name: activeDefinition('opencode-zen').displayName,
  baseUrl: activeDefinition('opencode-zen').endpoint,
  prepareMessages: m => ensureReasoningContent(replaceNullAssistantContent(m)),
  timeoutMs: 120000,
  maxReasoningEffort: 'max',
  modelReasoningLimits: {
    'mimo': 'high',
    'minimax': 'high',
  },
}));

// TokenHarbor — OpenAI-compatible catalog gateway. Its DeepSeek V4 Flash
// route is exposed to GloryAPI as `deepseek-v4-flash:free`, while the gateway
// reports the effective upstream model as the bare `deepseek-v4-flash` ID.
// Sending the bare alias keeps the response identity contract strict without
// hiding the provider's public catalog ID from clients.
register(new OpenAICompatProvider({
  platform: 'tokenharbor',
  name: activeDefinition('tokenharbor').displayName,
  baseUrl: activeDefinition('tokenharbor').endpoint,
  prepareMessages: m => ensureReasoningContent(replaceNullAssistantContent(m)),
  timeoutMs: 120_000,
  maxReasoningEffort: 'max',
  modelAliases: {
    'deepseek-v4-flash:free': 'deepseek-v4-flash',
  },
}));

// Moonshot direct integration was dropped in V4 (paid-only); MiniMax direct
// was dropped in V4 (superseded by the OpenRouter route).

// Ollama Cloud — OpenAI-compatible. Free plan: 1 concurrent model, 5h session
// caps, GPU-time-based quota (not per-token). Many catalog models on the
// /v1/models list are subscription-only — Free returns 403 with an explicit
// "this model requires a subscription" message. Catalog rows are filtered to
// confirmed-Free entries.
//
// Frontier reasoning models (glm-4.7, kimi-k2-thinking, cogito-2.1:671b)
// regularly take 30-90s on Ollama Cloud Free, so the timeout is bumped from
// the default 15s. Ollama returns reasoning in `message.reasoning` (not
// `reasoning_content`) — handled by normalizeChoices.
register(new OpenAICompatProvider({
  platform: 'ollama',
  name: 'Ollama Cloud',
  baseUrl: 'https://ollama.com/v1',
  timeoutMs: 120000,
}));

// Kilo AI Gateway — OpenAI-compatible aggregator. Anonymous access works
// (200 req/hr per IP) for the few :free routes still active; a Kilo API key
// raises the limit. Most named "free" routes in the docs have transitioned to
// paid ("free period ended") — probe before adding catalog rows.
register(new OpenAICompatProvider({
  platform: 'kilo',
  name: 'Kilo Gateway',
  baseUrl: 'https://api.kilo.ai/api/gateway/v1',
}));

// CommandCode — OpenAI-compatible. Paid Provider/GOAT tier proxy to Anthropic,
// OpenAI and OSS models. Same API key from CommandCode Studio. The endpoint
// serves both text-only DeepSeek models and multimodal Muse Spark 1.2; the
// bridge forwards image_url blocks natively only for vision-capable models.
register(new OpenAICompatProvider({
  platform: 'commandcode',
  name: activeDefinition('commandcode').displayName,
  baseUrl: activeDefinition('commandcode').endpoint,
  timeoutMs: 120_000,
  maxReasoningEffort: 'max',
}));

// OpenCode Go — OpenAI-compatible. Go subscription tier of opencode.ai.
// Distinct from opencode-zen (free pool). Requires an API key with Go plan.
// Same gateway as zen: DeepSeek in thinking mode rejects assistant turns
// without `reasoning_content` (400) — fill missing reasoning with ''.
register(new OpenAICompatProvider({
  platform: 'opencode-go',
  name: activeDefinition('opencode-go').displayName,
  baseUrl: activeDefinition('opencode-go').endpoint,
  prepareMessages: m => ensureReasoningContent(replaceNullAssistantContent(m)),
  timeoutMs: 120000,
  maxReasoningEffort: 'max',
  modelReasoningLimits: {
    'mimo': 'high',
    'minimax': 'high',
  },
}));

// Pollinations — OpenAI-compatible, anonymous tier. The chat completions
// endpoint lives at `/openai/v1/chat/completions` (NOT `/v1/...` — the
// `/openai` prefix is mandatory). Public model list returns one anonymous
// model (`openai-fast` = GPT-OSS 20B on OVH, tools=true).
register(new OpenAICompatProvider({
  platform: 'pollinations',
  name: 'Pollinations',
  baseUrl: 'https://text.pollinations.ai/openai/v1',
}));

// LLM7.io — OpenAI-compatible aggregator. 100 req/hr free; anonymous access
// also works for basic models. Wraps a handful of upstream models behind one
// token (GPT-OSS, Llama 3.1 Turbo via Meta, Codestral via Mistral, Ministral,
// GLM-4.6V-Flash).
register(new OpenAICompatProvider({
  platform: 'llm7',
  name: 'LLM7',
  baseUrl: 'https://api.llm7.io/v1',
}));

// Chutes was evaluated for V11 and dropped: probe with a free-tier key
// returned 402 on every model — "Quota exceeded and account balance is
// $0.0, please pay with fiat or send tao". The "free" tier requires a
// non-zero balance, which conflicts with the project's no-card criterion.

// ---- New providers added 2026-07-20 ----

// SiliconFlow — OpenAI-compatible. Chinese provider with uncapped free tier.
// Supports Qwen3, DeepSeek V3, and many open-source models.
register(new OpenAICompatProvider({
  platform: 'siliconflow',
  name: 'SiliconFlow',
  baseUrl: 'https://api.siliconflow.cn/v1',
  prepareMessages: replaceNullAssistantContent,
}));

// BluesMinds removed — site inaccessible, unverifiable free tier.

// BazaarLink — OpenAI-compatible. ~4M tokens/month free, 32 models.
register(new OpenAICompatProvider({
  platform: 'bazaarlink',
  name: 'BazaarLink',
  baseUrl: 'https://api.bazaarlink.ai/v1',
}));

// Hyperbolic — OpenAI-compatible. ~5M tokens signup bonus, 8 models.
register(new OpenAICompatProvider({
  platform: 'hyperbolic',
  name: 'Hyperbolic',
  baseUrl: 'https://api.hyperbolic.xyz/v1',
}));

// DeepInfra removed — paid only, no free tier.

// Scaleway — OpenAI-compatible. ~1M tokens signup bonus, 6 models. European.
// NOTE: URL requires project_id: https://api.scaleway.ai/{project_id}/v1
// User must configure baseUrl to their project-specific URL when adding API key.
register(new OpenAICompatProvider({
  platform: 'scaleway',
  name: 'Scaleway',
  baseUrl: 'https://api.scaleway.ai/v1',
}));

// Nebius removed — GPU infrastructure, no free inference API.

// Novita removed — 1 free model only, rest paid per-token.

// Morph — OpenAI-compatible. ~400K tokens free, fast inference.
register(new OpenAICompatProvider({
  platform: 'morph',
  name: 'Morph',
  baseUrl: 'https://api.morphllm.com/v1',
}));

// PublicAI — OpenAI-compatible. Free tier, 3 models.
register(new OpenAICompatProvider({
  platform: 'publicai',
  name: 'PublicAI',
  baseUrl: 'https://api.publicai.co/v1',
}));

// NousResearch removed — not an inference API provider.

// Reka removed — API discontinued/inaccessible.

// SenseNova — OpenAI-compatible. Chinese provider, beta public access.
register(new OpenAICompatProvider({
  platform: 'sensenova',
  name: 'SenseNova',
  baseUrl: 'https://api.sensenova.cn/v1',
  prepareMessages: replaceNullAssistantContent,
}));

// Puter removed — user-pays model, not an inference API provider.

// TokenRouter — OpenAI-compatible aggregator. Free tier with multiple models.
register(new OpenAICompatProvider({
  platform: 'tokenrouter',
  name: 'TokenRouter',
  baseUrl: 'https://api.tokenrouter.com/v1',
}));

// Bynara — OpenAI-compatible aggregator. Claude and other models.
register(new OpenAICompatProvider({
  platform: 'bynara',
  name: 'Bynara',
  baseUrl: 'https://router.bynara.id/v1',
}));

// Andoryyu FreeBuff — OpenAI-compatible. Free Cloudflare Worker proxy to
// DeepSeek V4 Flash (cost 0). Verified working. Catalog exposes the bare
// `deepseek-v4-flash` ID (what clients like VSCode request); the upstream
// API needs the `deepseek/` prefix, handled by modelAliases.
// The worker intermittently cuts the stream at ANY point (reasoning phase,
// mid-content, tool_calls) without [DONE]. bufferUntilDone holds everything
// back until the stream completes (or fails), so every failure happens before
// anything reaches the client and the router falls back to the next model —
// the client always gets a complete response from some provider.
register(new OpenAICompatProvider({
  platform: 'andoryyu',
  name: activeDefinition('andoryyu').displayName,
  baseUrl: activeDefinition('andoryyu').endpoint,
  timeoutMs: 120000,
  modelAliases: {
    'deepseek-v4-flash': 'deepseek/deepseek-v4-flash',
  },
  bufferUntilDone: true,
}));

export function getProvider(platform: Platform): BaseProvider | undefined {
  return providers.get(platform);
}

export function getAllProviders(): BaseProvider[] {
  return Array.from(providers.values());
}

export function hasProvider(platform: Platform): boolean {
  return providers.has(platform);
}
