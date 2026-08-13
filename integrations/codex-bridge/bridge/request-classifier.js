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
  const defaultTitleModels = Array.isArray(options.defaultTitleModels) && options.defaultTitleModels.length
    ? options.defaultTitleModels
    : DEFAULT_TITLE_MODELS;
  const titleModels = parseModelSet(
    options.titleModels || process.env.BRIDGE_TITLE_MODEL_ALIASES,
    defaultTitleModels,
  );
  const duplicateWindowMs = boundedInteger(
    options.duplicateWindowMs ?? process.env.BRIDGE_TITLE_DUPLICATE_WINDOW_MS,
    15000,
    1000,
    60000,
  );
  const maxRecentEntries = boundedInteger(
    options.maxRecentEntries ?? process.env.BRIDGE_CLASSIFIER_MAX_RECENT_ENTRIES,
    256,
    8,
    4096,
  );
  const recent = new Map();
  let nextLeaseId = 1;

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

    // Codex Desktop can ask one or more picker aliases to process the same
    // initial input while creating a thread. Require an earlier request with
    // the exact same user fingerprint but a different model: the first
    // explicit request to any selectable model must always remain the main
    // request. The alias set comes from the versioned catalog and remains
    // overridable for other clients/providers. Until Desktop exposes a
    // request-purpose signal, an intentional concurrent replay of the exact
    // prompt on another model is indistinguishable and follows this rule.
    if (
      fingerprint &&
      titleModels.has(model) &&
      previous &&
      previous.model &&
      previous.active === true &&
      previous.model !== model &&
      now - previous.at <= duplicateWindowMs
    ) {
      kind = 'auxiliary_title';
      reason = 'repeated_input_with_title_alias';
    }

    let leaseId = null;
    if (fingerprint && kind === 'main') {
      if (!recent.has(fingerprint) && recent.size >= maxRecentEntries) {
        const oldestFingerprint = recent.keys().next().value;
        if (oldestFingerprint) recent.delete(oldestFingerprint);
      }
      leaseId = nextLeaseId++;
      recent.delete(fingerprint);
      recent.set(fingerprint, { at: now, model, active: true, leaseId });
    }
    return { kind, reason, fingerprint, model, leaseId };
  }

  function complete(classification) {
    if (!classification?.fingerprint || !classification.leaseId) return false;
    const current = recent.get(classification.fingerprint);
    if (!current || current.leaseId !== classification.leaseId) return false;
    recent.delete(classification.fingerprint);
    return true;
  }

  function stats() {
    return { recentEntries: recent.size, maxRecentEntries };
  }

  function reset() {
    recent.clear();
  }

  return { classify, complete, reset, stats, titleModels, duplicateWindowMs, maxRecentEntries };
}

module.exports = { createRequestClassifier, requestFingerprint, userTextForFingerprint };
