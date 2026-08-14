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
 *   - wireModel:   canonical route/model sent upstream (presentation aliases
 *                  such as DeepSeek Flash (Auto) use `auto`).
 *   - pickerId:     optional Desktop-safe id used only by the model picker.
 *   - provider:    owning provider slug (or 'auto' for the router default).
 *   - displayName: human-readable Spanish label for the model picker.
 *   - nativeVision: true when the model accepts image_url blocks natively.
 *                  When false the bridge keeps the lossy text adaptation.
 *   - supportsReasoning: true when the model/provider accepts the effort
 *                        control. The translator uses this as a local
 *                        fail-closed guard before sending reasoning_effort.
 *   - contextWindow: informational token window for the picker (nullable).
 */

const MODEL_CATALOG_SCHEMA = 'glory-bridge-model-catalog-v2';
const AUTO_MODEL_ID = 'auto';
// Desktop's native "Reset to default" action selects gpt-5.6-sol. Reserve
// that picker id for the canonical Auto route; assigning it to a physical
// provider makes the native reset silently pin that provider instead.
const AUTO_PICKER_ID = 'gpt-5.6-sol';
const LEGACY_AUTO_PICKER_IDS = new Set(['codex-auto-review']);
// Desktop must see one conservative threshold for every provider/model. The
// upstreams may advertise larger windows, but the bridge needs Codex to
// autocompact before those large histories degrade the provider loop.
const BRIDGE_CONTEXT_WINDOW = 150000;
const MAX_CATALOG_ENTRIES = 64;
const MODEL_ID_PATTERN = /^[A-Za-z0-9._:/-]{1,128}$/;
const PROVIDER_PATTERN = /^(auto|[a-z][a-z0-9-]{0,63})$/;

// `auto` is the only compiled fallback. Provider/model rows belong to
// GloryAPI's persisted catalog projection. If that projection is unavailable,
// the bridge stays safe and predictable with an Auto-only picker.
const DEFAULT_MODEL_CATALOG = [
  {
    id: 'auto',
    pickerId: AUTO_PICKER_ID,
    provider: 'auto',
    wireModel: 'auto',
    displayName: 'Auto (router de GloryAPI)',
    nativeVision: false,
    supportsReasoning: true,
    contextWindow: BRIDGE_CONTEXT_WINDOW,
  },
];

function normalizeEntry(raw, index) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const id = typeof raw.id === 'string' ? raw.id.trim() : '';
  const wireModel = typeof raw.wireModel === 'string' && raw.wireModel.trim() ? raw.wireModel.trim() : id;
  const provider = typeof raw.provider === 'string' ? raw.provider.trim().toLowerCase() : '';
  const displayName = typeof raw.displayName === 'string' ? raw.displayName.trim().slice(0, 128) : '';
  const rawPickerId = raw.pickerId == null ? null : (typeof raw.pickerId === 'string' ? raw.pickerId.trim() : '');
  const pickerId = id === AUTO_MODEL_ID && (!rawPickerId || LEGACY_AUTO_PICKER_IDS.has(rawPickerId))
    ? AUTO_PICKER_ID
    : rawPickerId;
  if (!MODEL_ID_PATTERN.test(id) || !MODEL_ID_PATTERN.test(wireModel) || !PROVIDER_PATTERN.test(provider) || !displayName) return null;
  if (pickerId !== null && !MODEL_ID_PATTERN.test(pickerId)) return null;
  const contextWindow = BRIDGE_CONTEXT_WINDOW;
  return {
    id,
    wireModel,
    pickerId,
    provider,
    displayName,
    nativeVision: raw.nativeVision === true,
    supportsReasoning: raw.supportsReasoning === true || raw.reasoning === true,
    contextWindow,
  };
}

