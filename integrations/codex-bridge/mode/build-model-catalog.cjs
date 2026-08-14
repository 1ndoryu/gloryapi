'use strict';

/**
 * Genera el catálogo de modelos que Codex Desktop muestra en el picker.
 *
 * Codex Desktop no usa `/v1/models` para su picker: consume `model_catalog_json`
 * (config.toml) que apunta a un `models.json`. El preparador del home aislado
 * copiaba el `models.json` normal (una sola entrada `deepseek-v4-flash`), por lo
 * que el picker nunca ofrecía CommandCode ni Muse. Este script genera un
 * `models.json` del bridge que conserva el modo Auto y publica únicamente los
 * modelos explícitos que la proyección persistida de GloryAPI conoce.
 *
 * Cada entrada se clona de la entrada real de Codex (para conservar
 * `base_instructions`, `model_messages` y el resto de metadatos) y solo se
 * sobrescriben identidad y capacidades: slug, display_name, description,
 * input_modalities, contexto y prioridad.
 *
 * Uso:
 *   node build-model-catalog.cjs <models.json-origen> <models.json-destino> [models_cache.json-destino] [cache-meta-origen]
 */

const fs = require('node:fs');
const path = require('node:path');
const { DEFAULT_MODEL_CATALOG, AUTO_MODEL_ID, AUTO_PICKER_ID } = require('../bridge/model-catalog.js');

const DESCRIPTIONS = {
  auto: 'Selección automática: GloryAPI elige el proveedor disponible.',
  'deepseek/deepseek-v4-flash': 'DeepSeek V4 Flash a través de CommandCode.',
  'meta/muse-spark-1.2-contributor': 'Muse Spark 1.2 Contributor a través de CommandCode (visión nativa).',
};

// Entrada mínima válida (schema documentado por Codex) usada solo si el home
// normal no aporta un template real del que clonar.
function minimalTemplate() {
  return {
    slug: 'auto',
    prefer_websockets: false,
    support_verbosity: true,
    default_verbosity: 'low',
    apply_patch_tool_type: 'freeform',
    web_search_tool_type: 'text',
    input_modalities: ['text'],
    supports_image_detail_original: false,
    truncation_policy: { mode: 'tokens', limit: 10000 },
    supports_parallel_tool_calls: true,
    tool_mode: null,
    multi_agent_version: 'v2',
    use_responses_lite: false,
    include_skills_usage_instructions: false,
    auto_review_model_override: null,
    context_window: 150000,
    max_context_window: 150000,
    effective_context_window_percent: 100,
    auto_compact_token_limit: 150000,
    reasoning_summary_format: 'experimental',
    default_reasoning_summary: 'none',
    display_name: 'Auto (router de GloryAPI)',
    description: 'Auto (router de GloryAPI)',
    default_reasoning_level: 'high',
    supported_reasoning_levels: [
      { effort: 'low', description: 'Fast responses with lighter reasoning' },
      { effort: 'high', description: 'Extra high reasoning depth for complex problems' },
      { effort: 'max', description: 'Maximum reasoning depth for the hardest problems' },
    ],
    shell_type: 'shell_command',
    visibility: 'list',
    minimal_client_version: '0.144.0',
    supported_in_api: true,
    availability_nux: null,
    upgrade: null,
    priority: 1,
    model_messages: {
      instructions_template: '',
      instructions_variables: {
        personality_default: '',
        personality_friendly: '',
        personality_pragmatic: '',
      },
      approvals: null,
    },
    experimental_supported_tools: [],
    supports_search_tool: true,
    default_service_tier: null,
    supports_reasoning_summaries: true,
    base_instructions: 'You are Codex, an AI coding agent.',
  };
}

function loadTemplate(sourcePath) {
  if (sourcePath && fs.existsSync(sourcePath)) {
    try {
      const parsed = JSON.parse(fs.readFileSync(sourcePath, 'utf8'));
      const models = Array.isArray(parsed && parsed.models) ? parsed.models : [];
      const preferred = models.find((entry) => entry && entry.slug === 'auto');
      const template = preferred || models[0];
      if (template && typeof template === 'object') return template;
    } catch {
      // Un models.json corrupto no debe bloquear el arranque del bridge.
    }
  }
  return minimalTemplate();
}

