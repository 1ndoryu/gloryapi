const { readResponseTextLimited } = require('./response-body');
const { attachRoutingMetadata, routingMetadataFromHeaders, requestMetadataHeaders } = require('./upstream-metadata');

function crearUpstreamTransport(ctx) {
  const { assertSafeLoopbackUpstream, redactText, logRequest, UPSTREAM, COMPLETIONS_PATH, UPSTREAM_TIMEOUT_MS, UPSTREAM_TIMEOUT_RECOVERY_MS, UPSTREAM_MAX_RESPONSE_BYTES, STREAM_IDLE_TIMEOUT_MS, STREAM_TOTAL_TIMEOUT_MS, REQUEST_ID_HEADER, canaryRoutingHeaders } = ctx;

async function fetchUpstreamCompletion(chat, authorization, timeoutMs = UPSTREAM_TIMEOUT_MS) {
  assertSafeLoopbackUpstream(UPSTREAM);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  let response;
  let raw;
  try {
    response = await fetch(`${UPSTREAM.replace(/\/$/, '')}${COMPLETIONS_PATH}`, {
      redirect: 'error',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: authorization,
        [REQUEST_ID_HEADER]: chat.__gloryRequestId,
        ...requestMetadataHeaders(chat),
        ...canaryRoutingHeaders(chat),
      },
      body: JSON.stringify({ ...chat, stream: false }),
      signal: controller.signal,
    });
    // Keep the abort timer active through body consumption. Receiving headers
    // is not completion: a peer can otherwise hold this connection forever.
    raw = await readResponseTextLimited(response, UPSTREAM_MAX_RESPONSE_BYTES);
  } catch (cause) {
    const timedOut = controller.signal.aborted;
    const error = new Error(
      timedOut
        ? `upstream timed out after ${timeoutMs} ms`
        : `upstream request failed: ${redactText(cause && cause.message)}`,
    );
    error.statusCode = 502;
    // Marca explícita para que la capa de recuperación distinga un timeout real
    // (posible reintento con ventana extendida) de cualquier otro fallo upstream.
    if (timedOut) error.__timedOut = true;
    throw error;
  } finally {
    clearTimeout(timeout);
  }

  if (!response.ok) {
    const error = new Error(`upstream ${response.status}: ${redactText(raw)}`);
    error.statusCode = response.status;
    throw error;
  }
  try {
    const json = JSON.parse(raw);
    // GloryAPI exposes which provider+model actually served this request via
    // X-Routed-Via (e.g. "andoryyu/deepseek-v4-flash"). Attach it (non-enumerable
    // so it never leaks into bodies that get re-serialized/forwarded) so callers
    // can correlate model behavior with the real upstream route.
    const routedVia = response.headers.get('x-routed-via');
    if (routedVia) Object.defineProperty(json, '__routedVia', { value: routedVia, enumerable: false });
    const routingMetadata = routingMetadataFromHeaders(response.headers);
    attachRoutingMetadata(chat, routingMetadata);
    attachRoutingMetadata(json, routingMetadata);
    return json;
  } catch {
    const error = new Error('upstream returned invalid JSON');
    error.statusCode = 502;
    throw error;
  }
}

/**
 * Fetch a streaming completion with deadlines that remain active after
 * headers arrive. A bare fetch only protects connection setup; an upstream
 * can otherwise keep the response open forever without sending another SSE
 * frame. The idle deadline is independent from the total deadline because
 * reasoning models may stream for several minutes.
 */
async function fetchUpstreamStream(chat, authorization, callerSignal) {
  assertSafeLoopbackUpstream(UPSTREAM);
  const controller = new AbortController();
  let timeoutReason = null;
  const abortFromCaller = () => controller.abort(callerSignal?.reason);
  if (callerSignal?.aborted) abortFromCaller();
  else callerSignal?.addEventListener('abort', abortFromCaller, { once: true });
  const totalTimer = setTimeout(() => {
    timeoutReason = 'total';
    controller.abort();
  }, STREAM_TOTAL_TIMEOUT_MS);

  const cleanup = () => {
    clearTimeout(totalTimer);
    callerSignal?.removeEventListener('abort', abortFromCaller);
  };
  const timeoutError = (cause) => {
    const error = new Error(
      timeoutReason
        ? `upstream stream timed out (${timeoutReason}) after ${timeoutReason === 'idle' ? STREAM_IDLE_TIMEOUT_MS : STREAM_TOTAL_TIMEOUT_MS} ms`
        : `upstream stream failed: ${redactText(cause && cause.message)}`,
    );
    error.statusCode = 502;
    if (timeoutReason) error.__timedOut = true;
    return error;
  };

  try {
    const response = await fetch(`${UPSTREAM.replace(/\/$/, '')}${COMPLETIONS_PATH}`, {
      redirect: 'error',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: authorization,
        [REQUEST_ID_HEADER]: chat.__gloryRequestId,
        ...requestMetadataHeaders(chat),
        ...canaryRoutingHeaders(chat),
      },
      body: JSON.stringify({ ...chat, stream: true }),
      signal: controller.signal,
    });
    const routingMetadata = routingMetadataFromHeaders(response.headers);
    attachRoutingMetadata(chat, routingMetadata);
    return {
      response,
      routingMetadata,
      read: async (reader) => {
        if (controller.signal.aborted) throw timeoutError(new Error('stream aborted'));
        const idleTimer = setTimeout(() => {
          timeoutReason = 'idle';
          controller.abort();
        }, STREAM_IDLE_TIMEOUT_MS);
        try {
          return await reader.read();
        } catch (cause) {
          throw timeoutError(cause);
        } finally {
          clearTimeout(idleTimer);
        }
      },
      signal: controller.signal,
      cleanup,
      timedOut: () => Boolean(timeoutReason),
    };
  } catch (cause) {
    cleanup();
    throw timeoutError(cause);
  }
}

/**
 * Recuperación por timeout (2026-08-11): el web loop y el path non-streaming
 * usan fetchUpstreamCompletion con un timeout acotado. Si un round aborta por
 * timeout (no por otro fallo upstream), se reintenta UNA vez con la ventana
 * extendida: un contexto grande (100k+ tokens, cached_input_tokens 0) puede
 * exceder el timeout base aunque el modelo esté trabajando. Sin esto, el bridge
 * corta el SSE y el cliente muestra "stream disconnected before completion"
 * aunque el agente nunca se quedó atorado.
 */
async function fetchWithTimeoutRecovery(chat, authorization) {
  try {
    return await fetchUpstreamCompletion(chat, authorization);
  } catch (error) {
    if (error && error.__timedOut === true) {
      logRequest({
        ts: new Date().toISOString(),
        kind: 'upstream_timeout_retry',
        requestId: chat.__gloryRequestId,
        status: 502,
        error: error.message,
      });
      return await fetchUpstreamCompletion(chat, authorization, UPSTREAM_TIMEOUT_RECOVERY_MS);
    }
    throw error;
  }
}

  return { fetchUpstreamCompletion, fetchUpstreamStream, fetchWithTimeoutRecovery };
}

module.exports = { crearUpstreamTransport };
