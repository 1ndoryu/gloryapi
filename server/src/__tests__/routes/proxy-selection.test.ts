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
  insert.run('tokenharbor', 'deepseek-v4-flash:free', 'DeepSeek V4 Flash (TokenHarbor Free)', 3, 3);
  insert.run('opencode-go', 'deepseek-v4-flash', 'DeepSeek V4 Flash (Go)', 4, 4);
  insert.run('andoryyu', 'deepseek-v3', 'DeepSeek V3 (Andoryyu)', 5, 5);
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

  it('resuelve Auto únicamente desde la ruta persistida y sin alias legacy', () => {
    const selection = resolveProxyModelSelection('auto', buildMessages(true));
    if ('error' in selection) throw new Error(selection.error.message);
    expect(selection.preferredModel).toBeUndefined();
    expect(selection.restrictedChain?.length).toBeGreaterThan(1);
  });

  it('prefiere el modelo sticky de la sesión aunque el cliente pida modelo explícito', () => {
    const { goId } = queryCatalogIds();
    const messages = buildMessages(true);
    // opencode-go tuvo éxito en esta conversación -> sticky apunta a go.
    setStickyModel(messages, goId);
    expect(getStickyModel(messages)).toBe(goId);

    const selection = resolveProxyModelSelection('auto', messages);
    if ('error' in selection) throw new Error(selection.error.message);
    expect(selection.preferredModel).toBe(goId);
    expect(selection.restrictedChain).toContain(goId);
    expect(selection.restrictedChain?.length).toBeGreaterThan(1);
  });

  it('ignora el sticky si el modelo sticky no pertenece a la cadena', () => {
    const { otherId } = queryCatalogIds();
    const messages = buildMessages(true);
    setStickyModel(messages, otherId);
    expect(getStickyModel(messages)).toBe(otherId);

    const selection = resolveProxyModelSelection('auto', messages);
    if ('error' in selection) throw new Error(selection.error.message);
    expect(selection.preferredModel).toBeUndefined();
    expect(selection.restrictedChain?.length).toBeGreaterThan(1);
  });

  it('no aplica sticky a requests sin mensaje assistant previo', () => {
    const { goId } = queryCatalogIds();
    const withAssistant = buildMessages(true);
    setStickyModel(withAssistant, goId);

    const selection = resolveProxyModelSelection('auto', buildMessages(false));
    if ('error' in selection) throw new Error(selection.error.message);
    expect(selection.preferredModel).toBeUndefined();
  });

  it('mantiene el ID :free fijado a TokenHarbor', () => {
    const selection = resolveProxyModelSelection('deepseek-v4-flash:free', buildMessages(false));
    if ('error' in selection) throw new Error(selection.error.message);
    expect(selection.preferredModel).toBeUndefined();
    expect(selection.restrictedChain).toHaveLength(1);
    const row = getDb().prepare('SELECT id FROM models WHERE platform = ? AND model_id = ?').get('tokenharbor', 'deepseek-v4-flash:free') as { id: number };
    expect(selection.restrictedChain?.[0]).toBe(row.id);
  });

  it('fija cada modelo CommandCode a su propio proveedor (cadena de un solo eslabón)', () => {
    const commandCodeModels = [
      'deepseek/deepseek-v4-flash',
      'meta/muse-spark-1.2-contributor',
    ];
    for (const modelId of commandCodeModels) {
      const db = getDb();
      db.prepare(`
        INSERT OR IGNORE INTO models (platform, model_id, display_name, intelligence_rank, speed_rank, enabled)
        VALUES ('commandcode', ?, 'CommandCode', 9, 9, 1)
      `).run(modelId);
      const selection = resolveProxyModelSelection(modelId, buildMessages(false));
      if ('error' in selection) throw new Error(`${modelId}: ${selection.error.message}`);
      expect(selection.restrictedChain).toHaveLength(1);
      const row = db.prepare('SELECT id FROM models WHERE platform = ? AND model_id = ?')
        .get('commandcode', modelId) as { id: number };
      expect(selection.restrictedChain?.[0]).toBe(row.id);
    }
  });

  it('DeepSeek V4 Pro retirado devuelve model_not_found', () => {
    const selection = resolveProxyModelSelection('deepseek/deepseek-v4-pro', buildMessages(false));
    if (!('error' in selection)) throw new Error('expected model_not_found for a missing CommandCode row');
    expect(selection.error.code).toBe('model_not_found');
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
