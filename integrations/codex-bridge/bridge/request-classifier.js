const crypto = require('node:crypto');

const DEFAULT_TITLE_MODELS = Object.freeze(['gpt-5.6-luna']);

function textFromContent(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((part) => part && typeof part.text === 'string' ? part.text : '')
    .filter(Boolean)
    .join('\n');
}

function userTextForFingerprint(body) {
  const parts = [];
  for (const item of Array.isArray(body && body.input) ? body.input : []) {
    if (!item || item.type !== 'message' || item.role !== 'user') continue;
    const text = textFromContent(item.content).trim();
    if (text) parts.push(text.slice(0, 4000));
  }
  return parts.slice(-3).join('\n---\n');
}

function requestFingerprint(body) {
  const text = userTextForFingerprint(body);
  if (!text) return null;
  return crypto.createHash('sha256').update(text, 'utf8').digest('hex').slice(0, 24);
}

function structuredTitleSchema(body) {
  const format = body?.text?.format;
  const schema = format?.schema;
  const properties = schema?.properties;
  const required = Array.isArray(schema?.required) ? schema.required : [];
  if (
    format?.type !== 'json_schema' ||
    format?.name !== 'codex_output_schema' ||
    format?.strict !== true ||
    schema?.type !== 'object' ||
    schema?.additionalProperties !== false ||
    properties?.title?.type !== 'string' ||
    properties?.description?.type !== 'string' ||
    !required.includes('title') ||
    !required.includes('description')
  ) return null;
  return schema;
}

function isStructuredTitleRequest(body) {
  return structuredTitleSchema(body) !== null;
}

function parseModelSet(raw, fallback) {
  if (Array.isArray(raw)) return new Set(raw.filter((value) => typeof value === 'string' && value.trim()).map((value) => value.trim()));
  if (typeof raw === 'string' && raw.trim()) {
    const values = raw.split(',').map((value) => value.trim()).filter(Boolean);
    if (values.length) return new Set(values);
  }
  return new Set(fallback);
}

function createRequestClassifier(options = {}) {
  const defaultTitleModels = Array.isArray(options.defaultTitleModels) && options.defaultTitleModels.length
    ? options.defaultTitleModels
    : DEFAULT_TITLE_MODELS;
  const titleModels = parseModelSet(
    options.titleModels || process.env.BRIDGE_TITLE_MODEL_ALIASES,
    defaultTitleModels,
  );
  function classify(body) {
    const model = typeof body?.model === 'string' ? body.model.trim() : '';
    const fingerprint = requestFingerprint(body);

    // Codex Desktop creates a separate low-effort thread for title generation.
    // Its prompt is not the user's prompt, so text fingerprints cannot relate
    // it to the visible turn. The strict title+description output contract is
    // the stable purpose signal observed on the wire.
    if (titleModels.has(model) && isStructuredTitleRequest(body)) {
      return {
        kind: 'auxiliary_title',
        reason: 'structured_title_schema',
        fingerprint,
        model,
        leaseId: null,
      };
    }

    return { kind: 'main', reason: 'default', fingerprint, model, leaseId: null };
  }

  return { classify, titleModels };
}

module.exports = {
  createRequestClassifier,
  isStructuredTitleRequest,
  requestFingerprint,
  structuredTitleSchema,
  userTextForFingerprint,
};
