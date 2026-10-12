const { crearTokens } = require('./context-tokens');
const { currentTurnHasToolMessages } = require('./context-util');
const { crearAuditoria } = require('./context-audit');
const { crearNudge } = require('./context-nudge');
const { crearCompactacion } = require('./context-compaction');

function createContextAdapter({
  config,
  log,
  logRequest,
  formatRemoteFailure,
  normalizeReasoningText,
  visibleReasoning,
  fallbackReasoning,
  fetchUpstreamCompletion,
  attachRequestId,
}) {
  const { context, limits, upstream, recovery, calibration } = config;
  const SUMMARY_MODEL = context.summaryModel;
  const UPSTREAM_TIMEOUT_MS = upstream.timeoutMs;
  const COMPACTION_DISABLED = context.disabled;
  const CONTEXT_LIMIT = context.limitTokens;
  const COMPACT_KEEP = context.keepTokens;
  const COMPACT_MAX_TOKENS = context.summaryMaxTokens;
  const COMPACTION_SAFETY_FACTOR = context.safetyFactor;
  const MAX_SYSTEM_CHARS = limits.maxSystemChars;
  const DEFAULT_CALIB_RATIO = calibration.defaultRatio;
  const CALIB_MIN_HEUR = calibration.minimumHeuristic;
  const CALIB_OBSERVED_MIN = calibration.observedMinimum;
  const CALIB_OBSERVED_MAX = calibration.observedMaximum;
  const FALLBACK_REASONING = fallbackReasoning;
  const CONFIRM_DIRECTIVE = recovery.confirmDirective;
  const CONTINUE_DIRECTIVE = recovery.continueDirective || recovery.confirmDirective;
  const NUDGE_RETRIES = recovery.nudgeRetries;
  const NUDGE_TIMEOUT_MS = recovery.nudgeTimeoutMs;
  const NUDGE_TIMEOUT_RECOVERY_MS = recovery.nudgeTimeoutRecoveryMs || NUDGE_TIMEOUT_MS;
  const NUDGE_MAX_ATTEMPTS = recovery.nudgeMaxAttempts || 1;
  const NUDGE_BUDGET_MS = recovery.nudgeBudgetMs || NUDGE_TIMEOUT_RECOVERY_MS;
  const AUDIT_ENABLED = recovery.auditEnabled !== false;
  const AUDIT_MODE = recovery.auditMode || (AUDIT_ENABLED ? 'adaptive' : 'off');
  const AUDIT_TIMEOUT_MS = recovery.auditTimeoutMs || NUDGE_TIMEOUT_MS;
  const AUDIT_MAX_CHARS = recovery.auditMaxChars || 5000;

  const ctx = {
    log,
    logRequest,
    formatRemoteFailure,
    fetchUpstreamCompletion,
    attachRequestId,
    isFutureIntentNarration,
    isConfirmationText,
    SUMMARY_MODEL,
    UPSTREAM_TIMEOUT_MS,
    COMPACTION_DISABLED,
    CONTEXT_LIMIT,
    COMPACT_KEEP,
    COMPACT_MAX_TOKENS,
    COMPACTION_SAFETY_FACTOR,
    MAX_SYSTEM_CHARS,
    DEFAULT_CALIB_RATIO,
    CALIB_MIN_HEUR,
    CALIB_OBSERVED_MIN,
    CALIB_OBSERVED_MAX,
    FALLBACK_REASONING,
    CONFIRM_DIRECTIVE,
    CONTINUE_DIRECTIVE,
    NUDGE_RETRIES,
    NUDGE_TIMEOUT_MS,
    NUDGE_TIMEOUT_RECOVERY_MS,
    NUDGE_MAX_ATTEMPTS,
    NUDGE_BUDGET_MS,
    AUDIT_ENABLED,
    AUDIT_MODE,
    AUDIT_TIMEOUT_MS,
    AUDIT_MAX_CHARS,
  };
  // Cableado: tokens primero (la compactación los usa); auditoría antes que nudge (usa auditCompletion).
  const { boundSystemContent, totalTokens, realTokens, calibrate } = Object.assign(ctx, crearTokens(ctx));
  const { shouldAuditCompletion, auditCompletion } = Object.assign(ctx, crearAuditoria(ctx));
  const { nudgeForToolCalls, auditThenNudge } = Object.assign(ctx, crearNudge(ctx));
  const { compactContext } = Object.assign(ctx, crearCompactacion(ctx));

// Multi-agent v2: `spawn_agent` with an explicit `agent_type` is REJECTED by
// Codex when the fork is full-history (the default), which is exactly what
// DeepSeek does when it wants a specialized role:
//   "Full-history forked agents inherit the parent agent type; omit agent_type,
//    or spawn without a full-history fork."
// (codex-rs `multi_agents_common.rs` reject_full_fork_agent_type_override).
// Fix: force `fork_turns: "none"` in that case, so the spawn succeeds and the
// subagent receives its context exclusively through `message` (V2 semantics).
// Also neutralize the V1 `fork_context: true` variant defensively.
function withSpawnForkFix(name, argsString) {
  if (name !== 'spawn_agent') return argsString;
  let parsed;
  try {
    parsed = JSON.parse(argsString);
  } catch {
    return argsString;
  }
  if (!parsed || typeof parsed !== 'object' || typeof parsed.agent_type !== 'string') return argsString;
  let changed = false;
  if (parsed.fork_turns === undefined || parsed.fork_turns === 'all') {
    parsed.fork_turns = 'none';
    changed = true;
  }
  if (parsed.fork_context === true) {
    parsed.fork_context = false;
    changed = true;
  }
  return changed ? JSON.stringify(parsed) : argsString;
}

// ---------------------------------------------------------------------------
// Anti falso-complete (2026-08-10; hook de confirmación 2026-08-11)
// ---------------------------------------------------------------------------
// DeepSeek a veces cierra con texto sin invocar la herramienta ("Voy a escanear
// los .md...", "Sigo la auditoría leyendo...", "I will check..."), y Codex
// Desktop interpreta texto sin function_call como fin de turno y cierra con
// task_complete sin ejecutar nada. La política adaptativa evita reenviar el
// historial completo cuando no hace falta: audita con un cuerpo mínimo los
// turnos ambiguos y solo construye la continuación completa si la auditoría no
// confirma el cierre. Una auditoría inconclusa nunca equivale a confirmación.
function isFutureIntentNarration(text) {
  if (!text) return false;
  // ES + EN: la narración de intención futura sin ejecución ocurre en ambos
  // idiomas ("Voy a escanear...", "I will scan...", "I'm going to...",
  // "Let me check...", "I need to..."). Las contracciones evitan apóstrofes
  // literales (i.ll / i.m / i.d) para no romper el parser estático del test.
  // Solo alimenta telemetría: un falso negativo ya no puede desactivar el
  // nudge universal.
  return /(voy a|vamos a|necesito|debo|lo reintento|reintento|procedo a|ahora voy|primero voy|lo haré|intentaré|voy a intentar|voy a hacer|voy a (escanear|revisar|buscar|crear|editar|modificar|comprobar|listar|ejecutar|probar|analizar|leer|abrir|instalar|configurar|correr|verificar)|\bi (will|am going to|need to|should|have to|want to|would like to)\b|\bi.ll\b|\bi.m\b|\bi.d\b|let me (try|check|start|look|scan|review|open|read|run|test|verify|search|list))/i.test(
    text,
  );
}

// isConfirmationText: "ok"/"done"/"listo"/"sí"... — la respuesta concreta con
// la que el modelo confirma el cierre SIN re-activar el hook. Corta y de
// acuerdo; "ok, pero falta X" o cualquier narración no cuenta como confirmación.
function isConfirmationText(text) {
  if (!text) return false;
  const t = String(text)
    .trim()
    .toLowerCase()
    .replace(/[.,!¡¿?;:]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  const okVariant = /^(ok|okay|okey|kk)( done| listo| hecho| terminado| gracias| si| sí| de acuerdo)?$/;
  return (
    /^(ok|okay|okey|kk|done|yes|si|sí|listo|hecho|terminado|completado|finished|complete|all done|that.s (it|all)|eso es todo|ya está|ya esta|nada más|nothing (else|more)|perfecto|vale|de acuerdo|entendido|confirmo|confirmado)$/.test(
      t,
    ) ||
    okVariant.test(t)
  );
}

// ---------------------------------------------------------------------------

  return {
    boundSystemContent,
    compactContext,
    totalTokens,
    realTokens,
    calibrate,
    normalizeReasoningText,
    visibleReasoning,
    withSpawnForkFix,
    isFutureIntentNarration,
    isConfirmationText,
    currentTurnHasToolMessages,
    shouldAuditCompletion,
    auditCompletion,
    auditThenNudge,
    nudgeForToolCalls,
  };
}

module.exports = { createContextAdapter };
