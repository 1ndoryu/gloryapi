import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { initDb } from '../db/index.js';
import {
  applyConfigurationDocument,
  AUTO_ROUTE_ID,
  createConfigurationModel,
  createConfigurationProvider,
  exportConfigurationDocument,
  getConfigurationSnapshot,
  getRouteModelIds,
  rollbackConfiguration,
  updateConfigurationModel,
  updateConfigurationProvider,
  updateConfigurationRoute,
  validateConfigurationDocument,
  ConfigurationRevisionConflictError,
  ConfigurationValidationError,
} from '../services/configuration-v2.js';

type JsonObject = Record<string, unknown>;

function usage(): never {
  throw new CliError([
    'Uso:',
    '  npm --silent run config -w server -- snapshot [--json]',
    '  npm --silent run config -w server -- config export --output <ruta> [--json]',
    '  npm --silent run config -w server -- config validate <archivo> [--json]',
    '  npm --silent run config -w server -- config diff <archivo> [--json]',
    '  npm --silent run config -w server -- config apply <archivo> [--expected-revision N] [--idempotency-key K] [--dry-run] [--json]',
    '  npm --silent run config -w server -- config rollback --to-revision N [--expected-revision N] [--idempotency-key K] [--dry-run]',
    '  npm --silent run config -w server -- provider add <json> [--expected-revision N] [--idempotency-key K] [--dry-run] [--json]',
    '  npm --silent run config -w server -- provider set <platform> <json> [--expected-revision N] [--idempotency-key K] [--dry-run] [--json]',
    '  npm --silent run config -w server -- provider enable|disable <platform> [--expected-revision N] [--idempotency-key K] [--dry-run] [--json]',
    '  npm --silent run config -w server -- model add <json> [--expected-revision N] [--idempotency-key K] [--dry-run] [--json]',
    '  npm --silent run config -w server -- model set <id> <json> [--expected-revision N] [--idempotency-key K] [--dry-run] [--json]',
    '  npm --silent run config -w server -- model enable|disable <id> [--expected-revision N] [--idempotency-key K] [--dry-run] [--json]',
    '  npm --silent run config -w server -- route set <routeId> <json> [--expected-revision N] [--idempotency-key K] [--dry-run] [--json]',
    '  npm --silent run config -w server -- bridge catalog|sync <ruta>',
    '  npm --silent run config -w server -- bridge diagnose [ruta-catalogo-bridge.json] [--json]',
  ].join('\n'), 'usage');
}

