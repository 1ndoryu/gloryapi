import { beforeEach, describe, expect, it } from 'vitest';
import {
  beginRoutingAttempt,
  finishRoutingAttempt,
  getRoutingRuntimeSnapshot,
  resetRoutingRuntimeForTests,
} from '../../services/routing-runtime.js';

describe('Routing runtime state', () => {
  const firstRoute = { modelDbId: 11, platform: 'andoryyu', modelId: 'deepseek-v4-flash' } as const;
  const secondRoute = { modelDbId: 12, platform: 'opencode-zen', modelId: 'deepseek-v4-flash-free' } as const;

  beforeEach(() => resetRoutingRuntimeForTests());

  it('tracks concurrent attempts without changing the configured policy', () => {
    const firstAttempt = beginRoutingAttempt(firstRoute);
    const secondAttempt = beginRoutingAttempt(secondRoute);
    const snapshot = getRoutingRuntimeSnapshot();

    expect(snapshot.schemaVersion).toBe('glory-routing-runtime-v1');
    expect(snapshot.inFlight).toHaveLength(2);
    expect(snapshot.inFlight.map(attempt => attempt.modelDbId)).toEqual([11, 12]);
    expect(snapshot.inFlight[0]).not.toHaveProperty('apiKey');
    expect(snapshot.lastCompleted).toBeNull();

    finishRoutingAttempt(firstAttempt, 'error', firstRoute);
    const afterFailure = getRoutingRuntimeSnapshot();
    expect(afterFailure.inFlight.map(attempt => attempt.modelDbId)).toEqual([12]);
    expect(afterFailure.lastCompleted).toBeNull();

    finishRoutingAttempt(secondAttempt, 'success', secondRoute);
    const afterSuccess = getRoutingRuntimeSnapshot();
    expect(afterSuccess.inFlight).toHaveLength(0);
    expect(afterSuccess.lastCompleted).toMatchObject({
      modelDbId: 12,
      platform: 'opencode-zen',
      modelId: 'deepseek-v4-flash-free',
    });
  });

  it('ignores duplicate completion and does not persist runtime across reset', () => {
    const attempt = beginRoutingAttempt(firstRoute);
    finishRoutingAttempt(attempt, 'success', firstRoute);
    finishRoutingAttempt(attempt, 'success', secondRoute);

    expect(getRoutingRuntimeSnapshot().lastCompleted).toMatchObject({ modelDbId: 11 });
    resetRoutingRuntimeForTests();
    expect(getRoutingRuntimeSnapshot()).toEqual({
      schemaVersion: 'glory-routing-runtime-v1',
      inFlight: [],
      lastCompleted: null,
    });
  });
});
