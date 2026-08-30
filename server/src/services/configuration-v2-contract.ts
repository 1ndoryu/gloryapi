import crypto from 'node:crypto';
import type { ConfiguredProvider } from './provider-configuration.js';

export type ConfigurationRouteKind = 'auto' | 'pinned' | 'policy';

export interface ConfigurationRouteMember {
  modelDbId: number;
  priority: number;
  enabled: boolean;
}

export interface ConfigurationRoute {
  routeId: string;
  name: string;
  kind: ConfigurationRouteKind;
  enabled: boolean;
  visible: boolean;
  members: ConfigurationRouteMember[];
}

export interface BridgeCatalogEntry {
  id: string;
  wireModel: string;
  pickerId: string | null;
  provider: string;
  displayName: string;
  nativeVision: boolean;
  acceptsImageInput: boolean;
  supportsReasoning: boolean;
  contextWindow: number | null;
  routeId: string;
}

export interface BridgeVisionModel {
  routeId: string;
  id: string;
  provider: string;
  displayName: string;
  baseUrl: string;
  completionsPath: string;
  authPlatform: string;
  contextWindow: number | null;
  priority: number;
  enabled: boolean;
}

export interface BridgeCatalogSyncStatus {
  state: 'synced' | 'stale' | 'missing' | 'invalid';
  path: string;
  checkedAt: string;
  revision: number | null;
  hash: string | null;
  visionHash: string | null;
  errors: string[];
}

export interface BridgeCatalogProjection {
  schemaVersion: 'glory-bridge-model-catalog-v2';
  revision: number;
  hash: string;
  visionHash: string;
  generatedAt: string;
  entries: BridgeCatalogEntry[];
  visionModels: BridgeVisionModel[];
  sync?: BridgeCatalogSyncStatus;
}

export interface ConfigurationModelIdentity {
  modelDbId: number;
  platform: string;
  modelId: string;
  displayName: string;
  pickerId: string | null;
}

export interface ConfigurationModelRuntime {
  enabled: boolean;
  contextWindow: number | null;
  nativeVision: boolean;
  supportsReasoning: boolean;
}

export interface ConfigurationModelRouting {
  routeIds: string[];
  bridgeVisible: boolean;
}

/* [ISP] La composición preserva la superficie completa del estado de un modelo
 * configurado (identidad + runtime + routing) dividiendo la interface en partes
 * cohesivas de pocos campos para respetar el SPI sin romper la API. */
export interface ConfigurationModel
  extends ConfigurationModelIdentity,
    ConfigurationModelRuntime,
    ConfigurationModelRouting {}

export interface ConfigurationProvider extends ConfiguredProvider {}

export interface ConfigurationFieldDefinition {
  key: string;
  label: string;
  description: string;
  type: 'text' | 'integer' | 'duration-ms' | 'boolean' | 'enum' | 'json-map';
  section: 'identity' | 'routing' | 'capabilities' | 'transport' | 'bridge' | 'diagnostics';
  scope: 'provider' | 'model' | 'route';
  min?: number;
  max?: number;
  options?: Array<{ value: string; label: string }>;
  requiresRestart: boolean;
  sensitive: boolean;
  consumer: string;
}

export interface ConfigurationSchema {
  schemaVersion: 'glory-configuration-fields-v1';
  fields: ConfigurationFieldDefinition[];
}

export class ConfigurationRevisionConflictError extends Error {
  readonly code = 'configuration_revision_conflict';

  constructor(public readonly currentRevision: number) {
    super(`Configuration revision conflict; current revision is ${currentRevision}`);
    this.name = 'ConfigurationRevisionConflictError';
  }
}

export class ConfigurationValidationError extends Error {
  readonly code: string;

  constructor(message: string, code = 'invalid_configuration') {
    super(message);
    this.name = 'ConfigurationValidationError';
    this.code = code;
  }
}

export interface ConfigurationSnapshot {
  schemaVersion: 'glory-configuration-v2';
  revision: number;
  routes: ConfigurationRoute[];
  models: ConfigurationModel[];
  providers: ConfigurationProvider[];
  schema: ConfigurationSchema;
  bridge: BridgeCatalogProjection;
}