function object(value: unknown, name: string): JsonObject {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${name} debe ser un objeto JSON`);
  return value as JsonObject;
}

function parseJson(value: string | undefined, name = 'argumento'): JsonObject {
  if (!value) usage();
  try { return object(JSON.parse(value), name); } catch (error) { throw new CliError(`JSON inválido en ${name}: ${error instanceof Error ? error.message : 'error desconocido'}`, 'invalid_json'); }
}

class CliError extends Error {
  constructor(message: string, readonly code: string) {
    super(message);
    this.name = 'CliError';
  }
}

function flag(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  if (index < 0) return undefined;
  return args[index + 1] && !args[index + 1].startsWith('--') ? args[index + 1] : '';
}

function hasFlag(args: string[], name: string): boolean { return args.includes(name); }

function numericFlag(args: string[], name: string): number | undefined {
  const value = flag(args, name);
  if (value === undefined) return undefined;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) throw new CliError(`${name} debe ser un entero no negativo`, 'invalid_number');
  return parsed;
}

function readJson(file: string): unknown {
  const absolute = path.resolve(file);
  try { return JSON.parse(fs.readFileSync(absolute, 'utf8')) as unknown; }
  catch (error) { throw new CliError(`JSON inválido en ${absolute}: ${error instanceof Error ? error.message : 'error desconocido'}`, 'invalid_json'); }
}

function print(value: unknown, jsonOutput: boolean): void {
  if (jsonOutput || typeof value !== 'string') process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
  else process.stdout.write(`${value}\n`);
}

function dryRunResult(operation: string, payload: unknown): JsonObject {
  return { dryRun: true, operation, accepted: true, proposal: payload };
}

function writeAtomicJson(filePath: string, value: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const temporary = `${filePath}.tmp-${process.pid}`;
  const backup = `${filePath}.bak-${process.pid}`;
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8' });
  const hadTarget = fs.existsSync(filePath);
  try {
    if (hadTarget) fs.renameSync(filePath, backup);
    fs.renameSync(temporary, filePath);
    if (hadTarget) fs.rmSync(backup, { force: true });
  } catch (error) {
    if (!fs.existsSync(filePath) && fs.existsSync(backup)) fs.renameSync(backup, filePath);
    if (fs.existsSync(temporary)) fs.rmSync(temporary, { force: true });
    throw error;
  }
}

function diagnoseBridgeCatalog(filePath: string | undefined): JsonObject {
  const snapshot = getConfigurationSnapshot();
  const errors: string[] = [];
  const warnings: string[] = [];
  const auto = snapshot.routes.find(route => route.routeId === AUTO_ROUTE_ID);
  const autoIds = getRouteModelIds(AUTO_ROUTE_ID);
  const autoMemberIds = auto?.members.filter(member => member.enabled).map(member => member.modelDbId) ?? [];
  if (!auto || !auto.enabled || auto.visible === false) errors.push('La ruta Auto no está publicada y habilitada');
  if (JSON.stringify(autoIds) !== JSON.stringify(autoMemberIds)) errors.push('La caché de routing no coincide con los miembros persistidos de Auto');
  if (autoIds.length === 0) errors.push('La ruta Auto no tiene modelos habilitados');

  const bridgeIds = new Set<string>();
  for (const entry of snapshot.bridge.entries) {
    if (bridgeIds.has(entry.id)) errors.push(`El catálogo bridge contiene el ID duplicado '${entry.id}'`);
    bridgeIds.add(entry.id);
    if (entry.id === 'auto' && entry.wireModel !== 'auto') errors.push('La entrada Auto no usa wireModel=auto');
    if (entry.id !== 'auto' && entry.routeId === AUTO_ROUTE_ID) errors.push(`El modelo explícito '${entry.id}' apunta a Auto`);
    if (entry.id.toLowerCase().includes('deepseek-v4-pro') || entry.displayName.toLowerCase().includes('deepseek v4 pro')) errors.push(`DeepSeek Pro sigue publicado: ${entry.id}`);
    if (entry.id !== 'auto' && getRouteModelIds(entry.routeId).length === 0) errors.push(`El modelo '${entry.id}' apunta a una ruta sin candidatos`);
  }
  if (!snapshot.bridge.entries.some(entry => entry.id === 'auto')) errors.push('El catálogo bridge no contiene Auto');
  for (const model of snapshot.models) {
    if (model.modelId.toLowerCase().includes('deepseek-v4-pro') || model.displayName.toLowerCase().includes('deepseek v4 pro')) errors.push(`DeepSeek Pro sigue en el catálogo interno: ${model.platform}/${model.modelId}`);
  }

  if (filePath) {
    const absolute = path.resolve(filePath);
    try {
      const file = JSON.parse(fs.readFileSync(absolute, 'utf8')) as { schemaVersion?: string; revision?: number; hash?: string; entries?: unknown[] };
      if (file.schemaVersion !== snapshot.bridge.schemaVersion) errors.push('El archivo bridge tiene un schemaVersion obsoleto');
      if (file.revision !== snapshot.bridge.revision) errors.push(`El archivo bridge está obsoleto: archivo=${String(file.revision)} DB=${snapshot.bridge.revision}`);
      const entries = Array.isArray(file.entries) ? file.entries : [];
      const hashEntries = entries.map(value => {
        const entry = object(value, 'bridge entry');
        const { routeId: _routeId, ...transportEntry } = entry;
        return transportEntry;
      });
      const hash = crypto.createHash('sha256').update(JSON.stringify(hashEntries)).digest('hex');
      if (file.hash !== hash) errors.push('El hash del archivo bridge no coincide con sus entradas');
      if (file.hash !== snapshot.bridge.hash) errors.push('El hash del archivo bridge no coincide con la proyección de GloryAPI');
    } catch (error) {
      errors.push(`No se pudo leer el catálogo bridge: ${error instanceof Error ? error.message : String(error)}`);
    }
  } else {
    warnings.push('No se indicó un archivo local; solo se validó la proyección de GloryAPI');
  }

  return {
    ok: errors.length === 0,
    revision: snapshot.revision,
    errors,
    warnings,
    auto: { routeId: AUTO_ROUTE_ID, enabled: auto?.enabled === true, members: autoIds },
    bridge: { schemaVersion: snapshot.bridge.schemaVersion, revision: snapshot.bridge.revision, hash: snapshot.bridge.hash, entries: snapshot.bridge.entries.map(entry => entry.id) },
    providers: snapshot.providers.map(provider => ({ platform: provider.platform, lifecycle: provider.lifecycle, enabled: provider.enabled })),
  };
}

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
