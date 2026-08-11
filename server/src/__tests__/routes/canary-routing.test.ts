import { describe, expect, it } from 'vitest';
import { validateCanaryRoutingDirective } from '../../routes/routing/canary-routing.js';
import { resolveProxyModelSelection } from '../../routes/routing/proxy-selection.js';
import { getDb, initDb } from '../../db/index.js';
import type { ChatMessage } from '@gloryapi/shared/types.js';

const messages = [{ role: 'user', content: 'canary test' }] as ChatMessage[];

function seedRouteModels(): void {
  initDb(':memory:');
  const db = getDb();
  const insert = db.prepare(`
    INSERT OR IGNORE INTO models (platform, model_id, display_name, intelligence_rank, speed_rank, enabled)
    VALUES (?, ?, ?, ?, ?, 1)
  `);
  insert.run('andoryyu', 'deepseek-v4-flash', 'Andoryyu', 1, 1);
  insert.run('opencode-zen', 'deepseek-v4-flash-free', 'Zen', 2, 2);
  insert.run('opencode-go', 'deepseek-v4-flash', 'Go', 3, 3);
}

describe('authenticated canary routing', () => {
  it('rejects provider directives outside canary mode or with an invalid token', () => {
    expect(validateCanaryRoutingDirective('andoryyu', 'secret', { mode: '0', token: 'secret' })).toEqual({
      error: { code: 'canary_route_forbidden', message: 'Invalid canary routing directive' },
    });
    expect(validateCanaryRoutingDirective('andoryyu', 'wrong', { mode: '1', token: 'secret' })).toEqual({
      error: { code: 'canary_route_forbidden', message: 'Invalid canary routing directive' },
    });
  });

  it('rejects auto and undeclared explicit models instead of using global routing', () => {
    const auto = resolveProxyModelSelection('auto', messages, 'andoryyu');
    const unknown = resolveProxyModelSelection('some-model', messages, 'andoryyu');
    expect('error' in auto && auto.error.code).toBe('model_not_found');
    expect('error' in unknown && unknown.error.code).toBe('model_not_found');
  });

  it('restricts a valid canary provider to the declared override route', () => {
    seedRouteModels();
    const selection = resolveProxyModelSelection('deepseek-v4-flash', messages, 'opencode-go');
    if ('error' in selection) throw new Error(selection.error.message);
    expect(selection.restrictedChain).toHaveLength(1);
    expect(selection.preferredModel).toBe(selection.restrictedChain?.[0]);
  });
});