export const CONFIGURATION_REVISION_KEY = 'configuration_revision';
export const AUTO_ROUTE_ID = 'route:auto';
export const BRIDGE_INTEGRATION = 'codex-bridge';
/**
 * Límite operativo que se publica al bridge para que Codex Desktop compacte
 * antes de entrar en la zona de degradación de los proveedores. No sustituye
 * la capacidad física que cada proveedor declara en su perfil.
 */
export const BRIDGE_CONTEXT_WINDOW = 150_000;

export function normalizeBridgeContextWindow(value: number | null | undefined): number {
  if (value === null || value === undefined || !Number.isSafeInteger(value) || value <= 0) {
    return BRIDGE_CONTEXT_WINDOW;
  }
  return Math.min(value, BRIDGE_CONTEXT_WINDOW);
}

export const DESKTOP_PICKER_ALIASES: Array<{ value: string; label: string }> = [
  { value: 'gpt-5.4', label: 'Ranura compatible 1 (gpt-5.4)' },
  /* `gpt-5.6-sol-wm` existe en el catálogo interno de Codex Desktop con
   * visibility=hide. Aunque GloryAPI lo publique como visible, Desktop vuelve
   * a ocultarlo al combinar catálogos. Solo se ofrecen ranuras cuyo catálogo
   * base declara visibility=list. */
  { value: 'gpt-5.4-mini', label: 'Ranura compatible 2 (gpt-5.4-mini)' },
  { value: 'gpt-5.6-luna', label: 'Ranura compatible 3 (gpt-5.6-luna)' },
  { value: 'gpt-5.5', label: 'Ranura compatible 4 (gpt-5.5)' },
  /* gpt-5.6-sol queda reservado para la ruta Auto porque Desktop lo usa como
   * destino de "Restablecer a predeterminado". */
  { value: 'gpt-5.6-auto', label: 'Ranura compatible 5 (gpt-5.6-auto)' },
  { value: 'gpt-5.6-terra', label: 'Ranura compatible 6 (gpt-5.6-terra)' },
];
export const DESKTOP_PICKER_ALIAS_VALUES = DESKTOP_PICKER_ALIASES.map(alias => alias.value);

export function safeRouteId(platform: string, modelId: string): string {
  const digest = crypto.createHash('sha256').update(`${platform}\0${modelId}`).digest('hex').slice(0, 16);
  return `route:model:${digest}`;
}