function parseModelCatalogDetailed(raw) {
  const stale = () => ({ entries: DEFAULT_MODEL_CATALOG, state: 'stale', revision: null, hash: null });
  if (!raw) return stale();
  let rows;
  let envelope = null;
  try {
    rows = JSON.parse(raw);
  } catch {
    return stale();
  }
  // GloryAPI persists the catalog as a signed revision envelope. Keep the
  // array form for local tests and hand-written overrides, but consume the
  // same envelope that the launcher syncs from the database.
  if (!Array.isArray(rows) && rows && typeof rows === 'object' && Array.isArray(rows.entries)) {
    envelope = rows;
    rows = rows.entries;
  }
  if (!Array.isArray(rows)) return stale();
  const entries = [];
  const seen = new Set();
  for (let index = 0; index < rows.length && entries.length < MAX_CATALOG_ENTRIES; index++) {
    const entry = normalizeEntry(rows[index], index);
    if (!entry || seen.has(entry.id)) continue;
    seen.add(entry.id);
    entries.push(entry);
  }
  if (entries.length === 0) return stale();
  // `auto` must always be present so the picker keeps a safe default. If the
  // override omits it, prepend it so selection can never become undefined.
  if (!entries.some((entry) => entry.id === AUTO_MODEL_ID)) {
    entries.unshift({
      id: AUTO_MODEL_ID,
      pickerId: AUTO_PICKER_ID,
      wireModel: AUTO_MODEL_ID,
      provider: 'auto',
      displayName: 'Auto (router de GloryAPI)',
      nativeVision: false,
      supportsReasoning: true,
      contextWindow: BRIDGE_CONTEXT_WINDOW,
    });
  }
  return {
    entries,
    state: envelope?.state === 'published' ? 'published' : (envelope ? 'stale' : 'override'),
    revision: Number.isSafeInteger(envelope?.revision) ? envelope.revision : null,
    hash: typeof envelope?.hash === 'string' ? envelope.hash : null,
  };
}

function parseModelCatalog(raw) {
  return parseModelCatalogDetailed(raw).entries;
}

/**
 * Map the client's requested model (body.model in the Responses request) to
 * the wire model id and its native-vision capability.
 *
 * - missing / Auto picker ids -> the canonical `auto` route.
 * - known catalog id -> that exact wire id + its nativeVision flag.
 * - unknown id        -> pass through unchanged (GloryAPI returns the
 *   structured model_not_found error) with fail-closed lossy vision: never
 *   forward images natively to a model whose vision is unverified.
 */
function resolveModelSelection(catalog, requestedModel, defaultModel) {
  const requested = typeof requestedModel === 'string' && requestedModel.trim()
    ? requestedModel.trim()
    : '';
  if (!requested || requested === AUTO_MODEL_ID || requested === AUTO_PICKER_ID || LEGACY_AUTO_PICKER_IDS.has(requested)) {
    const autoEntry = catalog.find((candidate) => candidate.id === AUTO_MODEL_ID);
    return {
      id: AUTO_MODEL_ID,
      provider: 'auto',
      nativeVision: false,
      supportsReasoning: autoEntry?.supportsReasoning === true,
      explicit: false,
    };
  }
  const entry = catalog.find((candidate) => candidate.id === requested || candidate.pickerId === requested);
  if (entry) {
    return {
      id: entry.wireModel || entry.id,
      provider: entry.provider,
      nativeVision: entry.nativeVision === true,
      supportsReasoning: entry.supportsReasoning === true,
      explicit: true,
    };
  }
  return { id: requested, provider: 'unknown', nativeVision: false, supportsReasoning: false, explicit: true };
}

/**
 * Return the identifier that Codex Desktop should persist for a response.
 *
 * GloryAPI may report the physical upstream model (for example
 * `deepseek-v4-flash`) after routing `auto`. That identifier is deliberately
 * not part of the Desktop catalog and makes Codex fall back to its built-in
 * context window. Keep the upstream wire id in `chat.model`, but expose only
 * the catalog picker id in response metadata. Unknown legacy ids are treated
 * as the visible Auto picker id because they can only come from a pre-catalog
 * bridge session; the upstream request itself remains unchanged.
 */
function resolvePresentationModel(catalog, requestedModel) {
  const requested = typeof requestedModel === 'string' && requestedModel.trim()
    ? requestedModel.trim()
    : '';
  const entry = catalog.find((candidate) => candidate.id === requested || candidate.pickerId === requested);
  if (entry) return entry.pickerId || entry.id;
  const autoEntry = catalog.find((candidate) => candidate.id === AUTO_MODEL_ID);
  return autoEntry?.pickerId || AUTO_PICKER_ID;
}

function hasNativeVision(catalog, modelId) {
  const entry = catalog.find((candidate) => candidate.id === modelId);
  return Boolean(entry && entry.nativeVision === true);
}

module.exports = {
  MODEL_CATALOG_SCHEMA,
  AUTO_MODEL_ID,
  AUTO_PICKER_ID,
  BRIDGE_CONTEXT_WINDOW,
  DEFAULT_MODEL_CATALOG,
  parseModelCatalog,
  parseModelCatalogDetailed,
  resolveModelSelection,
  resolvePresentationModel,
  hasNativeVision,
};
