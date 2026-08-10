// E2E: la tool mcp__node_repl__js está disponible. ¿La llama el modelo cuando se
// le pide explícitamente "call it now" para abrir una URL?
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
            'Run JavaScript in a persistent Node-backed kernel with top-level await. This is the browser automation tool. Use it to control the integrated in-app browser with playwright: navigate to URLs, click elements, fill forms, read page content. To open a page use: const { chromium } = await import("playwright"); const browser = await chromium.launch(); const page = await browser.newPage(); await page.goto("https://..."); nodeRepl.write(await page.title());',
          parameters: {
            type: 'object',
            properties: {
              code: { type: 'string', description: 'JavaScript code to execute in the integrated Node.js REPL environment.' },
              timeout_ms: { type: 'integer', description: 'Optional execution timeout in milliseconds.' },
            },
            required: ['code'],
          },
        },
      ],
    },
  ],
  input: [
    {
      type: 'message',
      role: 'user',
      content: [{ type: 'input_text', text: 'intenta usar el navegador de chatgpt' }],
    },
  ],
  instructions: [
    'You are a helpful assistant running inside the Codex app that HAS an integrated browser.',
    'The tool `mcp__node_repl__js` is ALREADY available to you and it IS the browser automation tool.',
    'When the user asks you to use the browser, you MUST immediately call `mcp__node_repl__js` with a playwright script - do NOT just say you will do it, do NOT search the web, do NOT call tool_search. Actually invoke the tool right now.',
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
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.write(payload);
    req.end();
  });
}

(async () => {
  console.log('ENVIANDO con instruccion explicita...');
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
    if (it.type === 'function_call') console.log('TOOL CALL:', it.name, '->', JSON.stringify(it.arguments).slice(0, 500));
    if (it.type === 'web_search_call') console.log('WEB_SEARCH CALL');
    if (it.type === 'tool_search_call') console.log('TOOL_SEARCH CALL');
  }
})().catch((e) => {
  console.error('ERROR:', e.message);
  process.exit(1);
});