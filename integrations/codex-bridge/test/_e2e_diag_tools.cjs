// Diagnóstico: ¿qué tools ve realmente el modelo upstream?
// Envía las tools del navegador y le pide al modelo que enumere las herramientas
// disponibles, para confirmar que llegan traducción correcta.
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
      name: 'web_search',
      description: 'Search the web for up-to-date information to answer the user request.',
    },
    {
      type: 'namespace',
      name: 'mcp',
      tools: [
        {
          type: 'function',
          name: 'node_repl__js',
          description:
            'Execute JavaScript code in the integrated Node.js REPL. This is the ONLY tool that can drive the in-app browser (control-in-app-browser). Use it to navigate to URLs, query the DOM, click elements, fill forms and read page content.',
          parameters: {
            type: 'object',
            properties: {
              code: { type: 'string', description: 'JavaScript code to execute in the integrated Node.js REPL environment.' },
            },
            required: ['code'],
          },
        },
      ],
    },
    {
      type: 'tool_search',
      name: 'tool_search',
      description: 'Search for additional tools that can help complete the task. Returns newly discovered tools which can then be called directly.',
    },
  ],
  input: [
    {
      type: 'message',
      role: 'user',
      content: [
        {
          type: 'input_text',
          text: 'List exactly which tools you have available right now, one per line, with their exact names as you would call them. Do not call any tool - just list them.',
        },
      ],
    },
  ],
  instructions: 'You are a diagnostic agent. Report the exact list of tools visible to you. Be literal and complete.',
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
  console.log('PREGUNTANDO al modelo qué tools ve...');
  const resp = await post();
  console.log('STATUS:', resp.status);
  if (resp.status !== 200) {
    console.log('CUERPO ERROR:', resp.data.slice(0, 4000));
    return;
  }
  const j = JSON.parse(resp.data);
  const items = (j.response && j.response.output) || j.output || [];
  for (const it of items) {
    if (it.type === 'message' && it.content) {
      for (const c of it.content) {
        if (c.type === 'output_text') console.log('RESPUESTA:', c.text);
      }
    }
    if (it.type === 'function_call') console.log('TOOL CALL:', it.name, '->', JSON.stringify(it.arguments));
  }
})().catch((e) => {
  console.error('ERROR:', e.message);
  process.exit(1);
});