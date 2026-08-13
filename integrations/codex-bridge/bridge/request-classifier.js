const crypto = require('node:crypto');

const DEFAULT_TITLE_MODELS = Object.freeze(['gpt-5.6-luna']);

function boundedInteger(value, fallback, min, max) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
}

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

function parseModelSet(raw, fallback) {
  if (Array.isArray(raw)) return new Set(raw.filter((value) => typeof value === 'string' && value.trim()).map((value) => value.trim()));
  if (typeof raw === 'string' && raw.trim()) {
    const values = raw.split(',').map((value) => value.trim()).filter(Boolean);
    if (values.length) return new Set(values);
  }
  return new Set(fallback);
}

function createRequestClassifier(options = {}) {
  const titleModels = parseModelSet(options.titleModels || process.env.BRIDGE_TITLE_MODEL_ALIASES, DEFAULT_TITLE_MODELS);
  const duplicateWindowMs = boundedInteger(
    options.duplicateWindowMs ?? process.env.BRIDGE_TITLE_DUPLICATE_WINDOW_MS,
    15000,
    1000,
    60000,
  );
  const recent = new Map();

  function prune(now) {
    for (const [fingerprint, entry] of recent) {
      if (now - entry.at > duplicateWindowMs) recent.delete(fingerprint);
    }
  }

  function classify(body, now = Date.now()) {
    prune(now);
    const model = typeof body?.model === 'string' ? body.model.trim() : '';
    const fingerprint = requestFingerprint(body);
    const previous = fingerprint ? recent.get(fingerprint) : null;
    let kind = 'main';
    let reason = 'default';

    // Codex Desktop asks a second model to title a new thread. The title call
    // repeats the latest user text shortly after the real request and uses the
    // Desktop alias gpt-5.6-luna. Require a different preceding model so a
    // user selecting Pro is never mistaken for a title on its first request.
    // This conservative rule removes the observed Flash -> Luna duplicate and
    // leaves uncertain requests upstream for later evidence.
    if (
      fingerprint &&
      titleModels.has(model) &&
      previous &&
      previous.model &&
      previous.model !== model &&
      now - previous.at <= duplicateWindowMs
    ) {
      kind = 'auxiliary_title';
      reason = 'repeated_input_with_title_alias';
    }

    if (fingerprint) recent.set(fingerprint, { at: now, model });
    return { kind, reason, fingerprint, model };
  }

  function reset() {
    recent.clear();
  }

  return { classify, reset, titleModels, duplicateWindowMs };
}

module.exports = { createRequestClassifier, requestFingerprint, userTextForFingerprint };
