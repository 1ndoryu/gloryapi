import crypto from 'node:crypto';
import type { Request, Response } from 'express';
import { getUnifiedApiKey } from '../db/index.js';

export function hasAdminKey(req: Request): boolean {
  const supplied = req.headers.authorization?.replace(/^Bearer\s+/i, '') ?? '';
  const expected = getUnifiedApiKey();
  const suppliedBytes = Buffer.from(supplied);
  const expectedBytes = Buffer.from(expected);
  return suppliedBytes.length === expectedBytes.length && crypto.timingSafeEqual(suppliedBytes, expectedBytes);
}

export function requireAdmin(req: Request, res: Response): boolean {
  if (hasAdminKey(req)) return true;
  res.status(401).json({ error: { message: 'Invalid API key', type: 'authentication_error' } });
  return false;
}
