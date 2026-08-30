import type {
  CapabilityProfile,
  ProviderDefinition,
} from '@gloryapi/shared/types.js';

/* Catálogo estático de proveedores conocidos/oscuras del registry. Extraído de
 * registry.ts para mantener el archivo de operaciones por debajo del límite de
 * líneas del servicio; la lógica (snapshots, drafts, toggles) sigue en registry. */
export const ACTIVE_PROVIDER_PLATFORMS = ['andoryyu', 'opencode-zen', 'tokenharbor', 'opencode-go', 'commandcode'] as const;
export const ARCHIVED_PROVIDER_PLATFORMS = [
  'google', 'groq', 'cerebras', 'sambanova', 'nvidia', 'mistral',
  'openrouter', 'github', 'cohere', 'cloudflare', 'zhipu', 'ollama',
  'kilo', 'pollinations', 'llm7', 'huggingface',
  'siliconflow', 'bluesminds', 'bazaarlink', 'hyperbolic', 'deepinfra',
  'scaleway', 'nebius', 'novita', 'morph', 'publicai', 'nousresearch',
  'reka', 'sensenova', 'puter', 'tokenrouter', 'bynara',
] as const;
export const KNOWN_PROVIDER_PLATFORMS = [
  ...ACTIVE_PROVIDER_PLATFORMS,
  ...ARCHIVED_PROVIDER_PLATFORMS,
] as const;

export const activeCapabilities: CapabilityProfile = {
  streaming: true,
  tools: true,
  reasoning: true,
  multimodal: false,
  maxContextWindow: 131072,
};

// TokenHarbor is only enabled for the capabilities demonstrated by its
// OpenAI-compatible contract and the live health/chat checks. Tools,
// reasoning controls and context size stay fail-closed until separately
// verified against that provider.
const tokenharborCapabilities: CapabilityProfile = {
  streaming: true,
  tools: false,
  reasoning: false,
  multimodal: false,
  maxContextWindow: null,
};

export const ACTIVE_PROVIDER_DEFINITIONS: Array<Omit<ProviderDefinition, 'credentialCount'>> = [
  {
    platform: 'andoryyu',
    displayName: 'Andoryyu FreeBuff',
    lifecycle: 'active',
    enabled: true,
    adapter: 'openai-compatible',
    endpoint: 'https://andoryyu-freebuff2api.andoryyu.workers.dev',
    authScheme: 'bearer',
    capabilities: activeCapabilities,
    // Timeout efectivo del upstream: 120 s. Los prompts grandes (Codex con
    // contexto enorme) tardan >15 s en recibir el primer chunk; con 15 s el
    // fetch abortaba y se clasificaba como request_timeout -> 429 recurrente.
    timeoutMs: 120_000,
  },
  {
    platform: 'opencode-zen',
    displayName: 'OpenCode Zen',
    lifecycle: 'active',
    enabled: true,
    adapter: 'openai-compatible',
    endpoint: 'https://opencode.ai/zen/v1',
    authScheme: 'bearer',
    capabilities: activeCapabilities,
    timeoutMs: 120_000,
  },
  {
    platform: 'tokenharbor',
    displayName: 'TokenHarbor',
    lifecycle: 'active',
    enabled: true,
    adapter: 'openai-compatible',
    endpoint: 'https://tokenharbor.ai/v1',
    authScheme: 'bearer',
    capabilities: tokenharborCapabilities,
    timeoutMs: 120_000,
  },
  {
    platform: 'opencode-go',
    displayName: 'OpenCode Go',
    lifecycle: 'active',
    enabled: true,
    adapter: 'openai-compatible',
    endpoint: 'https://opencode.ai/zen/go/v1',
    authScheme: 'bearer',
    capabilities: activeCapabilities,
    timeoutMs: 120_000,
  },
  {
    platform: 'commandcode',
    displayName: 'CommandCode',
    lifecycle: 'active',
    enabled: true,
    adapter: 'openai-compatible',
    endpoint: 'https://api.commandcode.ai/provider/v1',
    authScheme: 'bearer',
    // CommandCode expone tanto modelos de texto (DeepSeek) como modelos con
    // visión nativa (Muse Spark 1.2). La capability `multimodal` se declara a
    // nivel de proveedor porque el endpoint acepta bloques image_url; el
    // bridge decide por modelo concreto si reenvía la imagen o la describe.
    capabilities: { ...activeCapabilities, multimodal: true },
    timeoutMs: 120_000,
  },
];