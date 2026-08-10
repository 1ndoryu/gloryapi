import crypto from 'node:crypto';
import type { RouteResult } from './router.js';
import type { RoutingRuntimeModel, RoutingRuntimeSnapshot } from '@gloryapi/shared/types.js';
import { publishRoutingRuntimeChanged } from './routing-events.js';

type RuntimeAttempt = RoutingRuntimeModel & { modelDbId: number };

const attempts = new Map<string, RuntimeAttempt>();
let lastCompleted: RoutingRuntimeSnapshot['lastCompleted'] = null;

function snapshot(): RoutingRuntimeSnapshot {
  return {
    schemaVersion: 'glory-routing-runtime-v1',
    inFlight: [...attempts.values()].map(({ attemptId, modelDbId, platform, modelId, startedAt }) => ({
      attemptId,
      modelDbId,
      platform,
      modelId,
      startedAt,
    })),
    lastCompleted,
  };
}

function publish(): void {
  publishRoutingRuntimeChanged(snapshot());
}

export function getRoutingRuntimeSnapshot(): RoutingRuntimeSnapshot {
  return snapshot();
}

export function beginRoutingAttempt(route: Pick<RouteResult, 'modelDbId' | 'platform' | 'modelId'>): string {
  const attemptId = crypto.randomUUID();
  attempts.set(attemptId, {
    attemptId,
    modelDbId: route.modelDbId,
    platform: route.platform,
    modelId: route.modelId,
    startedAt: new Date().toISOString(),
  });
  publish();
  return attemptId;
}

export function finishRoutingAttempt(attemptId: string, outcome: 'success' | 'error', route: Pick<RouteResult, 'modelDbId' | 'platform' | 'modelId'>): void {
  const attempt = attempts.get(attemptId);
  if (!attempt) return;
  attempts.delete(attemptId);
  if (outcome === 'success') {
    lastCompleted = {
      modelDbId: route.modelDbId,
      platform: route.platform,
      modelId: route.modelId,
      completedAt: new Date().toISOString(),
    };
  }
  publish();
}

/** Test-only reset; runtime state is process-local and never persisted as routing policy. */
export function resetRoutingRuntimeForTests(): void {
  attempts.clear();
  lastCompleted = null;
}