function loadCatalogOverride(catalogPath) {
  if (!catalogPath || !fs.existsSync(catalogPath)) return null;
  try {
    const parsed = JSON.parse(fs.readFileSync(catalogPath, 'utf8'));
    const rows = Array.isArray(parsed) ? parsed : parsed && Array.isArray(parsed.entries) ? parsed.entries : null;
    if (!rows || rows.length === 0) return null;
    const entries = rows.map((row) => ({
      id: String(row.id || '').trim(),
      pickerId: row.pickerId ? String(row.pickerId).trim() : null,
      provider: String(row.provider || 'auto').trim(),
      displayName: String(row.displayName || row.id || '').trim(),
      nativeVision: row.nativeVision === true,
      supportsReasoning: row.supportsReasoning === true,
      // The bridge catalog has one operational compaction ceiling for every
      // selectable model. Provider-specific physical limits stay in GloryAPI.
      contextWindow: 150000,
    })).filter((row) => row.id && row.displayName).map((row) => ({
      ...row,
      // Normalize the persisted internal Auto alias before writing the
      // Desktop catalog. The database remains backwards compatible.
      pickerId: row.id === AUTO_MODEL_ID && (!row.pickerId || row.pickerId === 'codex-auto-review')
        ? AUTO_PICKER_ID
        : row.pickerId,
    }));
    if (entries.length === 0) return null;
    if (!entries.some((entry) => entry.id === 'auto')) {
      const auto = DEFAULT_MODEL_CATALOG.find((entry) => entry.id === 'auto');
      entries.unshift({ ...auto, id: 'auto', pickerId: auto.pickerId, provider: 'auto', displayName: auto.displayName });
    }
    const pickerIds = new Set();
    for (const entry of entries) {
      if (!entry.pickerId) throw new Error(`catalog entry '${entry.id}' has no Desktop pickerId`);
      if (pickerIds.has(entry.pickerId)) throw new Error(`Desktop pickerId '${entry.pickerId}' is duplicated`);
      pickerIds.add(entry.pickerId);
    }
    return entries;
  } catch (error) {
    throw new Error(`invalid bridge catalog override: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function cloneEntry(template, catalogEntry, index) {
  if (!catalogEntry.pickerId) throw new Error(`bridge catalog entry '${catalogEntry.id}' has no Desktop pickerId`);
  const entry = JSON.parse(JSON.stringify(template));
  const contextWindow = 150000;
  const nativeVision = catalogEntry.nativeVision === true;
  // Desktop filters reserved/internal ids from its renderer. Keep the real
  // id in the bridge catalog, but expose the visible bridge-owned picker ids
  // in the local Desktop catalog. The persisted codex-auto-review alias is
  // normalized to the visible gpt-5.6-auto alias above and remains accepted
  // at the bridge.
  entry.slug = catalogEntry.pickerId || (catalogEntry.id === AUTO_MODEL_ID ? AUTO_PICKER_ID : catalogEntry.id);
  entry.display_name = catalogEntry.displayName;
  entry.description = DESCRIPTIONS[catalogEntry.id] || catalogEntry.displayName;
  entry.input_modalities = nativeVision ? ['text', 'image'] : ['text'];
  entry.supports_image_detail_original = nativeVision;
  entry.supports_reasoning = catalogEntry.supportsReasoning === true;
  if (catalogEntry.supportsReasoning) {
    // Minimal/source templates may omit reasoning metadata. Keep the picker
    // usable with the same conservative levels as the bundled template.
    entry.default_reasoning_level = entry.default_reasoning_level || 'high';
    entry.supported_reasoning_levels = Array.isArray(entry.supported_reasoning_levels)
      && entry.supported_reasoning_levels.length
      ? entry.supported_reasoning_levels
      : [
          { effort: 'low', description: 'Fast responses with lighter reasoning' },
          { effort: 'high', description: 'Extra high reasoning depth for complex problems' },
          { effort: 'max', description: 'Maximum reasoning depth for the hardest problems' },
        ];
    entry.reasoning_summary_format = entry.reasoning_summary_format || 'experimental';
    entry.supports_reasoning_summaries = entry.supports_reasoning_summaries !== false;
  } else {
    // The effort selector is a shared Desktop control, but unsupported models
    // must not advertise a reasoning level that the bridge would silently drop.
    entry.default_reasoning_level = 'none';
    entry.supported_reasoning_levels = [];
    entry.reasoning_summary_format = 'none';
    entry.supports_reasoning_summaries = false;
  }
  entry.context_window = contextWindow;
  entry.max_context_window = contextWindow;
  entry.auto_compact_token_limit = contextWindow;
  entry.priority = index;
  entry.visibility = 'list';
  entry.supported_in_api = true;
  return entry;
}

function writeAtomic(target, content) {
  const temporary = `${target}.tmp.${process.pid}`;
  fs.writeFileSync(temporary, content, 'utf8');
  fs.renameSync(temporary, target);
}

function loadCacheEnvelope(cachePath) {
  if (!cachePath || !fs.existsSync(cachePath)) return {};
  try {
    const parsed = JSON.parse(fs.readFileSync(cachePath, 'utf8'));
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      const metadata = { ...parsed };
      delete metadata.models;
      return metadata;
    }
  } catch {
    // Una caché corrupta no debe impedir que el bridge regenere su catálogo.
  }
  return {};
}

function resolveCacheMetadata(cachePath, metadataSourcePath) {
  const metadata = loadCacheEnvelope(cachePath);
  if (Object.keys(metadata).length > 0) return metadata;
  return loadCacheEnvelope(metadataSourcePath);
}

function main() {
  const [, , sourcePathArg, outputPathArg, cachePathArg, cacheMetadataSourceArg, catalogOverridePathArg] = process.argv;
  if (!outputPathArg) {
    process.stderr.write('Usage: node build-model-catalog.cjs <models.json-origen> <models.json-destino> [models_cache.json-destino] [cache-meta-origen]\n');
    process.exitCode = 2;
    return;
  }
  const sourcePath = sourcePathArg && sourcePathArg !== '-' ? sourcePathArg : null;
  const outputPath = path.resolve(outputPathArg);
  const template = loadTemplate(sourcePath);

  const effectiveCatalog = loadCatalogOverride(catalogOverridePathArg) || DEFAULT_MODEL_CATALOG;
  const byId = new Map(effectiveCatalog.map((entry) => [entry.id, entry]));
  const models = effectiveCatalog.map((entry, index) => {
    const id = entry.id;
    const catalogEntry = byId.get(id);
    if (!catalogEntry) throw new Error(`bridge catalog is missing picker model: ${id}`);
    return cloneEntry(template, catalogEntry, index);
  });

  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  writeAtomic(outputPath, JSON.stringify({ models }, null, 2));
  if (cachePathArg && cachePathArg !== '-') {
    const cachePath = path.resolve(cachePathArg);
    const cache = {
      ...resolveCacheMetadata(cachePath, cacheMetadataSourceArg),
      fetched_at: new Date().toISOString(),
      etag: null,
      // Codex rejects model-cache records without the client version on a
      // first launch. The source cache supplies it without copying its models.
      client_version: resolveCacheMetadata(cachePath, cacheMetadataSourceArg).client_version || '0.147.0',
      models,
    };
    fs.mkdirSync(path.dirname(cachePath), { recursive: true });
    writeAtomic(cachePath, JSON.stringify(cache, null, 2));
  }
  process.stdout.write(`bridge model catalog written: ${models.length} models${cachePathArg && cachePathArg !== '-' ? ' (models_cache.json updated)' : ''}\n`);
}

main();
