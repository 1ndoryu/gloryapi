// Reproducción E2E del escenario del navegador (Codex Desktop -> bridge -> GloryAPI)
// Pregunta qué tool llama el modelo al pedir "intenta usar el navegador de chatgpt".
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');

const TOKEN = fs.readFileSync(path.join(os.tmpdir(), 'gb.tok.txt'), 'utf8').trim();
const BRIDGE = 'http://127.0.0.1:4100/v1/responses';

// Tool real que la app de Codex Desktop expone para el navegador integrado:
// namespace mcp__node_repl con la tool js (navegador in-app).
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
            'Execute JavaScript code in the integrated Node.js REPL. This is the ONLY tool that can drive the in-app browser (control-in-app-browser). Use it to navigate to URLs, query the DOM, click elements, fill forms and read page content. Always use this tool for any browser automation task instead of searching. Example: navigate to a URL with a browser automation script and return the page content.',
          parameters: {
            type: 'object',
            properties: {
              code: {
                type: 'string',
                description: 'JavaScript code to execute in the integrated Node.js REPL environment.',
              },
            },
            required: ['code'],
          },
        },
      ],
    },
    {
      type: 'tool_search',
      name: 'tool_search',
      description:
        'Search for additional tools that can help complete the task. Returns newly discovered tools which can then be called directly.',
    },
  ],
  input: [
    {
      type: 'message',
      role: 'user',
      content: [
        {
          type: 'input_text',
          text: 'intenta usar el navegador de chatgpt',
        },
      ],
    },
  ],
  instructions: [
    'You are a helpful assistant. When the user asks you to use the in-app browser (control-in-app-browser), you must call the tool `mcp__node_repl__js` directly to automate the browser (navigate, click, fill forms, read pages). Do NOT simply say you will do something - actually call the tool. If you do not know how to use the tool, call `mcp__node_repl__js` with a simple browser automation script and inspect the result. The integrated browser automation library is available in the REPL environment.',
  ].join('\n'),
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
    req.on('timeout', () => {
      req.destroy(new Error('timeout'));
    });
    req.write(payload);
    req.end();
  });
}

(async () => {
  console.log('ENVIANDO request de navegador...');
  const resp = await post();
  console.log('STATUS:', resp.status);
  if (resp.status !== 200) {
    console.log('CUERPO ERROR:', resp.data.slice(0, 4000));
    return;
  }
  // Extrae tool calls y texto de la respuesta JSON
  try {
    const j = JSON.parse(resp.data);
    const items = (j.response && j.response.output) || j.output || [];
    console.log('ITEM COUNT:', items.length);
    for (const it of items) {
      if (it.type === 'message' && it.content) {
        for (const c of it.content) {
          if (c.type === 'output_text') console.log('TEXTO:', JSON.stringify(c.text));
        }
      }
      if (it.type === 'function_call') {
        console.log('TOOL CALL:', it.name, '->', JSON.stringify(it.arguments));
      }
      if (it.type === 'web_search_call') {
        console.log('WEB_SEARCH CALL');
      }
      if (it.type === 'tool_search_call') {
        console.log('TOOL_SEARCH CALL');
      }
      if (it.type === 'custom_tool_call') {
        console.log('CUSTOM TOOL CALL:', it.name);
      }
    }
  } catch (e) {
    console.log('RESPUESTA (no JSON):', resp.data.slice(0, 2000));
  }
  console.log('----------------------------------------');
})().catch((e) => {
  console.error('ERROR:', e.message);
  process.exit(1);
});