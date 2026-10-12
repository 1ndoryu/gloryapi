// Codex Responses sends the picker value as `reasoning.effort`. Keep the
// legacy flat field too because some clients/profiles send
// `reasoning_effort` directly. GloryAPI intentionally accepts only its
// canonical four values; aliases are normalized here at the client boundary.
function normalizeReasoningEffort(value) {
  if (typeof value !== 'string') return undefined;
  switch (value.trim().toLowerCase()) {
    case 'minimal': return 'low';
    case 'low': return 'low';
    case 'medium': return 'medium';
    case 'high': return 'high';
    case 'max': return 'max';
    case 'xhigh':
    case 'ultra': return 'max';
    case 'none':
    case 'off': return undefined;
    default: return undefined;
  }
}

function requestReasoningEffort(body, selection) {
  if (!selection.supportsReasoning) return undefined;
  const nested = body.reasoning && typeof body.reasoning === 'object'
    ? body.reasoning.effort
    : undefined;
  return normalizeReasoningEffort(nested ?? body.reasoning_effort);
}

function extractReasoningText(item) {
  const parts = [];
  for (const s of item.summary || []) {
    if (s && typeof s.text === 'string' && s.text) parts.push(s.text);
  }
  for (const c of item.content || []) {
    // Codex reasoning items carry `reasoning_text` content, not output_text.
    if (c && typeof c.text === 'string' && c.text &&
        (c.type === 'output_text' || c.type === 'input_text' || c.type === 'reasoning_text')) {
      parts.push(c.text);
    }
  }
  return parts.join('\n') || null;
}

module.exports = { normalizeReasoningEffort, requestReasoningEffort, extractReasoningText };
