import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
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
  '--full',
  '--allow-heavy',
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

// A full gate is valid only when the report carries the same enforce policy
// identity that doctor resolved. Never accept a stage PASS with missing policy.
if ((result.status ?? 2) === 0) {
  const reportPath = path.join(workspace, '.quality-reports', 'check', taskId, 'latest.json');
  let report;
  try {
    report = JSON.parse(fs.readFileSync(reportPath, 'utf8'));
  } catch (error) {
    process.stderr.write(`Gate full sin informe JSON verificable: ${error instanceof Error ? error.message : 'lectura fallida'}\n`);
    process.exit(1);
  }
  const policy = report?.policy;
  const identityPresent = typeof policy?.policyPath === 'string'
    && policy.policyPath.length > 0
    && typeof policy?.policyHash === 'string'
    && policy.policyHash !== 'unavailable'
    && policy.policyHash.length > 0
    && policy?.decision?.status === 'policy'
    && policy?.decision?.mode === 'enforce';
  if (!identityPresent) {
    process.stderr.write(`Gate full bloqueado: el informe no contiene identidad de política enforce (${reportPath}).\n`);
    process.exit(1);
  }
}
process.exit(result.status ?? 2);
