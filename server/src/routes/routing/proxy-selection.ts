import type { ChatMessage } from '@gloryapi/shared/types.js';
import { getStickyModel, isAutoModel } from '../proxy-routing.js';
import { getDb } from '../../db/index.js';
import { AUTO_ROUTE_ID, getRouteModelIds, resolveClientCatalogEntry } from '../../services/configuration-v2.js';

export type ProxyModelSelection =
  | { preferredModel: number | undefined; restrictedChain: number[] | undefined; routeId?: string; selectionReason?: string; selectionConfidence?: 'persisted' | 'legacy' | 'unknown' }
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
    const route = getRouteModelIds(AUTO_ROUTE_ID);
    return route.length > 0
      ? { preferredModel: (() => { const sticky = getStickyModel(messages); return sticky !== undefined && route.includes(sticky) ? sticky : undefined })(), restrictedChain: route, routeId: AUTO_ROUTE_ID, selectionReason: 'auto_route', selectionConfidence: 'persisted' }
      : { error: { code: 'model_not_found', message: 'The auto route has no enabled members.' } };
  }

  if (requestedModel) {
    let catalogEntry;
    try {
      catalogEntry = resolveClientCatalogEntry(requestedModel);
    } catch {
      // Canary validation must still return a structured model_not_found when
      // a pure unit caller has not initialized a database yet.
      if (canaryProvider) return { error: { code: 'model_not_found', message: `Canary provider '${canaryProvider}' requires a persisted explicit route.` } };
      throw new Error('Database not initialized. Call initDb() first.');
    }
    if (canaryProvider && (!catalogEntry || catalogEntry.routeId === AUTO_ROUTE_ID)) {
      const canaryModel = getDb().prepare(`
        SELECT id FROM models WHERE platform = ? AND model_id = ? AND enabled = 1 LIMIT 1
      `).get(canaryProvider, requestedModel) as { id: number } | undefined;
      if (canaryModel) return { preferredModel: canaryModel.id, restrictedChain: [canaryModel.id], routeId: `route:model:${canaryProvider}`, selectionReason: 'canary_model', selectionConfidence: 'persisted' };
      return {
        error: {
          code: 'model_not_found',
          message: `Canary provider '${canaryProvider}' requires a persisted explicit route; model '${requestedModel}' is not pinned.`,
        },
      };
    }
    if (catalogEntry) {
      const resolvedChain = getRouteModelIds(catalogEntry.routeId);
      if (resolvedChain.length === 0) {
        return { error: {
          code: 'model_not_found',
          message: `The configured route for '${requestedModel}' has no enabled models.`,
        } };
      }
      if (canaryProvider) {
        const row = getDb().prepare('SELECT id FROM models WHERE id IN (' + resolvedChain.map(() => '?').join(',') + ') AND platform = ? AND enabled = 1 LIMIT 1')
          .get(...resolvedChain, canaryProvider) as { id: number } | undefined;
        if (row) return { preferredModel: row.id, restrictedChain: [row.id], routeId: catalogEntry.routeId, selectionReason: 'canary_catalog', selectionConfidence: 'persisted' };
        return {
          error: {
            code: 'model_not_found',
            message: `Canary provider '${canaryProvider}' is not part of the persisted route for '${requestedModel}'.`,
          },
        };
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
        routeId: catalogEntry.routeId,
        selectionReason: stickyModelDbId !== undefined && resolvedChain.includes(stickyModelDbId) ? 'explicit_catalog_sticky' : 'explicit_catalog',
        selectionConfidence: 'persisted',
      };
    }

    const db = getDb();
    const enabledModels = db.prepare(`
      SELECT m.id, m.platform
      FROM models m
      WHERE m.model_id = ? AND m.enabled = 1
      ORDER BY m.intelligence_rank ASC, m.speed_rank ASC
    `).all(requestedModel) as { id: number; platform: string }[];
    if (enabledModels.length > 0) {
      const keysByPlatform = db.prepare(
        'SELECT platform FROM api_keys WHERE enabled = 1 AND status != ?',
      ).all('invalid') as { platform: string }[];
      const platformsWithKeys = new Set(keysByPlatform.map(key => key.platform));
      const modelWithKey = enabledModels.find(model => platformsWithKeys.has(model.platform));
      // A model id that is not published through the catalog projection is
      // still an explicit identity, never an invitation to enter Auto. If it
      // resolves to one row, pin it to that one row; duplicate legacy ids are
      // ordered by the persisted catalog/priority above.
      if (enabledModels.length === 1) {
        return { preferredModel: undefined, restrictedChain: [enabledModels[0].id], selectionReason: 'legacy_model_id', selectionConfidence: 'legacy' };
      }
      return { preferredModel: (modelWithKey ?? enabledModels[0]).id, restrictedChain: enabledModels.map(model => model.id), selectionReason: 'legacy_model_id', selectionConfidence: 'legacy' };
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
  return { preferredModel: getStickyModel(messages), restrictedChain: getRouteModelIds(AUTO_ROUTE_ID), routeId: AUTO_ROUTE_ID, selectionReason: 'implicit_auto', selectionConfidence: 'persisted' };
}
