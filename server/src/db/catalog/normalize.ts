import Database from 'better-sqlite3';

export function normalizeGloryCatalog(db: Database.Database): void {
  const targetModels = [
    {
      platform: 'andoryyu',
      modelId: 'deepseek-v4-flash',
      displayName: 'DeepSeek V4 Flash (Andoryyu)',
      intelligenceRank: 1,
      speedRank: 1,
      sizeLabel: 'Frontier',
      contextWindow: 131072,
    },
    {
      platform: 'opencode-zen',
      modelId: 'deepseek-v4-flash-free',
      displayName: 'DeepSeek V4 Flash (Zen)',
      intelligenceRank: 2,
      speedRank: 2,
      sizeLabel: 'Frontier',
      contextWindow: 131072,
    },
    {
      platform: 'tokenharbor',
      modelId: 'deepseek-v4-flash:free',
      displayName: 'DeepSeek V4 Flash (TokenHarbor Free)',
      intelligenceRank: 3,
      speedRank: 3,
      sizeLabel: 'Frontier',
      // TokenHarbor's public compatibility contract does not establish a
      // context limit; keep the capability gate fail-closed until discovery.
      contextWindow: null,
    },
    {
      platform: 'opencode-go',
      modelId: 'deepseek-v4-flash',
      displayName: 'DeepSeek V4 Flash (Go)',
      intelligenceRank: 4,
      speedRank: 4,
      sizeLabel: 'Frontier',
      contextWindow: 131072,
    },
    // CommandCode es un proveedor de pago seleccionable explícitamente. Sus
    // modelos NO entran en la cadena `auto` (fallback_config) para no gastar
    // crédito sin que el usuario lo pida: quedan como modelos "explicit-only"
    // alcanzables vía `model` y con cadena restringida a su propio proveedor.
    {
      platform: 'commandcode',
      modelId: 'deepseek/deepseek-v4-flash',
      displayName: 'DeepSeek V4 Flash (CommandCode)',
      intelligenceRank: 5,
      speedRank: 5,
      sizeLabel: 'Frontier',
      contextWindow: 1048576,
      explicitOnly: true,
    },
    {
      platform: 'commandcode',
      modelId: 'meta/muse-spark-1.2-contributor',
      displayName: 'Muse Spark 1.2 Contributor (CommandCode)',
      intelligenceRank: 6,
      speedRank: 6,
      sizeLabel: 'Frontier',
      // Muse Spark 1.2 acepta texto e imágenes de forma nativa (visión) con
      // ventana de ~1.05M tokens según la documentación oficial de CommandCode.
      contextWindow: 1050000,
      explicitOnly: true,
    },
    {
      platform: 'commandcode',
      modelId: 'deepseek/deepseek-v4-pro',
      displayName: 'DeepSeek V4 Pro (CommandCode)',
      intelligenceRank: 7,
      speedRank: 7,
      sizeLabel: 'Frontier',
      contextWindow: 1048576,
      explicitOnly: true,
    },
  ] as const;

  const keepModelClauses = targetModels.map(() => '(platform = ? AND model_id = ?)').join(' OR ');
  const explicitOnlyModels = targetModels.filter(model => 'explicitOnly' in model && model.explicitOnly);
  const explicitOnlyClauses = explicitOnlyModels.map(() => '(platform = ? AND model_id = ?)').join(' OR ');
  const deleteStaleFallback = db.prepare(`
    DELETE FROM fallback_config
    WHERE model_db_id IN (
      SELECT id FROM models
      WHERE NOT (${keepModelClauses})
    )
  `);
  const deleteExplicitOnlyFallback = explicitOnlyClauses
    ? db.prepare(`
        DELETE FROM fallback_config
        WHERE model_db_id IN (
          SELECT id FROM models
          WHERE ${explicitOnlyClauses}
        )
      `)
    : undefined;
  const deleteOtherModels = db.prepare(`
    DELETE FROM models
    WHERE NOT (${keepModelClauses})
  `);
  const insertModel = db.prepare(`
    INSERT OR IGNORE INTO models (
      platform, model_id, display_name, intelligence_rank, speed_rank,
      size_label, context_window, enabled
    ) VALUES (?, ?, ?, ?, ?, ?, ?, 1)
  `);
  const updateModel = db.prepare(`
    UPDATE models SET display_name = ?, intelligence_rank = ?, speed_rank = ?,
      size_label = ?, context_window = ?
    WHERE platform = ? AND model_id = ?
  `);
  const findModel = db.prepare('SELECT id FROM models WHERE platform = ? AND model_id = ?');
  const findFallback = db.prepare('SELECT id FROM fallback_config WHERE model_db_id = ?');
  const maxFallbackPriority = db.prepare('SELECT COALESCE(MAX(priority), 0) AS priority FROM fallback_config');
  const insertFallback = db.prepare(
    'INSERT INTO fallback_config (model_db_id, priority, enabled) VALUES (?, ?, 1)',
  );

  db.transaction(() => {
    /*
     * Catalog normalization is a schema/reconciliation step, not a user
     * preference reset. Remove only obsolete rows; existing model and
     * fallback state is intentionally preserved across every server start.
     */
    deleteStaleFallback.run(...targetModels.flatMap(model => [model.platform, model.modelId]));
    deleteOtherModels.run(...targetModels.flatMap(model => [model.platform, model.modelId]));
    for (const model of targetModels) {
      insertModel.run(
        model.platform,
        model.modelId,
        model.displayName,
        model.intelligenceRank,
        model.speedRank,
        model.sizeLabel,
        model.contextWindow,
      );
      updateModel.run(
        model.displayName,
        model.intelligenceRank,
        model.speedRank,
        model.sizeLabel,
        model.contextWindow,
        model.platform,
        model.modelId,
      );
      const row = findModel.get(model.platform, model.modelId) as { id: number } | undefined;
      if (!row) throw new Error(`Catalog normalization failed for ${model.platform}/${model.modelId}`);
    }
    // Explicit-only models (CommandCode) stay out of the automatic `auto`
    // fallback chain; remove any stale rows if an older catalog inserted them.
    if (deleteExplicitOnlyFallback) {
      deleteExplicitOnlyFallback.run(...explicitOnlyModels.flatMap(model => [model.platform, model.modelId]));
    }
    // Add only missing fallback rows. Existing priority and enabled values are
    // routing policy, so they must survive catalog normalization unchanged.
    const maxPriorityRow = maxFallbackPriority.get() as { priority: number };
    let nextPriority = maxPriorityRow.priority;
    for (const model of targetModels) {
      if ('explicitOnly' in model && model.explicitOnly) continue;
      const row = findModel.get(model.platform, model.modelId) as { id: number } | undefined;
      if (!row) throw new Error(`Catalog normalization failed for ${model.platform}/${model.modelId}`);
      if (!findFallback.get(row.id)) insertFallback.run(row.id, ++nextPriority);
    }
    const columns = new Set(
      (db.prepare('PRAGMA table_info(models)').all() as Array<{ name: string }>).map(column => column.name),
    );
    if (columns.has('monthly_token_budget')) db.exec('ALTER TABLE models DROP COLUMN monthly_token_budget');
    db.prepare("INSERT INTO settings (key, value) VALUES ('catalog_schema_version', 'glory-v1') ON CONFLICT(key) DO UPDATE SET value = excluded.value").run();
  })();
}
