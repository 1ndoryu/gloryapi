/** Resolución del transporte efectivo (URL/timeout/alias) del provider
 * OpenAI-compatible: canary loopback, configuración DB y overrides de settings.
 * Extraído de `openai-compat.ts` (límite 300 líneas). */
import type { Platform } from '@gloryapi/shared/types.js';
import { getDb } from '../../db/index.js';
import { getConfiguredProviderFromDb } from '../../services/provider-configuration.js';
import { getEffectiveProviderModelSettings } from '../../settings/registry.js';

export interface CompatTransportOptions {
  platform: Platform;
  name: string;
  baseUrl: string;
  timeoutMs?: number;
  modelAliases?: Record<string, string>;
  endpointKinds?: Record<string, 'chat' | 'responses'>;
}

export interface ResolvedTransport {
  baseUrl: string;
  timeoutMs: number;
  modelAlias: string | null;
}

export class CompatTransport {
  private readonly platform: Platform;
  private readonly name: string;
  private readonly baseUrl: string;
  /** Per-provider HTTP timeout override. Cloud APIs finish in ~15s; locally-hosted
   * inference (llama.cpp / vLLM on CPU) can take 30-120s for long prompts. Default 15000. */
  private readonly timeoutMs: number;
  /** Map client-facing model_id → upstream model_id. Lets the catalog expose
   * a bare ID (e.g. `deepseek-v4-flash`) while the provider's API requires a
   * prefixed one (e.g. `deepseek/deepseek-v4-flash`). */
  private readonly modelAliases: Record<string, string>;
  /** Per-model transport override: substring-matched against the model id
   * (case-insensitive). Models whose upstream only serves the Responses API
   * (e.g. Muse Spark on OpenCode Go) pin `responses` here; everything else
   * keeps the OpenAI chat-completions contract. */
  private readonly endpointKinds: Map<string, 'chat' | 'responses'>;

  constructor(opts: CompatTransportOptions) {
    this.platform = opts.platform;
    this.name = opts.name;
    this.baseUrl = opts.baseUrl;
    this.timeoutMs = opts.timeoutMs ?? 15000;
    this.modelAliases = opts.modelAliases ?? {};
    this.endpointKinds = new Map(Object.entries(opts.endpointKinds ?? {}));
  }

  endpointKindFor(modelId?: string): 'chat' | 'responses' {
    if (modelId) {
      const lower = modelId.toLowerCase();
      for (const [pattern, kind] of this.endpointKinds) {
        if (lower.includes(pattern.toLowerCase())) return kind;
      }
    }
    return 'chat';
  }

  effectiveTransport(modelId?: string): ResolvedTransport {
    // The isolated canary may point active adapters at a
    // loopback fixture. It is opt-in, loopback-only, and rejected unless the
    // process explicitly declares canary mode; production routing keeps the
    // registered HTTPS endpoint and settings validation unchanged.
    const canaryUrl = process.env.GLORYAPI_CANARY_UPSTREAM_URL?.trim();
    const canaryPlatforms = new Set(['andoryyu', 'opencode-zen', 'opencode-go']);
    if (canaryUrl && process.env.GLORYAPI_CANARY_MODE === '1' && canaryPlatforms.has(this.platform)) {
      let parsed: URL;
      try {
        parsed = new URL(canaryUrl);
      } catch {
        throw new Error('Invalid canary upstream URL');
      }
      if (parsed.protocol !== 'http:' || parsed.hostname !== '127.0.0.1') {
        throw new Error('Canary upstream must use loopback HTTP');
      }
      return {
        baseUrl: canaryUrl.replace(/\/$/, ''),
        timeoutMs: this.timeoutMs,
        modelAlias: null,
      };
    }

    try {
      const configured = getConfiguredProviderFromDb(getDb(), this.platform);
      if (configured && configured.enabled && configured.lifecycle === 'active') {
        return {
          baseUrl: configured.endpoint,
          timeoutMs: configured.timeoutMs,
          modelAlias: modelId ? configured.transport.modelAliases[modelId] ?? null : null,
        };
      }
    } catch {
      // Isolated provider tests may call an adapter before DB initialization.
    }

    try {
      const configured = getEffectiveProviderModelSettings(this.platform, modelId);
      if (configured) {
        if (configured.authScheme !== 'bearer') {
          throw new Error(`${this.name} does not support the configured authentication scheme`);
        }
        return configured;
      }
    } catch (error) {
      if (error instanceof Error && error.message.includes('authentication scheme')) throw error;
      // Isolated adapter unit tests may not initialize SQLite; static adapter
      // defaults remain safe and deterministic in that context.
    }
    return { baseUrl: this.baseUrl, timeoutMs: this.timeoutMs, modelAlias: null };
  }

  /* Map the catalog model_id to the upstream model ID if an alias exists. */
  upstreamModelId(modelId: string, transport = this.effectiveTransport(modelId)): string {
    const configuredModel = transport.modelAlias ?? modelId;
    return this.modelAliases[configuredModel] ?? configuredModel;
  }
}

export type ReasoningEffort = 'low' | 'medium' | 'high' | 'max';

/* Clamp reasoning_effort. Checks per-model limits first (substring match on
 * model ID), then falls back to the provider default. 'max' is non-standard;
 * models/providers that don't support it get it mapped down. */
export function clampReasoningEffort(
  effort: string | undefined,
  modelId: string | undefined,
  modelLimits: Map<string, ReasoningEffort>,
  providerDefault: ReasoningEffort,
): string | undefined {
  if (!effort) return undefined;
  const order = ['low', 'medium', 'high', 'max'];
  const curIdx = order.indexOf(effort);
  if (curIdx < 0) return undefined;

  // Check per-model overrides first
  if (modelId) {
    const lowerModel = modelId.toLowerCase();
    for (const [pattern, limit] of modelLimits) {
      if (lowerModel.includes(pattern.toLowerCase())) {
        const limitIdx = order.indexOf(limit);
        return curIdx > limitIdx ? limit : effort;
      }
    }
  }

  // Fall back to provider default
  const maxIdx = order.indexOf(providerDefault);
  return curIdx > maxIdx ? providerDefault : effort;
}
