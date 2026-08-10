import type { Response } from 'express';
import type { RoutingPolicySnapshot, RoutingRuntimeSnapshot, RoutingTraceSnapshot } from '@gloryapi/shared/types.js';

const HEARTBEAT_MS = 15_000;
const subscribers = new Map<Response, ReturnType<typeof setInterval>>();

function writeEvent(res: Response, event: string, data: unknown, id?: number): boolean {
  try {
    if (id !== undefined) res.write(`id: ${id}\n`);
    res.write(`event: ${event}\n`);
    res.write(`data: ${JSON.stringify(data)}\n\n`);
    return true;
  } catch {
    return false;
  }
}

function removeSubscriber(res: Response): void {
  const heartbeat = subscribers.get(res);
  if (heartbeat) clearInterval(heartbeat);
  subscribers.delete(res);
}

export function subscribeToRoutingEvents(res: Response): void {
  res.status(200);
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();

  const heartbeat = setInterval(() => {
    try {
      res.write(': heartbeat\n\n');
    } catch {
      removeSubscriber(res);
    }
  }, HEARTBEAT_MS);
  subscribers.set(res, heartbeat);
  res.once('close', () => removeSubscriber(res));
  writeEvent(res, 'routing.ready', { schemaVersion: 'glory-routing-v1' });
}

export function publishRoutingChanged(snapshot: RoutingPolicySnapshot): void {
  for (const res of subscribers.keys()) {
    if (!writeEvent(res, 'routing.changed', snapshot, snapshot.revision)) removeSubscriber(res);
  }
}

export function publishRoutingRuntimeChanged(snapshot: RoutingRuntimeSnapshot): void {
  for (const res of subscribers.keys()) {
    if (!writeEvent(res, 'routing.runtime', snapshot)) removeSubscriber(res);
  }
}

export function publishRoutingTrace(snapshot: RoutingTraceSnapshot): void {
  for (const res of subscribers.keys()) {
    if (!writeEvent(res, 'routing.trace', snapshot)) removeSubscriber(res);
  }
}

export function getRoutingSubscriberCount(): number {
  return subscribers.size;
}

export function closeRoutingEventSubscribers(): void {
  for (const res of subscribers.keys()) {
    removeSubscriber(res);
    try {
      res.end();
    } catch {
      // The socket may already be closed; cleanup has completed above.
    }
  }
}
