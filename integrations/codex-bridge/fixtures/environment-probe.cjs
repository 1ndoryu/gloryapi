const fs = require('node:fs');
const http = require('node:http');

const probePath = process.env.GLORYAPI_ENV_PROBE_PATH;
if (!probePath) throw new Error('GLORYAPI_ENV_PROBE_PATH is required');
fs.writeFileSync(probePath, JSON.stringify({
  bridgeClientToken: process.env.BRIDGE_CLIENT_TOKEN ?? null,
  gloryApiKey: process.env.GLORY_API_KEY ?? null,
  freelApiKey: process.env.FREEL_API_KEY ?? null,
  bridgeRuntimeDir: process.env.BRIDGE_RUNTIME_DIR ?? null,
}, null, 2));

http.createServer((req, res) => {
  if (req.url === '/api/ping') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok' }));
    return;
  }
  res.writeHead(404);
  res.end();
}).listen(Number(process.env.PORT || 3101), '127.0.0.1');
