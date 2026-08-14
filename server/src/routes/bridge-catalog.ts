import { Router } from 'express';
import { getUnifiedApiKey } from '../db/index.js';
import { timingSafeStringEqual } from './proxy-routing.js';
import { getBridgeCatalogProjection } from '../services/configuration-v2.js';

export const bridgeCatalogRouter = Router();

bridgeCatalogRouter.get('/', (req, res) => {
  const supplied = req.headers.authorization?.replace(/^Bearer\s+/i, '') ?? '';
  if (!supplied || !timingSafeStringEqual(supplied, getUnifiedApiKey())) {
    res.status(401).json({ error: { message: 'Invalid API key', type: 'authentication_error' } });
    return;
  }
  res.json(getBridgeCatalogProjection());
});
