// Control 3: stream:true (como la app real) con la tool simple y orden de llamarla.
// En el caso real el modelo SÍ llamó 1 tool (toolCalls:1). ¿Qué tool y por qué?
// Este test replica stream:true y captura los eventos SSE del bridge.
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');

const TOKEN = fs.readFileSync(path.join(os.tmpdir(), 'gb.tok.txt'), 'utf8').trim();
const BRIDGE = 'http://127.0.0.1:4100/v1/responses';

const body = {
  stream: true,
  model: 'deepseek-v4-flash',
  tools: [
    {
      type: 'function',
      name: 'mcp__node_repl__js',
      description:
        'Run JavaScript in a persistent Node-backed kernel with top-level await. Use dynamic imports like await import("playwright"). The runtime exposes nodeRepl.write(value) and nodeRepl.cwd. This is the ONLY browser automation tool.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          code: { type: 'string', description: 'JavaScript source to execute.' },
          timeout_ms: { type: 'integer', description: 'Optional execution timeout in milliseconds.' },
        },
        required: ['code'],
      },
    },
    {
      type: 'function',
      name: 'web_search',
      description: 'Search the web for up-to-date information to answer the user request.',
    },
  ],
  input: [
    {
      type: 'message',
      role: 'user',
      content: [{ type: 'input_text', text: 'intenta usar el navegador de chatgpt' }],
    },
  ],
  instructions: 'Browser automation tool mcp__node_repl__js is available and is THE browser tool. Call it when asked to browse.',
};

function post() {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const req = http.request(
      BRIDGE,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${TOKEN}`,
          'Content-Length': Buffer.byteLength(payload),
        },
        timeout: 120000,
      },
      (res) => {
        let data = '';
        res.on('data', (c) => (data += c));
        res.on('end', () => resolve({ status: res.statusCode, data }));
      }
    );
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.write(payload);
    req.end();
  });
}

(async () => {
  console.log('CONTROL 3: stream:true...');
  const resp = await post();
  console.log('STATUS:', resp.status);
  if (resp.status !== 200) {
    console.log('CUERPO ERROR:', resp.data.slice(0, 4000));
    return;
  }
  // Parse SSE events
  const events = resp.data.split('\n\n').filter((x) => x.trim().length);
  console.log('EVENTOS SSE:', events.length);
  for (const ev of events) {
    const line = ev.split('\n').find((l) => l.startsWith('data:'));
    if (!line) continue;
    const data = line.slice(5).trim();
    try {
      const j = JSON.parse(data);
      const t = j.type;
      if (t === 'response.output_item.added' && j.item) {
        const it = j.item;
        console.log(`EVENT ${t}: type=${it.type}`, it.type === 'function_call' ? ` name=${it.name} args=${JSON.stringify(it.arguments).slice(0,300)}` : '');
      } else if (t === 'response.output_text.delta') {
        console.log(`TEXTO DELTA: ${JSON.stringify(j.delta)}`);
      } else if (t === 'response.completed') {
        console.log('COMPLETED. output:', JSON.stringify(j.response && j.response.output ? j.response.output.map((o)=>o.type) : []));
      }
    } catch (e) {}
  }
})().catch((e) => {
  console.error('ERROR:', e.message);
  process.exit(1);
});