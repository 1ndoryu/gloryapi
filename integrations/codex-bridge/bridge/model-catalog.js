'use strict';

/**
 * Versioned model catalog for the bridge's model selector.
 *
 * The bridge is provider-agnostic: the selectable models, their wire ids and
 * their native-vision capability live in this versioned contract instead of
 * scattered conditionals in server.js. The catalog is overridable via
 * BRIDGE_MODEL_CATALOG_JSON (same shape, versioned) so a different upstream
 * does not require code changes.
 *
 * Each entry:
 *   - id:          wire model id sent to the upstream chat/completions API.
 *   - pickerId:     optional Desktop-safe id used only by the model picker.
 *   - provider:    owning provider slug (or 'auto' for the router default).
 *   - displayName: human-readable Spanish label for the model picker.
 *   - nativeVision: true when the model accepts image_url blocks natively.
 *                  When false the bridge keeps the lossy text adaptation.
 *   - contextWindow: informational token window for the picker (nullable).
 */

const MODEL_CATALOG_SCHEMA = 'glory-bridge-model-catalog-v1';
const AUTO_MODEL_ID = 'auto';
const MAX_CATALOG_ENTRIES = 64;
const MODEL_ID_PATTERN = /^[A-Za-z0-9._:/-]{1,128}$/;
const PROVIDER_PATTERN = /^(auto|[a-z][a-z0-9-]{0,63})$/;

// `auto` resolves to `config.upstream.model` (the current default) and keeps
// the existing GloryAPI routing/fallback chain. The explicit rows below mirror
// the catalog GloryAPI already exposes plus the three CommandCode models the
// user can pin. Muse Spark 1.2 is the only native-vision model in this set.
const DEFAULT_MODEL_CATALOG = [
  {
    id: 'auto',
    pickerId: 'codex-auto-review',
    provider: 'auto',
    displayName: 'Auto (router de GloryAPI)',
    nativeVision: false,
    contextWindow: null,
  },
  {
    id: 'deepseek-v4-flash',
    pickerId: 'gpt-5.4',
    provider: 'auto',
    displayName: 'DeepSeek V4 Flash (Auto)',
    nativeVision: false,
    contextWindow: null,
  },
  {
    id: 'deepseek-v4-flash-free',
    pickerId: 'gpt-5.6-sol-wm',
    provider: 'opencode-zen',
    displayName: 'DeepSeek V4 Flash (OpenCode Zen)',
    nativeVision: false,
    contextWindow: null,
  },
  {
    id: 'deepseek-v4-flash:free',
    pickerId: 'gpt-5.5',
    provider: 'tokenharbor',
    displayName: 'DeepSeek V4 Flash (TokenHarbor Free)',
    nativeVision: false,
    contextWindow: null,
  },
  {
    id: 'deepseek/deepseek-v4-flash',
    pickerId: 'gpt-5.6-sol',
    provider: 'commandcode',
    displayName: 'DeepSeek V4 Flash (CommandCode)',
    nativeVision: false,
    contextWindow: 1048576,
  },
  {
    id: 'meta/muse-spark-1.2-contributor',
    pickerId: 'gpt-5.6-terra',
    provider: 'commandcode',
    displayName: 'Muse Spark 1.2 Contributor (CommandCode)',
    nativeVision: true,
    contextWindow: 1050000,
  },
  {
    id: 'deepseek/deepseek-v4-pro',
    pickerId: 'gpt-5.6-luna',
    provider: 'commandcode',
    displayName: 'DeepSeek V4 Pro (CommandCode)',
    nativeVision: false,
    contextWindow: 1048576,
  },
];

function normalizeEntry(raw, index) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const id = typeof raw.id === 'string' ? raw.id.trim() : '';
  const provider = typeof raw.provider === 'string' ? raw.provider.trim().toLowerCase() : '';
  const displayName = typeof raw.displayName === 'string' ? raw.displayName.trim().slice(0, 128) : '';
  const pickerId = raw.pickerId == null ? null : (typeof raw.pickerId === 'string' ? raw.pickerId.trim() : '');
  if (!MODEL_ID_PATTERN.test(id) || !PROVIDER_PATTERN.test(provider) || !displayName) return null;
  if (pickerId !== null && !MODEL_ID_PATTERN.test(pickerId)) return null;
  const contextWindow = raw.contextWindow == null || Number.isSafeInteger(raw.contextWindow)
    ? (Number.isSafeInteger(raw.contextWindow) ? raw.contextWindow : null)
    : null;
  return {
    id,
    pickerId,
    provider,
    displayName,
    nativeVision: raw.nativeVision === true,
    contextWindow,
  };
}

function parseModelCatalog(raw) {
  if (!raw) return DEFAULT_MODEL_CATALOG;
  let rows;
  try {
    rows = JSON.parse(raw);
  } catch {
    return DEFAULT_MODEL_CATALOG;
  }
  if (!Array.isArray(rows)) return DEFAULT_MODEL_CATALOG;
  const entries = [];
  const seen = new Set();
  for (let index = 0; index < rows.length && entries.length < MAX_CATALOG_ENTRIES; index++) {
    const entry = normalizeEntry(rows[index], index);
    if (!entry || seen.has(entry.id)) continue;
    seen.add(entry.id);
    entries.push(entry);
  }
  if (entries.length === 0) return DEFAULT_MODEL_CATALOG;
  // `auto` must always be present so the picker keeps a safe default. If the
  // override omits it, prepend it so selection can never become undefined.
  if (!entries.some((entry) => entry.id === AUTO_MODEL_ID)) {
    entries.unshift({
      id: AUTO_MODEL_ID,
      provider: 'auto',
      displayName: 'Auto (router de GloryAPI)',
      nativeVision: false,
      contextWindow: null,
    });
  }
  return entries;
}

/**
 * Map the client's requested model (body.model in the Responses request) to
 * the wire model id and its native-vision capability.
 *
 * - missing / 'auto' -> the configured default model (current behavior).
 * - known catalog id -> that exact wire id + its nativeVision flag.
 * - unknown id        -> pass through unchanged (GloryAPI returns the
 *   structured model_not_found error) with fail-closed lossy vision: never
 *   forward images natively to a model whose vision is unverified.
 */
function resolveModelSelection(catalog, requestedModel, defaultModel) {
  const requested = typeof requestedModel === 'string' && requestedModel.trim()
    ? requestedModel.trim()
    : '';
  if (!requested || requested === AUTO_MODEL_ID) {
    return { id: defaultModel, provider: 'auto', nativeVision: false, explicit: false };
  }
  const entry = catalog.find((candidate) => candidate.id === requested || candidate.pickerId === requested);
  if (entry) {
    return {
      id: entry.id,
      provider: entry.provider,
      nativeVision: entry.nativeVision === true,
      explicit: true,
    };
  }
  return { id: requested, provider: 'unknown', nativeVision: false, explicit: true };
}

function hasNativeVision(catalog, modelId) {
  const entry = catalog.find((candidate) => candidate.id === modelId);
  return Boolean(entry && entry.nativeVision === true);
}

module.exports = {
  MODEL_CATALOG_SCHEMA,
  AUTO_MODEL_ID,
  DEFAULT_MODEL_CATALOG,
  parseModelCatalog,
  resolveModelSelection,
  hasNativeVision,
};