export const CONFIGURATION_SCHEMA: ConfigurationSchema = {
  schemaVersion: 'glory-configuration-fields-v1',
  fields: [
    { key: 'displayName', label: 'Nombre visible', description: 'Nombre del proveedor en el registro central.', type: 'text', section: 'identity', scope: 'provider', min: 1, max: 200, requiresRestart: false, sensitive: false, consumer: 'provider registry' },
    { key: 'enabled', label: 'Proveedor disponible', description: 'Permite que sus modelos participen en las rutas.', type: 'boolean', section: 'routing', scope: 'provider', requiresRestart: false, sensitive: false, consumer: 'provider lifecycle' },
    { key: 'lifecycle', label: 'Ciclo de vida', description: 'Estado operativo persistido del proveedor.', type: 'enum', section: 'identity', scope: 'provider', options: [{ value: 'active', label: 'Activo' }, { value: 'draft', label: 'Borrador' }, { value: 'archived', label: 'Archivado' }], requiresRestart: false, sensitive: false, consumer: 'provider registry' },
    { key: 'displayName', label: 'Nombre visible', description: 'Nombre mostrado en el panel y el selector.', type: 'text', section: 'identity', scope: 'model', min: 1, max: 200, requiresRestart: false, sensitive: false, consumer: 'catalog projection' },
    { key: 'name', label: 'Nombre de la ruta', description: 'Nombre visible de la política de enrutamiento.', type: 'text', section: 'identity', scope: 'route', min: 1, max: 160, requiresRestart: false, sensitive: false, consumer: 'route editor' },
    { key: 'enabled', label: 'Ruta disponible', description: 'Permite que la ruta sea seleccionada.', type: 'boolean', section: 'routing', scope: 'route', requiresRestart: false, sensitive: false, consumer: 'route resolver' },
    { key: 'visible', label: 'Ruta visible', description: 'Publica la ruta en clientes que consuman el catálogo.', type: 'boolean', section: 'bridge', scope: 'route', requiresRestart: false, sensitive: false, consumer: 'catalog projection' },
    { key: 'enabled', label: 'Disponible', description: 'Permite que el modelo sea candidato de sus rutas.', type: 'boolean', section: 'routing', scope: 'model', requiresRestart: false, sensitive: false, consumer: 'route resolver' },
    { key: 'contextWindow', label: 'Ventana de contexto del bridge', description: 'Límite operativo publicado a Codex Desktop para activar la compactación; la capacidad física del proveedor se conserva por separado.', type: 'integer', section: 'capabilities', scope: 'model', min: 1, max: BRIDGE_CONTEXT_WINDOW, requiresRestart: false, sensitive: false, consumer: 'Codex Desktop compaction catalog' },
    { key: 'nativeVision', label: 'Visión nativa', description: 'El modelo recibe imágenes sin convertirlas a texto.', type: 'boolean', section: 'capabilities', scope: 'model', requiresRestart: false, sensitive: false, consumer: 'bridge vision adapter' },
    { key: 'supportsReasoning', label: 'Admite razonamiento', description: 'Permite solicitar un nivel de razonamiento al modelo.', type: 'boolean', section: 'capabilities', scope: 'model', requiresRestart: false, sensitive: false, consumer: 'capability validator' },
    { key: 'pickerId', label: 'Ranura del selector', description: 'Alias compatible que ChatGPT Desktop muestra y que el bridge traduce al modelo real.', type: 'enum', section: 'bridge', scope: 'model', options: DESKTOP_PICKER_ALIASES, requiresRestart: true, sensitive: false, consumer: 'Codex Desktop catalog adapter' },
    { key: 'timeoutMs', label: 'Tiempo de espera', description: 'Límite de espera del transporte upstream.', type: 'duration-ms', section: 'transport', scope: 'provider', min: 1000, max: 300000, requiresRestart: false, sensitive: false, consumer: 'OpenAI-compatible adapter' },
    { key: 'endpoint', label: 'Endpoint', description: 'URL HTTPS pública del proveedor compatible.', type: 'text', section: 'transport', scope: 'provider', min: 1, max: 2048, requiresRestart: false, sensitive: false, consumer: 'OpenAI-compatible adapter' },
    { key: 'messageProfile', label: 'Perfil de mensajes', description: 'Normalización declarativa permitida para el contrato upstream.', type: 'enum', section: 'transport', scope: 'provider', options: [{ value: 'none', label: 'Ninguno' }, { value: 'null-assistant', label: 'Normalizar assistant nulo' }, { value: 'deepseek-thinking', label: 'Thinking de DeepSeek' }], requiresRestart: false, sensitive: false, consumer: 'OpenAI-compatible adapter' },
    { key: 'includeStreamUsage', label: 'Uso al final del stream', description: 'Solicita el bloque de uso terminal cuando el proveedor lo admite.', type: 'boolean', section: 'transport', scope: 'provider', requiresRestart: false, sensitive: false, consumer: 'OpenAI-compatible adapter' },
    { key: 'bufferUntilContent', label: 'Esperar contenido antes de emitir', description: 'Evita propagar un stream que solo contiene razonamiento y permite activar fallback.', type: 'boolean', section: 'transport', scope: 'provider', requiresRestart: false, sensitive: false, consumer: 'OpenAI-compatible adapter' },
    { key: 'bufferUntilDone', label: 'Esperar final del stream', description: 'Retiene la respuesta hasta [DONE] para que un corte incompleto pueda usar fallback.', type: 'boolean', section: 'transport', scope: 'provider', requiresRestart: false, sensitive: false, consumer: 'OpenAI-compatible adapter' },
    { key: 'maxReasoningEffort', label: 'Razonamiento máximo', description: 'Techo de esfuerzo aceptado por el proveedor.', type: 'enum', section: 'capabilities', scope: 'provider', options: [{ value: 'low', label: 'Bajo' }, { value: 'medium', label: 'Medio' }, { value: 'high', label: 'Alto' }, { value: 'max', label: 'Máximo' }], requiresRestart: false, sensitive: false, consumer: 'OpenAI-compatible adapter' },
    { key: 'modelAliases', label: 'Alias de modelos', description: 'Mapa JSON de IDs aceptados por el proveedor a sus IDs upstream; no cambia la ruta seleccionada.', type: 'json-map', section: 'transport', scope: 'provider', requiresRestart: false, sensitive: false, consumer: 'OpenAI-compatible adapter' },
    { key: 'modelReasoningLimits', label: 'Límites de razonamiento por modelo', description: 'Mapa JSON de modelo a esfuerzo máximo permitido por ese modelo.', type: 'json-map', section: 'capabilities', scope: 'provider', requiresRestart: false, sensitive: false, consumer: 'OpenAI-compatible adapter' },
    { key: 'extraHeadersProfile', label: 'Perfil de cabeceras extra', description: 'Perfil cerrado de cabeceras compatibles; no permite introducir nombres o valores arbitrarios.', type: 'enum', section: 'transport', scope: 'provider', options: [{ value: 'none', label: 'Ninguno' }, { value: 'openrouter', label: 'OpenRouter' }], requiresRestart: false, sensitive: false, consumer: 'OpenAI-compatible adapter' },
    { key: 'cooldownMs', label: 'Cooldown normal', description: 'Tiempo de exclusión tras un fallo transitorio.', type: 'duration-ms', section: 'routing', scope: 'provider', min: 0, max: 86400000, requiresRestart: false, sensitive: false, consumer: 'routing health' },
    { key: 'rateLimitCooldownMs', label: 'Cooldown por límite', description: 'Tiempo de exclusión tras un 429.', type: 'duration-ms', section: 'routing', scope: 'provider', min: 0, max: 604800000, requiresRestart: false, sensitive: false, consumer: 'routing health' },
    { key: 'recordPenalty', label: 'Penalizar tras un fallo', description: 'Aplica penalización de prioridad cuando el proveedor falla.', type: 'boolean', section: 'routing', scope: 'provider', requiresRestart: false, sensitive: false, consumer: 'routing health' },
    { key: 'recordProviderFailure', label: 'Registrar fallo del proveedor', description: 'Registra el fallo para cooldown y diagnóstico.', type: 'boolean', section: 'routing', scope: 'provider', requiresRestart: false, sensitive: false, consumer: 'routing health' },
    { key: 'streaming', label: 'Streaming', description: 'El proveedor acepta respuestas en streaming.', type: 'boolean', section: 'capabilities', scope: 'provider', requiresRestart: false, sensitive: false, consumer: 'capability validator' },
    { key: 'tools', label: 'Herramientas', description: 'El proveedor acepta llamadas de herramientas.', type: 'boolean', section: 'capabilities', scope: 'provider', requiresRestart: false, sensitive: false, consumer: 'capability validator' },
    { key: 'reasoning', label: 'Razonamiento', description: 'El proveedor acepta controles de razonamiento.', type: 'boolean', section: 'capabilities', scope: 'provider', requiresRestart: false, sensitive: false, consumer: 'capability validator' },
    { key: 'multimodal', label: 'Multimodal', description: 'El proveedor declara entrada multimodal.', type: 'boolean', section: 'capabilities', scope: 'provider', requiresRestart: false, sensitive: false, consumer: 'capability validator' },
    { key: 'maxContextWindow', label: 'Ventana máxima declarada', description: 'Límite de contexto que el proveedor garantiza; vacío significa desconocido.', type: 'integer', section: 'capabilities', scope: 'provider', min: 1, max: 2000000, requiresRestart: false, sensitive: false, consumer: 'capability validator' },
    { key: 'bridgeVisible', label: 'Visible en el bridge', description: 'Publica el modelo en el selector aislado.', type: 'boolean', section: 'bridge', scope: 'model', requiresRestart: true, sensitive: false, consumer: 'Codex catalog projector' },
  ],
};
