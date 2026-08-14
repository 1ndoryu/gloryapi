import { initDb } from '../db/index.js';
import {
  createConfigurationModel,
  getConfigurationSnapshot,
  updateConfigurationModel,
  updateConfigurationRoute,
} from '../services/configuration-v2.js';

function usage(): never {
  throw new Error([
    'Uso:',
    '  npm run config -w server -- snapshot',
    '  npm run config -w server -- model-set <id> <json-parcial>',
    '  npm run config -w server -- model-add <json>',
    '  npm run config -w server -- route-set <routeId> <json-con-members>',
  ].join('\n'));
}

function jsonArgument(value: string | undefined): Record<string, unknown> {
  if (!value) usage();
  try {
    const parsed: unknown = JSON.parse(value);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('debe ser un objeto JSON');
    return parsed as Record<string, unknown>;
  } catch (error) {
    throw new Error(`JSON inválido: ${error instanceof Error ? error.message : 'error desconocido'}`);
  }
}

const [command, first, second] = process.argv.slice(2);
initDb(process.env.GLORYAPI_DB_PATH);
const snapshot = getConfigurationSnapshot();

if (!command || command === 'snapshot') {
  process.stdout.write(`${JSON.stringify(snapshot, null, 2)}\n`);
} else if (command === 'model-set') {
  const modelDbId = Number(first);
  if (!Number.isSafeInteger(modelDbId) || modelDbId <= 0) usage();
  const patch = jsonArgument(second);
  const result = updateConfigurationModel(modelDbId, { ...patch, expectedRevision: snapshot.revision, actor: 'cli', source: 'configuration-cli' } as Parameters<typeof updateConfigurationModel>[1] & { expectedRevision: number });
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
} else if (command === 'model-add') {
  const result = createConfigurationModel({ ...jsonArgument(first), actor: 'cli', source: 'configuration-cli' } as Parameters<typeof createConfigurationModel>[0]);
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
} else if (command === 'route-set') {
  if (!first) usage();
  const result = updateConfigurationRoute(first, { ...jsonArgument(second), expectedRevision: snapshot.revision, actor: 'cli', source: 'configuration-cli' } as Parameters<typeof updateConfigurationRoute>[1] & { expectedRevision: number });
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
} else {
  usage();
}
