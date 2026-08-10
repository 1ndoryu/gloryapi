import { Router } from 'express';
import type { Request, Response } from 'express';
import { z } from 'zod';
import { getDb } from '../db/index.js';
import { maskKey } from '../lib/crypto.js';
import { credentialVault, DPAPI_ENCRYPTION_SCHEME, resolveStoredCredential } from '../lib/dpapi-vault.js';
import { ACTIVE_PROVIDER_PLATFORMS, ARCHIVED_PROVIDER_PLATFORMS } from '../providers/registry.js';
import { requireAdmin } from '../lib/admin-auth.js';

export const keysRouter = Router();
keysRouter.use((req, res, next) => {
  if (requireAdmin(req, res)) next();
});

type ApiKeyRow = {
  id: number;
  platform: string;
  label: string;
  encrypted_key: string;
  iv: string;
  auth_tag: string;
  encryption_scheme: string;
  fingerprint: string | null;
  status: string;
  enabled: number;
  created_at: string;
  last_checked_at: string | null;
};

const addKeySchema = z.object({
  platform: z.string().trim().regex(/^[a-z][a-z0-9-]{1,63}$/, 'platform must be a stable lowercase slug'),
  key: z.string().min(1),
  label: z.string().optional(),
});

function canStoreCredential(platform: string): boolean {
  if ((ACTIVE_PROVIDER_PLATFORMS as readonly string[]).includes(platform)) return true;
  if (process.env.NODE_ENV === 'test' && (ARCHIVED_PROVIDER_PLATFORMS as readonly string[]).includes(platform)) return true;
  const draft = getDb().prepare(
    "SELECT 1 FROM provider_registry WHERE platform = ? AND lifecycle = 'draft'",
  ).get(platform);
  return Boolean(draft);
}

// List all keys (masked)
keysRouter.get('/', (_req: Request, res: Response) => {
  const db = getDb();
  const rows = db.prepare('SELECT * FROM api_keys ORDER BY created_at DESC').all() as ApiKeyRow[];

  const keys = rows.map(row => {
    let maskedKey = '****';
    try {
      const realKey = resolveStoredCredential(row);
      maskedKey = maskKey(realKey);
    } catch {
      maskedKey = '[decrypt failed]';
    }
    return {
      id: row.id,
      platform: row.platform,
      label: row.label,
      maskedKey,
      status: row.status,
      enabled: row.enabled === 1,
      createdAt: row.created_at,
      lastCheckedAt: row.last_checked_at,
    };
  });

  res.json(keys);
});

// Add a key
keysRouter.post('/', (req: Request, res: Response) => {
  const parsed = addKeySchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: { message: parsed.error.errors.map(e => e.message).join(', ') } });
    return;
  }

  const { platform, key, label } = parsed.data;
  if (!canStoreCredential(platform)) {
    res.status(400).json({ error: { message: 'Provider is not registered or does not have an active draft' } });
    return;
  }
  const protectedCredential = credentialVault.protect(key);

  const db = getDb();
  const result = db.prepare(`
    INSERT INTO api_keys (
      platform, label, encrypted_key, iv, auth_tag, encryption_scheme, fingerprint, status, enabled
    ) VALUES (?, ?, ?, '', '', ?, ?, 'unknown', 1)
  `).run(
    platform,
    label ?? '',
    protectedCredential.ciphertext,
    DPAPI_ENCRYPTION_SCHEME,
    protectedCredential.fingerprint,
  );

  res.status(201).json({
    id: result.lastInsertRowid,
    platform,
    label: label ?? '',
    maskedKey: maskKey(key),
    status: 'unknown',
    enabled: true,
  });
});

// Delete a key
keysRouter.delete('/:id', (req: Request, res: Response) => {
  const id = parseInt(req.params.id as string, 10);
  if (isNaN(id)) {
    res.status(400).json({ error: { message: 'Invalid key ID' } });
    return;
  }

  const db = getDb();
  const result = db.prepare('DELETE FROM api_keys WHERE id = ?').run(id);

  if (result.changes === 0) {
    res.status(404).json({ error: { message: 'Key not found' } });
    return;
  }

  res.json({ success: true });
});

// Toggle enable/disable
keysRouter.patch('/:id', (req: Request, res: Response) => {
  const id = parseInt(req.params.id as string, 10);
  if (isNaN(id)) {
    res.status(400).json({ error: { message: 'Invalid key ID' } });
    return;
  }

  const { enabled } = req.body;
  if (typeof enabled !== 'boolean') {
    res.status(400).json({ error: { message: 'enabled must be a boolean' } });
    return;
  }

  const db = getDb();
  const result = db.prepare('UPDATE api_keys SET enabled = ? WHERE id = ?').run(enabled ? 1 : 0, id);

  if (result.changes === 0) {
    res.status(404).json({ error: { message: 'Key not found' } });
    return;
  }

  res.json({ success: true, enabled });
});
