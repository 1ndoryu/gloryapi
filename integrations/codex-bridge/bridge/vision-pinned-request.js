const http = require('node:http');
const https = require('node:https');
const net = require('node:net');
const { contentLengthOf } = require('./response-body');

function requestPinnedVision(endpoint, address, options) {
  const url = new URL(endpoint);
  const client = url.protocol === 'https:' ? https : http;
  const hostname = url.hostname.replace(/^\[|\]$/g, '');
  const family = address.family || net.isIP(address.address);
  return new Promise((resolve, reject) => {
    let settled = false;
    let abort = () => {};
    const cleanup = () => options.signal?.removeEventListener('abort', abort);
    const fail = (error) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    };
    const finish = (value) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(value);
    };
    const request = client.request({
      hostname,
      port: url.port || (url.protocol === 'https:' ? 443 : 80),
      path: `${url.pathname}${url.search}`,
      method: 'POST',
      headers: options.headers,
      servername: hostname,
      rejectUnauthorized: url.protocol === 'https:',
      // The resolver was already checked. This callback prevents node from
      // resolving the hostname a second time during the socket connection.
      lookup: (_host, lookupOptions, callback) => {
        if (lookupOptions && lookupOptions.all) callback(null, [{ address: address.address, family }]);
        else callback(null, address.address, family);
      },
    }, (incoming) => {
      const declared = contentLengthOf({ headers: { get: name => incoming.headers[String(name).toLowerCase()] } });
      if (declared != null && declared > options.maxBytes) {
        incoming.destroy();
        fail(new Error(`vision response exceeds ${options.maxBytes} bytes`));
        return;
      }
      const chunks = [];
      let size = 0;
      incoming.on('data', (chunk) => {
        size += chunk.length;
        if (size > options.maxBytes) {
          incoming.destroy(new Error(`vision response exceeds ${options.maxBytes} bytes`));
          return;
        }
        chunks.push(chunk);
      });
      incoming.on('error', fail);
      incoming.on('end', () => finish({
        ok: (incoming.statusCode || 0) >= 200 && (incoming.statusCode || 0) < 300,
        status: incoming.statusCode || 0,
        text: Buffer.concat(chunks).toString('utf8'),
        body: null,
      }));
    });
    abort = () => {
      const error = new Error('vision request aborted');
      error.name = 'AbortError';
      request.destroy(error);
    };
    request.on('error', fail);
    request.setTimeout(options.timeoutMs, () => {
      const error = new Error('vision request timed out');
      error.name = 'TimeoutError';
      request.destroy(error);
    });
    if (options.signal?.aborted) abort();
    else options.signal?.addEventListener('abort', abort, { once: true });
    request.end(options.body);
  });
}

module.exports = { requestPinnedVision };
