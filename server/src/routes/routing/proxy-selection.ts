import type { ChatMessage } from '@gloryapi/shared/types.js';
import { MODEL_FALLBACK_OVERRIDES, getStickyModel, isAutoModel } from '../proxy-routing.js';
import { getDb } from '../../db/index.js';

export type ProxyModelSelection =
  | { preferredModel: number | undefined; restrictedChain: number[] | undefined }
  | { error: { code: 'model_not_found'; message: string } };

/** Resolve the client model hint without coupling catalog lookup to the HTTP handler. */
export function resolveProxyModelSelection(
  requestedModel: string | undefined,
  messages: ChatMessage[],
  canaryProvider?: string,
): ProxyModelSelection {
  if (isAutoModel(requestedModel)) {
    if (canaryProvider) {
      return {
        error: {
          code: 'model_not_found',
          message: `Canary provider '${canaryProvider}' requires an explicit declared model route; 'auto' cannot be used for canary routing.`,
        },
      };
    }
    return { preferredModel: undefined, restrictedChain: undefined };
  }

  if (requestedModel) {
    const overrideChain = MODEL_FALLBACK_OVERRIDES[requestedModel];
    if (canaryProvider && !overrideChain) {
      return {
        error: {
          code: 'model_not_found',
          message: `Canary provider '${canaryProvider}' requires a declared override route; model '${requestedModel}' has none.`,
        },
      };
    }
    if (overrideChain) {
      const db = getDb();
      if (canaryProvider) {
        const requestedRoute = overrideChain.find(entry => entry.platform === canaryProvider);
        if (requestedRoute) {
          const row = db.prepare(
            'SELECT id FROM models WHERE platform = ? AND model_id = ? AND enabled = 1',
          ).get(requestedRoute.platform, requestedRoute.modelId) as { id: number } | undefined;
          if (row) return { preferredModel: row.id, restrictedChain: [row.id] };
        }
        return {
          error: {
            code: 'model_not_found',
            message: `Canary provider '${canaryProvider}' is not part of the '${requestedModel}' route.`,
          },
        };
      }
      const resolvedChain: number[] = [];
      for (const entry of overrideChain) {
        const row = db.prepare(
          'SELECT id FROM models WHERE platform = ? AND model_id = ? AND enabled = 1',
        ).get(entry.platform, entry.modelId) as { id: number } | undefined;
        if (row) resolvedChain.push(row.id);
      }
      if (resolvedChain.length === 0) {
        return { error: {
          code: 'model_not_found',
          message: `Model override chain for '${requestedModel}' resolved to no available models. Check that the catalog models are enabled.`,
        } };
      }
      // Sticky de sesión: aunque el cliente pida un modelo explícito con cadena
      // de fallback (Codex Desktop siempre manda model="deepseek-v4-flash"), si
      // esta conversación ya tuvo éxito con un proveedor de la cadena, se vuelve
      // a intentar ese primero. Sin esto, cada request vuelve a empezar por el
      // primer proveedor gratuito y el modelo "salta" de proveedor en cada turno
      // (y martillea pools gratuitos con cuota diaria). El sticky se intenta
      // primero; la cadena sigue cubriendo el fallback si falla.
      const stickyModelDbId = getStickyModel(messages);
      return {
        preferredModel: stickyModelDbId !== undefined && resolvedChain.includes(stickyModelDbId) ? stickyModelDbId : undefined,
        restrictedChain: resolvedChain,
      };
    }

    const db = getDb();
    const enabledModels = db.prepare(`
      SELECT m.id, m.platform
      FROM models m
      LEFT JOIN fallback_config fc ON fc.model_db_id = m.id
      WHERE m.model_id = ? AND m.enabled = 1
      ORDER BY COALESCE(fc.priority, 999999) ASC
    `).all(requestedModel) as { id: number; platform: string }[];
    if (enabledModels.length > 0) {
      const keysByPlatform = db.prepare(
        'SELECT platform FROM api_keys WHERE enabled = 1 AND status != ?',
      ).all('invalid') as { platform: string }[];
      const platformsWithKeys = new Set(keysByPlatform.map(key => key.platform));
      const modelWithKey = enabledModels.find(model => platformsWithKeys.has(model.platform));
      return { preferredModel: (modelWithKey ?? enabledModels[0]).id, restrictedChain: undefined };
    }

    const disabled = db.prepare('SELECT id FROM models WHERE model_id = ?').get(requestedModel) as { id: number } | undefined;
    const reason = disabled ? 'is disabled' : 'is not in the catalog';
    return { error: {
      code: 'model_not_found',
      message: `Model '${requestedModel}' ${reason}. Use 'auto' (or omit the 'model' field) to auto-route, or call /v1/models for the available list.`,
    } };
  }

  if (canaryProvider) {
    return {
      error: {
        code: 'model_not_found',
        message: `Canary provider '${canaryProvider}' requires an explicit declared model route.`,
      },
    };
  }
  return { preferredModel: getStickyModel(messages), restrictedChain: undefined };
}
