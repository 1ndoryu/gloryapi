import { Router } from 'express';
import type { NextFunction, Request, Response } from 'express';
import { backupDatabase, getUnifiedApiKey, regenerateUnifiedKey } from '../db/index.js';
import {
  getProviderSettingsSnapshot,
  getSettingsSnapshot,
  SettingsRevisionConflictError,
  SettingsValidationError,
  updateModelSettings,
  updateProviderSettings,
  updateSettings,
} from '../settings/registry.js';
import { z } from 'zod';
import { requireAdmin } from '../lib/admin-auth.js';

export const settingsRouter = Router();

const settingsUpdateSchema = z.object({
  expectedRevision: z.number().int().nonnegative().optional(),
  values: z.record(z.unknown()),
}).strict();

// Get the unified API key
settingsRouter.get('/api-key', (_req: Request, res: Response) => {
  res.json({ apiKey: getUnifiedApiKey() });
});

// Regenerate the unified API key
settingsRouter.post('/api-key/regenerate', (_req: Request, res: Response) => {
  const newKey = regenerateUnifiedKey();
  res.json({ apiKey: newKey });
});

settingsRouter.get('/', (_req: Request, res: Response) => {
  res.json(getSettingsSnapshot());
});

settingsRouter.patch('/', (req: Request, res: Response) => {
  if (!requireAdmin(req, res)) return;
  const parsed = settingsUpdateSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: { message: parsed.error.errors.map(error => error.message).join(', ') } });
    return;
  }

  try {
    res.json(updateSettings(parsed.data.values, parsed.data.expectedRevision));
  } catch (error) {
    if (error instanceof SettingsRevisionConflictError) {
      res.status(409).json({
        error: { message: error.message, code: 'settings_revision_conflict' },
        currentRevision: error.currentRevision,
      });
      return;
    }
    if (error instanceof SettingsValidationError) {
      res.status(400).json({ error: { message: error.message, code: 'invalid_setting' } });
      return;
    }
    throw error;
  }
});

settingsRouter.get('/providers', (_req: Request, res: Response) => {
  res.json(getProviderSettingsSnapshot());
});

settingsRouter.patch('/providers/:platform', (req: Request, res: Response) => {
  if (!requireAdmin(req, res)) return;
  const platform = typeof req.params.platform === 'string' ? req.params.platform : '';
  const parsed = settingsUpdateSchema.safeParse(req.body);
  if (!parsed.success || !Object.prototype.hasOwnProperty.call(parsed.data.values, 'overrides')) {
    res.status(400).json({ error: { message: 'Request must contain an overrides object' } });
    return;
  }
  try {
    res.json(updateProviderSettings(platform, parsed.data.values.overrides, parsed.data.expectedRevision));
  } catch (error) {
    if (error instanceof SettingsRevisionConflictError) {
      res.status(409).json({ error: { message: error.message, code: 'settings_revision_conflict' }, currentRevision: error.currentRevision });
      return;
    }
    if (error instanceof SettingsValidationError) {
      res.status(400).json({ error: { message: error.message, code: 'invalid_setting' } });
      return;
    }
    throw error;
  }
});

settingsRouter.patch('/providers/:platform/models/:modelId', (req: Request, res: Response) => {
  if (!requireAdmin(req, res)) return;
  const platform = typeof req.params.platform === 'string' ? req.params.platform : '';
  const modelId = typeof req.params.modelId === 'string' ? req.params.modelId : '';
  const parsed = settingsUpdateSchema.safeParse(req.body);
  if (!parsed.success || !Object.prototype.hasOwnProperty.call(parsed.data.values, 'overrides')) {
    res.status(400).json({ error: { message: 'Request must contain an overrides object' } });
    return;
  }
  try {
    res.json(updateModelSettings(platform, modelId, parsed.data.values.overrides, parsed.data.expectedRevision));
  } catch (error) {
    if (error instanceof SettingsRevisionConflictError) {
      res.status(409).json({ error: { message: error.message, code: 'settings_revision_conflict' }, currentRevision: error.currentRevision });
      return;
    }
    if (error instanceof SettingsValidationError) {
      res.status(400).json({ error: { message: error.message, code: 'invalid_setting' } });
      return;
    }
    throw error;
  }
});

settingsRouter.post('/backup', async (req: Request, res: Response, next: NextFunction) => {
  if (!requireAdmin(req, res)) return;

  try {
    const backup = await backupDatabase();
    res.status(201).json({
      backupId: backup.backupId,
      sizeBytes: backup.sizeBytes,
      sha256: backup.sha256,
      createdAt: backup.createdAt,
      durability: backup.durability,
    });
  } catch (error) {
    next(error);
  }
});
