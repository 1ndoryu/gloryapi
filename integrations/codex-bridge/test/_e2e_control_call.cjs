// Control: pedirle al modelo que llame EXACTAMENTE mcp__node_repl__js por su
// nombre, con el código dado. Si NI SIQUIERA así la llama, el problema es el
// tool calling de nombres con doble __ / la tool en sí, no la skill.
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');

const TOKEN = fs.readFileSync(path.join(os.tmpdir(), 'gb.tok.txt'), 'utf8').trim();
const BRIDGE = 'http://127.0.0.1:4100/v1/responses';

const body = {
  stream: false,
  model: 'deepseek-v4-flash',
  tools: [
    {
      type: 'function',
      name: 'mcp__node_repl__js',
      description:
        'Run JavaScript in a persistent Node-backed kernel with top-level await. Use dynamic imports like await import("playwright"). The runtime exposes nodeRepl.write(value), nodeRepl.cwd, and nodeRepl.emitImage(...).',
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
      content: [
        {
          type: 'input_text',
          text: 'Call the tool mcp__node_repl__js right now with this code (replace URL with https://example.com):\nconst { chromium } = await import("playwright");\nconst browser = await chromium.launch();\nconst page = await browser.newPage();\nawait page.goto("https://example.com");\nnodeRepl.write(await page.title());\nDo not explain. Do not call web_search. Invoke the function immediately.',
        },
      ],
    },
  ],
  instructions: 'You MUST call the tool named exactly mcp__node_repl__js. Call it now.',
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
  console.log('CONTROL: pedir llamar la tool por nombre exacto...');
  const resp = await post();
  console.log('STATUS:', resp.status);
  if (resp.status !== 200) {
    console.log('CUERPO ERROR:', resp.data.slice(0, 4000));
    return;
  }
  const j = JSON.parse(resp.data);
  const items = (j.response && j.response.output) || j.output || [];
  console.log('ITEM COUNT:', items.length);
  for (const it of items) {
    if (it.type === 'message' && it.content) {
      for (const c of it.content) {
        if (c.type === 'output_text') console.log('TEXTO:', JSON.stringify(c.text));
      }
    }
    if (it.type === 'function_call') console.log('TOOL CALL:', it.name, '->', JSON.stringify(it.arguments).slice(0, 600));
  }
})().catch((e) => {
  console.error('ERROR:', e.message);
  process.exit(1);
});