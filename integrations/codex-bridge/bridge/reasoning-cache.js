const fs = require('node:fs');

function createReasoningCache({ file, fallback, log, maxEntries = 2000 }) {
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
        fs.writeFileSync(file, JSON.stringify(Object.fromEntries(values)));
      } catch {}
    }, 800);
  }

  function load() {
    let changed = false;
    try {
      const raw = fs.readFileSync(file, 'utf8');
      const obj = JSON.parse(raw);
      for (const [key, value] of Object.entries(obj)) {
        const visible = typeof value === 'string' ? visibleReasoning(value) : '';
        if (visible) values.set(key, visible);
        if (visible !== value) changed = true;
      }
      if (values.size && log) log(`reasoning cache loaded: ${values.size} entries`);
    } catch {}
    if (changed) scheduleSave();
  }

  function remember(callId, text) {
    const visible = visibleReasoning(text);
    if (!callId || !visible) return;
    values.set(callId, visible);
    if (values.size > maxEntries) values.delete(values.keys().next().value);
    scheduleSave();
  }

  function get(callId) {
    if (callId && values.has(callId)) return visibleReasoning(values.get(callId));
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
