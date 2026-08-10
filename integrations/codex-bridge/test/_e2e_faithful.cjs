// E2E fiel a la app: namespace `mcp__node_repl` (children js, js_reset) que es
// como Codex Desktop lo expone, + tool_search + skill del navegador en system.
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
      name: 'web_search',
      description: 'Search the web for up-to-date information to answer the user request.',
    },
    {
      type: 'function',
      name: 'end_turn',
      description: 'Mark the turn as complete when you have fulfilled the request.',
    },
    {
      type: 'namespace',
      name: 'mcp__node_repl',
      tools: [
        {
          type: 'function',
          name: 'js',
          description:
            'Run JavaScript in a persistent Node-backed kernel with top-level await. The runtime exposes nodeRepl.cwd, nodeRepl.homeDir, nodeRepl.tmpDir, nodeRepl.requestMeta, nodeRepl.setResponseMeta(...), and await nodeRepl.emitImage(...). Use nodeRepl.write(value) to add output without a newline. Use dynamic imports like await import("playwright"). If timeout_ms is omitted, execution times out after 30000 ms.',
          parameters: {
            type: 'object',
            additionalProperties: false,
            properties: {
              code: { type: 'string', description: 'JavaScript source to execute in the persistent Node-backed kernel.' },
              timeout_ms: { type: 'integer', description: 'Optional execution timeout in milliseconds. Defaults to 30000.' },
              title: { type: 'string', minLength: 1, maxLength: 80, description: 'Short user-facing description of what this code block is doing.' },
            },
            required: ['code'],
          },
        },
        {
          type: 'function',
          name: 'js_reset',
          description: 'Reset the persistent JS runtime, clearing all top-level bindings.',
        },
      ],
    },
    {
      type: 'tool_search',
      name: 'tool_search',
      description: 'Search for additional tools that can help complete the task.',
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
    'You are a helpful assistant in the Codex app with an integrated browser.',
    "Use this skill when the user asks you to browse the web or use a browser:",
    '1. The integrated browser is controlled through the `node_repl` MCP server, tool `js` (callable as `mcp__node_repl__js`).',
    '2. Use tool discovery (call tool_search for "node_repl js") to locate it, then call it with a playwright script.',
    '3. If tool discovery is unavailable, call `mcp__node_repl__js` directly.',
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
  console.log('E2E fiel a la app (namespace mcp__node_repl + tool_search)...');
  const resp = await post();
  console.log('STATUS:', resp.status);
  if (resp.status !== 200) {
    console.log('CUERPO ERROR:', resp.data.slice(0, 4000));
    return;
  }
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
        if (it.type === 'function_call') {
          console.log(`TOOL CALL: ${it.name} args=${JSON.stringify(it.arguments).slice(0, 300)}`);
        } else if (it.type === 'message' || it.type === 'reasoning') {
          console.log(`ITEM: ${it.type}`);
        }
      } else if (t === 'response.output_text.delta') {
        // collect final text
      } else if (t === 'response.completed') {
        const out = (j.response && j.response.output) || [];
        console.log('COMPLETED. output items:', out.map((o) => o.type + (o.type === 'function_call' ? ':' + o.name : '')).join(', ') || '(vacio)');
      }
    } catch (e) {}
  }
})().catch((e) => {
  console.error('ERROR:', e.message);
  process.exit(1);
});