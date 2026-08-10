import { Router } from 'express';
import type { Request, Response } from 'express';
import { issueDashboardSession, isDashboardOriginAllowed } from '../../lib/security/dashboard-session.js';

export const sessionRouter = Router();

sessionRouter.post('/bootstrap', (req: Request, res: Response) => {
  const origin = typeof req.headers.origin === 'string' ? req.headers.origin : '';
  const loopback = ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.ip ?? '');
  if (!loopback || !isDashboardOriginAllowed(origin || undefined, req)) {
    res.status(403).json({ error: { code: 'dashboard_origin_blocked', message: 'Dashboard session requires a trusted loopback origin' } });
    return;
  }
  const effectiveOrigin = origin || `${req.protocol}://${req.get('host')}`;
  res.setHeader('Cache-Control', 'no-store');
  res.json({ schemaVersion: 'glory-dashboard-session-v1', ...issueDashboardSession(effectiveOrigin) });
});
