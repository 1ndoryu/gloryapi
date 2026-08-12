const { readBoundedJson, writeJsonAtomic } = require('./atomic-json');

function createReasoningCache({
  file,
  fallback,
  log,
  maxEntries = 2000,
  maxBytes = 2 * 1024 * 1024,
  ttlMs = 6 * 60 * 60 * 1000,
  now = () => Date.now(),
}) {
  const values = new Map();

  function normalizeReasoningText(text) {
    return String(text == null ? '' : text).replace(/\s+/g, ' ').trim();
  }

  function removeSyntheticReasoning(text) {
    const value = String(text == null ? '' : text);
    const pattern = normalizeReasoningText(fallback)
      .split(' ')
      .map((word) => word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
      .join('\\s+');
    return value.replace(new RegExp(pattern, 'gi'), '').replace(/\s+/g, ' ').trim();
  }

  function isSyntheticReasoning(text) {
    return normalizeReasoningText(text) === normalizeReasoningText(fallback);
  }

  function visibleReasoning(text) {
    const value = typeof text === 'string' ? removeSyntheticReasoning(text) : '';
    return value && !isSyntheticReasoning(value) ? value : '';
  }

  let saveTimer = null;
  function scheduleSave() {
    if (saveTimer) return;
    saveTimer = setTimeout(() => {
      saveTimer = null;
      try {
        const payload = {};
        for (const [key, entry] of values) payload[key] = entry;
        writeJsonAtomic(file, payload, { maxBytes });
      } catch (error) {
        if (log) log(`reasoning cache write failed (${error && error.name ? error.name : 'error'})`);
      }
    }, 800);
  }

  function load() {
    let changed = false;
    try {
      const obj = readBoundedJson(file, maxBytes);
      if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return;
      for (const [key, value] of Object.entries(obj)) {
        const text = typeof value === 'string' ? value : value && value.text;
        const savedAt = typeof value === 'object' && value ? Number(value.savedAt) : 0;
        const expired = savedAt > 0 && now() - savedAt > ttlMs;
        const visible = expired ? '' : visibleReasoning(text);
        if (visible) values.set(key, { text: visible, savedAt: savedAt || now() });
        if (!visible || typeof value !== 'object' || value.text !== visible) changed = true;
      }
      if (values.size && log) log(`reasoning cache loaded: ${values.size} entries`);
    } catch {}
    if (changed) scheduleSave();
  }

  function remember(callId, text) {
    const visible = visibleReasoning(text);
    if (!callId || !visible) return;
    values.set(callId, { text: visible, savedAt: now() });
    if (values.size > maxEntries) values.delete(values.keys().next().value);
    while (Buffer.byteLength(JSON.stringify(Object.fromEntries(values)), 'utf8') > maxBytes && values.size > 1) {
      values.delete(values.keys().next().value);
    }
    scheduleSave();
  }

  function get(callId) {
    if (callId && values.has(callId)) {
      const entry = values.get(callId);
      if (now() - entry.savedAt > ttlMs) {
        values.delete(callId);
        scheduleSave();
        return null;
      }
      return visibleReasoning(entry.text);
    }
    return null;
  }

  load();
  return {
    fallback,
    normalizeReasoningText,
    visibleReasoning,
    rememberReasoning: remember,
    reasoningFor: get,
  };
}

module.exports = { createReasoningCache };
