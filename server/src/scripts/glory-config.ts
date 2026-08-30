import fs from 'node:fs';
import path from 'node:path';
import { initDb } from '../db/index.js';
import {
  applyConfigurationDocument,
  createConfigurationModel,
  createConfigurationProvider,
  exportConfigurationDocument,
  getConfigurationSnapshot,
  rollbackConfiguration,
  updateConfigurationModel,
  updateConfigurationProvider,
  updateConfigurationRoute,
  validateConfigurationDocument,
  ConfigurationRevisionConflictError,
  ConfigurationValidationError,
} from '../services/configuration-v2.js';
import {
  CliError,
  diagnoseBridgeCatalog,
  dryRunResult,
  flag,
  hasFlag,
  numericFlag,
  parseJson,
  print,
  readJson,
  usage,
  writeAtomicJson,
} from './glory-config-helpers.js';

function main(): void {
  const args = process.argv.slice(2);
  const jsonOutput = hasFlag(args, '--json');
  const dryRun = hasFlag(args, '--dry-run');
  const command = args.find(arg => !arg.startsWith('--'));
  if (!command || command === 'snapshot') {
    initDb(process.env.GLORYAPI_DB_PATH, { quiet: jsonOutput });
    print(getConfigurationSnapshot(), jsonOutput);
    return;
  }

  initDb(process.env.GLORYAPI_DB_PATH, { quiet: jsonOutput });
  const group = args[0];
  const action = args[1];
  const positionals: string[] = [];
  const valueFlags = new Set(['--output', '--expected-revision', '--to-revision', '--idempotency-key']);
  for (let index = 2; index < args.length; index += 1) {
    if (args[index].startsWith('--')) {
      if (valueFlags.has(args[index])) index += 1;
      continue;
    }
    positionals.push(args[index]);
  }

  if (group === 'config' && action === 'export') {
    const output = flag(args, '--output');
    if (!output) throw new Error('config export requiere --output <ruta>');
    const document = exportConfigurationDocument();
    fs.writeFileSync(path.resolve(output), `${JSON.stringify(document, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' });
    print({ ok: true, output: path.resolve(output), revision: document.revision, redacted: true }, jsonOutput);
    return;
  }
  if (group === 'config' && action === 'validate') {
    const file = positionals[0];
    if (!file) usage();
    const document = validateConfigurationDocument(readJson(file));
    print({ ok: true, schemaVersion: document.schemaVersion, revision: document.revision, providers: document.providers.length, models: document.models.length, routes: document.routes.length, catalogEntries: document.catalog.length }, jsonOutput);
    return;
  }
  if (group === 'config' && action === 'diff') {
    const file = positionals[0];
    if (!file) usage();
    const document = validateConfigurationDocument(readJson(file));
    const current = exportConfigurationDocument();
    print({ currentRevision: current.revision, proposedRevision: document.revision, equal: JSON.stringify(current) === JSON.stringify(document), current, proposed: document }, jsonOutput);
    return;
  }
  if (group === 'config' && action === 'apply') {
    const file = positionals[0];
    if (!file) usage();
    const document = validateConfigurationDocument(readJson(file));
    const expectedRevision = numericFlag(args, '--expected-revision') ?? document.revision;
    if (dryRun) { print(dryRunResult('config apply', { expectedRevision, document }), jsonOutput); return; }
    print(applyConfigurationDocument(document, { expectedRevision, idempotencyKey: flag(args, '--idempotency-key'), actor: 'cli', source: 'configuration-cli' }), jsonOutput);
    return;
  }
  if (group === 'config' && action === 'rollback') {
    const target = numericFlag(args, '--to-revision');
    if (target === undefined) throw new Error('config rollback requiere --to-revision N');
    if (dryRun) { print(dryRunResult('config rollback', { targetRevision: target, expectedRevision: numericFlag(args, '--expected-revision') }), jsonOutput); return; }
    print(rollbackConfiguration(target, numericFlag(args, '--expected-revision'), flag(args, '--idempotency-key')), jsonOutput);
    return;
  }
  if (group === 'provider' && action === 'add') {
    const proposal = parseJson(positionals[0], 'provider');
    if (dryRun) { print(dryRunResult('provider add', proposal), jsonOutput); return; }
    print(createConfigurationProvider({ ...proposal, actor: 'cli', source: 'configuration-cli', expectedRevision: numericFlag(args, '--expected-revision'), idempotencyKey: flag(args, '--idempotency-key') } as Parameters<typeof createConfigurationProvider>[0]), jsonOutput);
    return;
  }
  if (group === 'provider' && action === 'set') {
    const platform = positionals[0];
    const proposal = parseJson(positionals[1], 'provider');
    if (!platform) usage();
    if (dryRun) { print(dryRunResult('provider set', { platform, ...proposal }), jsonOutput); return; }
    print(updateConfigurationProvider(platform, { ...proposal, actor: 'cli', source: 'configuration-cli', expectedRevision: numericFlag(args, '--expected-revision'), idempotencyKey: flag(args, '--idempotency-key') } as Parameters<typeof updateConfigurationProvider>[1]), jsonOutput);
    return;
  }
  if (group === 'provider' && (action === 'enable' || action === 'disable')) {
    const platform = positionals[0];
    if (!platform) usage();
    if (dryRun) { print(dryRunResult(`provider ${action}`, { platform }), jsonOutput); return; }
    print(updateConfigurationProvider(platform, { enabled: action === 'enable', lifecycle: 'active', actor: 'cli', source: 'configuration-cli', expectedRevision: numericFlag(args, '--expected-revision'), idempotencyKey: flag(args, '--idempotency-key') }), jsonOutput);
    return;
  }
  if (group === 'model' && action === 'add') {
    const proposal = parseJson(positionals[0], 'model');
    if (dryRun) { print(dryRunResult('model add', proposal), jsonOutput); return; }
    print(createConfigurationModel({ ...proposal, actor: 'cli', source: 'configuration-cli', expectedRevision: numericFlag(args, '--expected-revision'), idempotencyKey: flag(args, '--idempotency-key') } as Parameters<typeof createConfigurationModel>[0]), jsonOutput);
    return;
  }
  if (group === 'model' && action === 'set') {
    const modelDbId = Number(positionals[0]);
    if (!Number.isSafeInteger(modelDbId) || modelDbId <= 0) usage();
    const proposal = parseJson(positionals[1], 'model');
    if (dryRun) { print(dryRunResult('model set', { modelDbId, ...proposal }), jsonOutput); return; }
    print(updateConfigurationModel(modelDbId, { ...proposal, actor: 'cli', source: 'configuration-cli', expectedRevision: numericFlag(args, '--expected-revision'), idempotencyKey: flag(args, '--idempotency-key') } as Parameters<typeof updateConfigurationModel>[1]), jsonOutput);
    return;
  }
  if (group === 'model' && (action === 'enable' || action === 'disable')) {
    const modelDbId = Number(positionals[0]);
    if (!Number.isSafeInteger(modelDbId) || modelDbId <= 0) usage();
    if (dryRun) { print(dryRunResult(`model ${action}`, { modelDbId }), jsonOutput); return; }
    print(updateConfigurationModel(modelDbId, { enabled: action === 'enable', actor: 'cli', source: 'configuration-cli', expectedRevision: numericFlag(args, '--expected-revision'), idempotencyKey: flag(args, '--idempotency-key') }), jsonOutput);
    return;
  }
  if (group === 'route' && action === 'set') {
    const routeId = positionals[0];
    const proposal = parseJson(positionals[1], 'route');
    if (!routeId) usage();
    if (dryRun) { print(dryRunResult('route set', { routeId, ...proposal }), jsonOutput); return; }
    print(updateConfigurationRoute(routeId, { ...proposal, actor: 'cli', source: 'configuration-cli', expectedRevision: numericFlag(args, '--expected-revision'), idempotencyKey: flag(args, '--idempotency-key') } as Parameters<typeof updateConfigurationRoute>[1]), jsonOutput);
    return;
  }
  if (group === 'bridge' && action === 'catalog') {
    print(getConfigurationSnapshot().bridge, jsonOutput);
    return;
  }
  if (group === 'bridge' && action === 'sync') {
    const output = positionals[0];
    if (!output) usage();
    const bridge = getConfigurationSnapshot().bridge;
    const absolute = path.resolve(output);
    const entries = bridge.entries.map(({ routeId: _routeId, ...entry }) => entry);
    writeAtomicJson(absolute, {
      schemaVersion: bridge.schemaVersion,
      revision: bridge.revision,
      hash: bridge.hash,
      entries,
    });
    print({ ok: true, output: absolute, revision: bridge.revision, hash: bridge.hash }, jsonOutput);
    return;
  }
  if (group === 'bridge' && action === 'diagnose') {
    const result = diagnoseBridgeCatalog(positionals[0]);
    print(result, jsonOutput);
    if (result.ok !== true) process.exitCode = 1;
    return;
  }
  usage();
}

try {
  main();
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  const code = error instanceof ConfigurationRevisionConflictError
    ? error.code
    : error instanceof ConfigurationValidationError
      ? error.code
      : error instanceof CliError
        ? error.code
        : 'cli_error';
  const jsonOutput = process.argv.includes('--json');
  if (jsonOutput) process.stdout.write(`${JSON.stringify({ ok: false, error: { code, message } })}\n`);
  else process.stderr.write(`${code}: ${message}\n`);
  process.exitCode = code === 'configuration_revision_conflict' ? 3 : code === 'invalid_configuration' || code.startsWith('idempotency_') || code === 'invalid_json' || code === 'invalid_number' || code === 'usage' ? 2 : 1;
}
