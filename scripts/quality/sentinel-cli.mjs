import fs from 'node:fs';
import path from 'node:path';

export function sentinelInvocation(workspace, args = []) {
  const cliPath = path.join(
    workspace,
    '.quality-tools',
    'sentinel',
    'versions',
    '0.6.4',
    'out',
    'cli',
    'index.js',
  );
  if (fs.existsSync(cliPath)) {
    return { executable: process.execPath, args: [cliPath, ...args] };
  }
  const executable = process.platform === 'win32' ? 'sentinel.cmd' : 'sentinel';
  return { executable, args };
}
