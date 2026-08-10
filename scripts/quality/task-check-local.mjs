import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { sentinelInvocation } from './sentinel-cli.mjs';

const taskId = process.argv[2] || 'GLORY-BASELINE';
if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(taskId)) {
  process.stderr.write('ID de tarea inválido.\n');
  process.exit(2);
}

const workspace = process.cwd();
const invocation = sentinelInvocation(workspace, [
  'check', taskId,
  '--workspace', workspace,
  '--profile', 'docs,frontend',
  '--stages', path.join('scripts', 'quality', 'stages.json'),
]);
const result = spawnSync(invocation.executable, invocation.args, {
  cwd: workspace,
  stdio: 'inherit',
  windowsHide: true,
});

if (result.error) {
  process.stderr.write(`No se pudo ejecutar Sentinel: ${result.error.message}\n`);
  process.exit(2);
}
process.exit(result.status ?? 2);
