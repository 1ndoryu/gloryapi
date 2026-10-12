const routingMetadataKeys = ['__parentRouteId', '__parentConfigurationRevision', '__parentSelectionReason'];

function attachRoutingMetadata(target, metadata) {
  if (!target || !metadata) return target;
  for (const [key, value] of Object.entries(metadata)) {
    if (value === undefined || value === null || value === '') continue;
    Object.defineProperty(target, key, {
      value,
      enumerable: false,
      configurable: true,
      writable: true,
    });
  }
  return target;
}

function routingMetadataFromHeaders(headers) {
  const routeId = headers.get('x-glory-route-id');
  const revisionText = headers.get('x-glory-configuration-revision');
  const selectionReason = headers.get('x-glory-selection-reason');
  const revision = Number(revisionText);
  return {
    __parentRouteId: routeId && /^[a-z][a-z0-9:_-]{1,127}$/.test(routeId) ? routeId : undefined,
    __parentConfigurationRevision: Number.isSafeInteger(revision) && revision >= 0 ? revision : undefined,
    __parentSelectionReason: selectionReason && /^[A-Za-z0-9._:-]{1,96}$/.test(selectionReason) ? selectionReason : undefined,
  };
}

function preserveCanaryProvider(source, target) {
  if (typeof source.__canaryProvider === 'string') {
    Object.defineProperty(target, '__canaryProvider', {
      value: source.__canaryProvider,
      enumerable: false,
    });
  }
  for (const key of ['__requestKind', '__parentRequestId', ...routingMetadataKeys]) {
    if (typeof source[key] === 'string' && source[key]) {
      Object.defineProperty(target, key, {
        value: source[key],
        enumerable: false,
      });
    }
  }
  return target;
}

function requestMetadataHeaders(chat) {
  const headers = {};
  if (typeof chat.__requestKind === 'string' && /^[a-z_]{1,32}$/.test(chat.__requestKind)) {
    headers['X-Glory-Request-Kind'] = chat.__requestKind;
  }
  if (typeof chat.__parentRequestId === 'string' && /^[A-Za-z0-9._:-]{1,96}$/.test(chat.__parentRequestId)) {
    headers['X-Glory-Parent-Request-Id'] = chat.__parentRequestId;
  }
  if (typeof chat.__parentRouteId === 'string' && /^[a-z][a-z0-9:_-]{1,127}$/.test(chat.__parentRouteId)) {
    headers['X-Glory-Parent-Route-Id'] = chat.__parentRouteId;
  }
  if (Number.isSafeInteger(chat.__parentConfigurationRevision) && chat.__parentConfigurationRevision >= 0) {
    headers['X-Glory-Parent-Configuration-Revision'] = String(chat.__parentConfigurationRevision);
  }
  if (typeof chat.__parentSelectionReason === 'string' && /^[A-Za-z0-9._:-]{1,96}$/.test(chat.__parentSelectionReason)) {
    headers['X-Glory-Parent-Selection-Reason'] = chat.__parentSelectionReason;
  }
  return headers;
}

module.exports = { attachRoutingMetadata, routingMetadataFromHeaders, preserveCanaryProvider, requestMetadataHeaders };
