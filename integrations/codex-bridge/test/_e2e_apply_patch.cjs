// E2E opt-in del contrato freeform de apply_patch.
// No forma parte de la suite automática: necesita un bridge real en :4100 y
// puede consumir una llamada externa. Usa solo un token entregado por entorno
// y escribe en un directorio temporal, nunca en C:\temp ni en el workspace.
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');

const TOKEN = String(process.env.BRIDGE_CLIENT_TOKEN || '').trim();
if (!TOKEN) {
  console.error('Falta BRIDGE_CLIENT_TOKEN. No se lee ningún archivo de tokens.');
  process.exit(2);
}
const BRIDGE = 'http://127.0.0.1:4100/v1/responses';

const TARGET_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'gloryapi-bridge-e2e-'));
const TARGET = path.join(TARGET_DIR, 'prueba-herramientas.txt');

function buildBody(userText) {
  return {
    stream: false,
    model: 'deepseek-v4-flash',
    tools: [
      {
        type: 'function',
        name: 'apply_patch',
        description:
          'Apply a patch to files in the working directory. Use this tool to create new files or edit existing files. The patch uses the unified diff format. To create a new file, use "*** Begin Patch" with "*** Add File: <path>" and "*** End Patch". To edit an existing file, use "*** Update File: <path>" with "*** End Patch". If changes are applied successfully, the output will show the diff. If the patch fails, fix the issues and try again.',
      },
      {
        type: 'shell_command',
        name: 'shell_command',
        description:
          'Run a shell command in the integrated terminal. Use this tool to execute commands, inspect files, run tests or verify results.',
        parameters: {
          type: 'object',
          properties: {
            command: { type: 'string', description: 'The shell command to execute.' },
            description: { type: 'string', description: 'Short description of what the command does.' },
          },
          required: ['command', 'description'],
        },
      },
    ],
    input: [
      {
        type: 'message',
        role: 'user',
        content: [{ type: 'input_text', text: userText }],
      },
    ],
    instructions: [
      'You are a helpful coding assistant. When asked to create or edit files, you MUST use the `apply_patch` tool. ' +
        'To CREATE a file use "*** Begin Patch" / "*** Add File: <path>" / file content / "*** End Patch". ' +
        'To EDIT an existing file use "*** Begin Patch" / "*** Update File: <path>" / "*** End Patch" with the new content. ' +
        'Actually call the tools - do NOT just describe what you would do.',
    ].join('\n'),
  };
}

function post(body) {
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
        timeout: 150000,
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

function summarize(resp) {
  const lines = [];
  lines.push('STATUS: ' + resp.status);
  if (resp.status !== 200) {
    lines.push('CUERPO ERROR: ' + resp.data.slice(0, 3000));
    return lines.join('\n');
  }
  try {
    const j = JSON.parse(resp.data);
    const items = (j.response && j.response.output) || j.output || [];
    lines.push('ITEM COUNT: ' + items.length);
    for (const it of items) {
      if (it.type === 'message' && it.content) {
        for (const c of it.content) {
          if (c.type === 'output_text') lines.push('TEXTO: ' + JSON.stringify(c.text));
        }
      }
      if (it.type === 'function_call') {
        lines.push('TOOL CALL: ' + it.name + ' -> ' + JSON.stringify(it.arguments));
      }
      if (it.type === 'custom_tool_call') {
        const raw = it.input || it.arguments || '';
        const s = typeof raw === 'string' ? raw : JSON.stringify(raw);
        lines.push('CUSTOM TOOL CALL: ' + it.name + ' -> ' + s.slice(0, 300));
      }
    }
  } catch (e) {
    lines.push('RESPUESTA (no JSON): ' + resp.data.slice(0, 2000));
  }
  return lines.join('\n');
}

(async () => {
  console.log('===== PASO 1: CREAR archivo ' + TARGET + ' con apply_patch =====');
  let resp = await post(
    buildBody('Crea el archivo ' + TARGET + ' con el contenido: "linea 1 de prueba\\nlinea 2\\n". Usa apply_patch.')
  );
  console.log(summarize(resp));

  console.log('');
  console.log('===== PASO 2: MODIFICAR el archivo con apply_patch =====');
  resp = await post(
    buildBody('Modifica el archivo ' + TARGET + ' agregando una tercera linea "linea 3 agregada". Usa apply_patch.')
  );
  console.log(summarize(resp));

  console.log('');
  console.log('===== VERIFICAR contenido final =====');
  try {
    const content = fs.readFileSync(TARGET, 'utf8');
    console.log('CONTENIDO FINAL de ' + TARGET + ':');
    console.log(content);
  } catch (e) {
    console.log('NO SE PUDO LEER ' + TARGET + ': ' + e.message);
  }
  console.log('DIRECTORIO TEMPORAL: ' + TARGET_DIR);
  console.log('----------------------------------------');
})().catch((e) => {
  console.error('ERROR: ' + e.message);
  process.exit(1);
});
