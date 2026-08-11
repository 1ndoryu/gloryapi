import { describe, expect, it, beforeEach } from 'vitest';
import { resolveProxyModelSelection } from '../../routes/routing/proxy-selection.js';
import { getDb, initDb } from '../../db/index.js';
import { PROVIDER_FAILURE_POLICY, getStickyModel, setStickyModel } from '../../routes/proxy-routing.js';
import type { ChatMessage } from '@gloryapi/shared/types.js';

const STABLE_USER_PROMPT = 'Mensaje de usuario estable para la sesion de prueba';

function buildMessages(withAssistant: boolean): ChatMessage[] {
  const messages = [
    { role: 'system', content: 'You are a helpful assistant.' },
    { role: 'user', content: STABLE_USER_PROMPT },
  ] as ChatMessage[];
  if (withAssistant) messages.push({ role: 'assistant', content: 'Claro, sigamos.' } as ChatMessage);
  return messages;
}

function insertCatalogModels(): void {
  const db = getDb();
  // El catálogo legacy ya siembra andoryyu/zen/go en :memory:; el OR IGNORE
  // garantiza idempotencia y añade solo el modelo fuera de la cadena.
  const insert = db.prepare(`
    INSERT OR IGNORE INTO models (platform, model_id, display_name, intelligence_rank, speed_rank, enabled)
    VALUES (?, ?, ?, ?, ?, 1)
  `);
  insert.run('andoryyu', 'deepseek-v4-flash', 'DeepSeek V4 Flash (Andoryyu)', 1, 1);
  insert.run('opencode-zen', 'deepseek-v4-flash-free', 'DeepSeek V4 Flash Free (Zen)', 2, 2);
  insert.run('opencode-go', 'deepseek-v4-flash', 'DeepSeek V4 Flash (Go)', 3, 3);
  insert.run('andoryyu', 'deepseek-v3', 'DeepSeek V3 (Andoryyu)', 4, 4);
}

function queryCatalogIds(): { andoryyuId: number; zenId: number; goId: number; otherId: number } {
  const db = getDb();
  const byModel = (modelId: string) =>
    (db.prepare('SELECT id FROM models WHERE model_id = ?').get(modelId) as { id: number }).id;
  return { andoryyuId: byModel('deepseek-v4-flash'), zenId: byModel('deepseek-v4-flash-free'), goId: byModel('deepseek-v4-flash'), otherId: byModel('deepseek-v3') };
}

describe('resolveProxyModelSelection — sticky en cadenas explícitas', () => {
  beforeEach(() => {
    initDb(':memory:');
    insertCatalogModels();
  });

  it('resuelve la cadena deepseek-v4-flash sin sticky (preferredModel undefined)', () => {
    const selection = resolveProxyModelSelection('deepseek-v4-flash', buildMessages(true));
    if ('error' in selection) throw new Error(selection.error.message);
    expect(selection.preferredModel).toBeUndefined();
    expect(selection.restrictedChain).toHaveLength(3);
  });

  it('prefiere el modelo sticky de la sesión aunque el cliente pida modelo explícito', () => {
    const { goId } = queryCatalogIds();
    const messages = buildMessages(true);
    // opencode-go tuvo éxito en esta conversación -> sticky apunta a go.
    setStickyModel(messages, goId);
    expect(getStickyModel(messages)).toBe(goId);

    const selection = resolveProxyModelSelection('deepseek-v4-flash', messages);
    if ('error' in selection) throw new Error(selection.error.message);
    expect(selection.preferredModel).toBe(goId);
    expect(selection.restrictedChain).toContain(goId);
    expect(selection.restrictedChain).toHaveLength(3);
  });

  it('ignora el sticky si el modelo sticky no pertenece a la cadena', () => {
    const { otherId } = queryCatalogIds();
    const messages = buildMessages(true);
    setStickyModel(messages, otherId);
    expect(getStickyModel(messages)).toBe(otherId);

    const selection = resolveProxyModelSelection('deepseek-v4-flash', messages);
    if ('error' in selection) throw new Error(selection.error.message);
    expect(selection.preferredModel).toBeUndefined();
    expect(selection.restrictedChain).toHaveLength(3);
  });

  it('no aplica sticky a requests sin mensaje assistant previo', () => {
    const { goId } = queryCatalogIds();
    const withAssistant = buildMessages(true);
    setStickyModel(withAssistant, goId);

    const selection = resolveProxyModelSelection('deepseek-v4-flash', buildMessages(false));
    if ('error' in selection) throw new Error(selection.error.message);
    expect(selection.preferredModel).toBeUndefined();
  });
});

describe('PROVIDER_FAILURE_POLICY — cooldowns por clase de fallo', () => {
  it('opencode-zen escala a 4h cuando el fallo es rate_limited (cuota diaria)', () => {
    expect(PROVIDER_FAILURE_POLICY['opencode-zen'].cooldownMs).toBe(300_000);
    expect(PROVIDER_FAILURE_POLICY['opencode-zen'].rateLimitCooldownMs).toBe(4 * 60 * 60 * 1000);
  });

  it('andoryyu mantiene cadencia moderada sin escalado (pool de cuentas, límite desconocido)', () => {
    expect(PROVIDER_FAILURE_POLICY.andoryyu.cooldownMs).toBe(300_000);
    expect(PROVIDER_FAILURE_POLICY.andoryyu.rateLimitCooldownMs).toBeUndefined();
  });

  it('opencode-go sigue con cooldown 0 (último recurso de pago, reintento inmediato)', () => {
    expect(PROVIDER_FAILURE_POLICY['opencode-go'].cooldownMs).toBe(0);
  });
});
