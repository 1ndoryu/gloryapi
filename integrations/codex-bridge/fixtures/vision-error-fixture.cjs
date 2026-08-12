const originalFetch = global.fetch;
const dns = require('node:dns');
const https = require('node:https');
const { EventEmitter } = require('node:events');

const originalLookup = dns.promises.lookup;
dns.promises.lookup = async (hostname, options) => {
  if (hostname === 'opencode.ai' && options && options.all) return [{ address: '93.184.216.34', family: 4 }];
  return originalLookup(hostname, options);
};

const originalHttpsRequest = https.request;
https.request = (options, callback) => {
  const host = typeof options === 'string' ? new URL(options).hostname : options.hostname;
  const pathname = typeof options === 'string' ? new URL(options).pathname : options.path;
  if (host !== 'opencode.ai' || !String(pathname).startsWith('/zen/go/v1/chat/completions')) {
    return originalHttpsRequest(options, callback);
  }
  const request = new EventEmitter();
  request.setTimeout = () => request;
  request.end = () => {
    const response = new EventEmitter();
    response.statusCode = 500;
    response.headers = { 'content-type': 'application/json', 'content-length': '12' };
    callback(response);
    process.nextTick(() => {
      response.emit('data', Buffer.from(JSON.stringify({ error: 'SECRET_QUERY' })));
      response.emit('end');
    });
  };
  request.destroy = (error) => {
    if (error) process.nextTick(() => request.emit('error', error));
    return request;
  };
  return request;
};

// Deterministic remote fixture: the body deliberately contains prompt-like
// text. The bridge must classify the failure without copying this body to logs.
global.fetch = async (input, init) => {
  const url = String(input);
  if (url === 'https://opencode.ai/zen/go/v1/chat/completions') {
    return new Response(JSON.stringify({ error: 'SECRET_QUERY' }), {
      status: 500,
      headers: { 'content-type': 'application/json', 'content-length': '12' },
    });
  }
  return originalFetch(input, init);
};
