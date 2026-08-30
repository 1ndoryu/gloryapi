import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {
  AUTO_ROUTE_ID,
  getConfigurationSnapshot,
  getRouteModelIds,
} from '../services/configuration-v2.js';

export type JsonObject = Record<string, unknown>;

export class CliError extends Error {
  constructor(message: string, readonly code: string) {
    super(message);
    this.name = 'CliError';
  }
}

export function usage(): never {
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

export function object(value: unknown, name: string): JsonObject {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${name} debe ser un objeto JSON`);
  return value as JsonObject;
}

export function parseJson(value: string | undefined, name = 'argumento'): JsonObject {
  if (!value) usage();
  try { return object(JSON.parse(value), name); } catch (error) { throw new CliError(`JSON inválido en ${name}: ${error instanceof Error ? error.message : 'error desconocido'}`, 'invalid_json'); }
}

export function flag(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  if (index < 0) return undefined;
  return args[index + 1] && !args[index + 1].startsWith('--') ? args[index + 1] : '';
}

export function hasFlag(args: string[], name: string): boolean { return args.includes(name); }

export function numericFlag(args: string[], name: string): number | undefined {
  const value = flag(args, name);
  if (value === undefined) return undefined;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) throw new CliError(`${name} debe ser un entero no negativo`, 'invalid_number');
  return parsed;
}

export function readJson(file: string): unknown {
  const absolute = path.resolve(file);
  try { return JSON.parse(fs.readFileSync(absolute, 'utf8')) as unknown; }
  catch (error) { throw new CliError(`JSON inválido en ${absolute}: ${error instanceof Error ? error.message : 'error desconocido'}`, 'invalid_json'); }
}

export function print(value: unknown, jsonOutput: boolean): void {
  if (jsonOutput || typeof value !== 'string') process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
  else process.stdout.write(`${value}\n`);
}

export function dryRunResult(operation: string, payload: unknown): JsonObject {
  return { dryRun: true, operation, accepted: true, proposal: payload };
}

export function writeAtomicJson(filePath: string, value: unknown): void {
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

export function diagnoseBridgeCatalog(filePath: string | undefined): JsonObject {
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
