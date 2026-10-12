function crearTokens(ctx) {
  const { MAX_SYSTEM_CHARS, log, DEFAULT_CALIB_RATIO, CALIB_MIN_HEUR, CALIB_OBSERVED_MIN, CALIB_OBSERVED_MAX } = ctx;

function estimateTokens(m) {
  let n = 4; // per-message overhead
  const count = (s) => Math.ceil((s || '').length / 4);
  if (typeof m.content === 'string') {
    n += count(m.content);
  } else if (Array.isArray(m.content)) {
    for (const p of m.content) n += count(p && p.text);
  }
  if (Array.isArray(m.tool_calls)) {
    for (const tc of m.tool_calls) {
      n += count(tc.function && tc.function.name) + count(tc.function && tc.function.arguments) + 6;
    }
  }
  n += count(m.reasoning_content);
  return n;
}

/**
 * Bound a system prompt that exceeds MAX_SYSTEM_CHARS. Codex Desktop inflates
 * the system prompt with browser-plugin documentation and tool training text;
 * forwarding it verbatim pushes DeepSeek past its window and it returns an
 * empty completion (stall). Cutting at line boundaries keeps code blocks and
 * JSON intact and preserves the head (critical instructions) plus the tail.
 * A trailing notice tells the model that mid-context was elided.
 */
function boundSystemContent(content, maxChars = MAX_SYSTEM_CHARS) {
  if (!maxChars) return content;
  const truncate = (text) => {
    const s = String(text || '');
    if (s.length <= maxChars) return s;
    const headChars = Math.floor(maxChars * 0.7);
    const tailChars = maxChars - headChars;
    // Prefer line boundaries so we never enter/exit the middle of a block.
    let headEnd = s.lastIndexOf('\n', headChars);
    if (headEnd < maxChars * 0.5) headEnd = headChars;
    let tailStart = s.indexOf('\n', s.length - tailChars);
    if (tailStart < 0 || tailStart < headEnd) tailStart = s.length - tailChars;
    const head = s.slice(0, headEnd);
    const tail = s.slice(tailStart + 1);
    log(`system prompt truncated ${s.length} chars -> ${head.length + tail.length} (max=${maxChars})`);
    return `${head}\n[... system prompt recortado por el bridge; se omitieron ${
      s.length - head.length - tail.length
    } chars del medio; conserva las instrucciones iniciales y las del final ...]\n${tail}`;
  };
  if (typeof content === 'string') return truncate(content);
  if (Array.isArray(content)) {
    return content.map((part) => (part && typeof part.text === 'string' ? { ...part, text: truncate(part.text) } : part));
  }
  return content;
}

function totalTokens(messages) {
  const list = Array.isArray(messages) ? messages : messages && Array.isArray(messages.messages) ? messages.messages : [];
  let total = list.reduce((s, m) => s + estimateTokens(m), 0);
  if (!Array.isArray(messages) && messages && Array.isArray(messages.tools) && messages.tools.length) {
    // Tool schemas are part of the provider prompt even though they do not
    // appear in `messages`. Omitting them made plugin/MCP-heavy requests look
    // small enough to skip the safety compaction while exceeding the model's
    // real context window.
    total += Math.ceil(JSON.stringify(messages.tools).length / 4) + 4;
  }
  return total;
}

// ---------------------------------------------------------------------------
// Real-token calibration
// ---------------------------------------------------------------------------
// estimateTokens() (chars/4) is a rough heuristic and DeepSeek's tokenizer
// differs a lot from it (observed on this setup: ~990k heuristic ≈ ~146k real
// tokens, ratio ≈ 0.15). The upstream reports the REAL prompt token count in
// every response (stream_options.include_usage), so we calibrate a live ratio
// and use it for compaction decisions. This makes "120k" mean the same thing
// here as in VS Code, and stops the bridge from compacting conversations that
// Codex already compacted natively (which would destroy the good summaries).
const CALIB = { heur: 0, real: 0 };
// Guards against probe requests desyncing the ratio. Observed 2026-08-10: a
// request with almost no message content (heur=7) but huge tool definitions
// upstream (real=2630) produced observed=375 -> blended=150, so a normal
// 15k-heur conversation "reported" ~2M real tokens and the safety net fired
// on a FRESH conversation. Real ratio on this setup is ~2x. Ignore readings
// whose heuristic is dominated by tool defs, and clamp the observed ratio.
let calibRatio = DEFAULT_CALIB_RATIO;
let lastCalibLogged = -1;
let calibCount = 0;

function realTokens(messages) {
  return Math.round(totalTokens(messages) * calibRatio);
}

function calibrate(heurTokens, realPromptTokens) {
  if (!(heurTokens > 0) || !(realPromptTokens > 0)) return;
  // Ignore tiny readings: they are probe/no-context requests where the
  // upstream prompt_tokens are mostly tool definitions, not conversation.
  if (heurTokens < CALIB_MIN_HEUR) return;
  CALIB.heur += heurTokens;
  CALIB.real += realPromptTokens;
  let observed = CALIB.real / CALIB.heur;
  const clamped = observed < CALIB_OBSERVED_MIN || observed > CALIB_OBSERVED_MAX;
  observed = Math.min(CALIB_OBSERVED_MAX, Math.max(CALIB_OBSERVED_MIN, observed));
  // Blend toward the new observation so one outlier cannot dominate.
  calibRatio = 0.6 * calibRatio + 0.4 * observed;
  calibCount++;
  // Log the first few readings and then only when the ratio moves materially,
  // so a request per turn does not spam bridge.out.log.
  if (calibCount <= 5 || Math.abs(calibRatio - lastCalibLogged) > 0.01) {
    lastCalibLogged = calibRatio;
    log(`calibration: heur=${heurTokens} real=${realPromptTokens} observed=${observed.toFixed(4)} blended=${calibRatio.toFixed(4)}${clamped ? ' clamped' : ''}`);
  }
}

  return { estimateTokens, boundSystemContent, totalTokens, realTokens, calibrate };
}

module.exports = { crearTokens };
