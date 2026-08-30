/* Router del proxy de chat completions.
 * [por que] El handler completo superaba el limite de lineas (300); vive en
 * proxy-chat.ts. La API publica (isRetryableError, isToolSchemaCompatibilityError)
 * se mantiene aqui con delegacion local (sin re-export barrel) para no romper
 * los tests que importan desde routes/proxy.js ni disparar mixed-barrel-logic. */
import { Router } from 'express';
import { registerModelRoutes } from './proxy-routing.js';
import { chatCompletionsHandler } from './proxy-chat.js';
import { isRetryableError as isRetryable, isToolSchemaCompatibilityError as isToolSchema } from './proxy-chat-helpers.js';

export function isRetryableError(err: unknown): boolean {
  return isRetryable(err);
}

export function isToolSchemaCompatibilityError(err: unknown): boolean {
  return isToolSchema(err);
}

export const proxyRouter = Router();
registerModelRoutes(proxyRouter);
proxyRouter.post('/chat/completions', chatCompletionsHandler);
