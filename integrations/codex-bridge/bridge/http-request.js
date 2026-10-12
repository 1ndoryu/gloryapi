const crypto = require('node:crypto');

function crearHttpRequest(ctx) {
  const { auth, limits } = ctx;

  function incomingBearer(req) {
    const value = req.headers.authorization;
    return typeof value === 'string' ? value.replace(/^Bearer\s+/i, '') : '';
  }

  function timingSafeTokenEqual(provided, expected) {
    const a = Buffer.from(provided);
    const b = Buffer.from(expected);
    if (a.length !== b.length || b.length === 0) return false;
    return crypto.timingSafeEqual(a, b);
  }

  function clientAuthorized(req) {
    // The sidecar token is intentionally separate from the bearer sent upstream.
    return timingSafeTokenEqual(incomingBearer(req), auth.clientToken);
  }

  function readBody(req, maxBytes = limits.maxBodyBytes) {
    return new Promise((resolve, reject) => {
      const chunks = [];
      let size = 0;
      let settled = false;
      req.on('data', (chunk) => {
        if (settled) return;
        size += chunk.length;
        if (size > maxBytes) {
          settled = true;
          const error = new Error(`request body exceeds ${maxBytes} bytes`);
          error.statusCode = 413;
          reject(error);
          return;
        }
        chunks.push(chunk);
      });
      req.on('end', () => {
        if (!settled) resolve(Buffer.concat(chunks).toString('utf8'));
      });
      req.on('error', reject);
    });
  }

  function isJsonContentType(req) {
    const value = String(req.headers['content-type'] || '').split(';', 1)[0].trim().toLowerCase();
    return value === 'application/json' || value.endsWith('+json');
  }

  function writeJsonError(res, statusCode, code, message, headers = {}) {
    res.writeHead(statusCode, { 'Content-Type': 'application/json', ...headers });
    res.end(JSON.stringify({ type: 'error', error: { code, message } }));
  }

  return { clientAuthorized, readBody, isJsonContentType, writeJsonError };
}

module.exports = { crearHttpRequest };
