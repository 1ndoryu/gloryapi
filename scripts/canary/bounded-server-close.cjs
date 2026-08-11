function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function closeServerBounded(server, timeoutMs = 2_000) {
  if (!server || !server.listening) return;

  let callbackError = null;
  let closed = false;
  let resolveClosed;
  const closedPromise = new Promise(resolve => { resolveClosed = resolve; });
  try {
    server.close(error => {
      callbackError = error || null;
      closed = true;
      resolveClosed();
    });
  } catch (error) {
    throw new Error(`temporary upstream close failed: ${error.message}`);
  }

  try { server.closeAllConnections?.(); } catch {}
  try { server.closeIdleConnections?.(); } catch {}
  const timedOut = await Promise.race([
    closedPromise.then(() => false),
    sleep(timeoutMs).then(() => true),
  ]);
  if (timedOut || !closed) {
    try { server.closeAllConnections?.(); } catch {}
    try { server.closeIdleConnections?.(); } catch {}
    throw new Error(`temporary upstream did not close within ${timeoutMs}ms`);
  }
  if (callbackError) throw new Error(`temporary upstream close failed: ${callbackError.message}`);
}

module.exports = { closeServerBounded };
