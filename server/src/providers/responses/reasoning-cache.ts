import { createHash } from 'node:crypto';
import type { ChatMessage } from '@gloryapi/shared/types.js';

/** Opaque reasoning state for stateless multi-turn Responses calls (cf. opencode CLI).
 * The Go gateway requires replayed items to carry the `summary` field, so it
 * is preserved verbatim (Muse turns arrive with `summary: []`). */
export interface ResponsesReasoningItem {
  id: string;
  encrypted_content: string;
  summary?: unknown[];
}

const MAX_ENTRIES = 100;
const ENTRY_TTL_MS = 30 * 60 * 1000;
const MAX_ITEMS_PER_ENTRY = 8;
const MAX_BYTES_PER_ENTRY = 32 * 1024;
const TEXT_TRUNCATE = 500;

function textOf(content: ChatMessage['content']): string {
  if (typeof content === 'string') return content.slice(0, TEXT_TRUNCATE);
  if (!Array.isArray(content)) return '';
  const parts: string[] = [];
  for (const block of content) {
    if (block && typeof block === 'object' && typeof block.text === 'string' && block.text) {
      parts.push(block.text.slice(0, TEXT_TRUNCATE));
      if (parts.join('|').length >= TEXT_TRUNCATE) break;
    }
  }
  return parts.join('|').slice(0, TEXT_TRUNCATE);
}

function normalizeMessage(message: ChatMessage): string {
  const role = message.role ?? '?';
  const text = textOf(message.content);
  const calls = Array.isArray(message.tool_calls)
    ? message.tool_calls.map(call => `${call.id ?? ''}:${call.function?.name ?? ''}`).join(',')
    : '';
  const toolId = message.role === 'tool' ? String(message.tool_call_id ?? '') : '';
  return `${role}|${text}|${calls}|${toolId}`;
}

function hashShort(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex').slice(0, 16);
}

export function messageHashesFor(messages: ChatMessage[]): string[] {
  return messages.map(message => hashShort(normalizeMessage(message)));
}

interface ReasoningCacheEntry {
  model: string;
  messageHashes: string[];
  items: ResponsesReasoningItem[];
  bytes: number;
  storedAt: number;
}

function sanitizeItems(items: unknown): { items: ResponsesReasoningItem[]; bytes: number } {
  if (!Array.isArray(items)) return { items: [], bytes: 0 };
  const kept: ResponsesReasoningItem[] = [];
  let bytes = 0;
  for (const candidate of items) {
    if (kept.length >= MAX_ITEMS_PER_ENTRY || bytes >= MAX_BYTES_PER_ENTRY) break;
    if (!candidate || typeof candidate !== 'object') continue;
    const record = candidate as Record<string, unknown>;
    const id = typeof record.id === 'string' ? record.id : '';
    const blob = typeof record.encrypted_content === 'string' ? record.encrypted_content : '';
    if (!id || !blob) continue;
    const size = Buffer.byteLength(blob, 'utf8');
    if (bytes + size > MAX_BYTES_PER_ENTRY) break;
    const summary = Array.isArray(record.summary) ? (record.summary as unknown[]) : [];
    kept.push({ id, encrypted_content: blob, summary });
    bytes += size;
  }
  return { items: kept, bytes };
}

/** In-memory only (never persisted/logged): maps a request history prefix to the reasoning it produced. */
export class ResponsesReasoningCache {
  private readonly entries = new Map<string, ReasoningCacheEntry>();

  private sweep(now: number): void {
    for (const [key, entry] of this.entries) {
      if (now - entry.storedAt > ENTRY_TTL_MS) this.entries.delete(key);
    }
  }

  private exactKey(model: string, hashes: string[]): string {
    return `${model.toLowerCase()}#${hashes.join(',')}`;
  }

  lookup(messages: ChatMessage[], model: string, now = Date.now()): ResponsesReasoningItem[] | undefined {
    this.sweep(now);
    const current = messageHashesFor(messages);
    if (current.length === 0) return undefined;
    const wanted = model.toLowerCase();
    let best: ReasoningCacheEntry | undefined;
    for (const entry of this.entries.values()) {
      if (entry.model !== wanted) continue;
      if (entry.messageHashes.length === 0 || entry.messageHashes.length > current.length) continue;
      let prefix = true;
      for (let i = 0; i < entry.messageHashes.length; i += 1) {
        if (entry.messageHashes[i] !== current[i]) {
          prefix = false;
          break;
        }
      }
      if (!prefix) continue;
      if (!best || entry.messageHashes.length > best.messageHashes.length
        || (entry.messageHashes.length === best.messageHashes.length && entry.storedAt > best.storedAt)) {
        best = entry;
      }
    }
    return best ? [...best.items] : undefined;
  }

  store(messages: ChatMessage[], model: string, items: unknown, now = Date.now()): boolean {
    const { items: kept, bytes } = sanitizeItems(items);
    if (kept.length === 0) return false;
    this.sweep(now);
    const hashes = messageHashesFor(messages);
    if (hashes.length === 0) return false;
    const key = this.exactKey(model, hashes);
    this.entries.delete(key);
    this.entries.set(key, { model: model.toLowerCase(), messageHashes: hashes, items: kept, bytes, storedAt: now });
    while (this.entries.size > MAX_ENTRIES) {
      const oldest = this.entries.keys().next();
      if (oldest.done) break;
      this.entries.delete(oldest.value);
    }
    return true;
  }

  clear(): void {
    this.entries.clear();
  }

  get size(): number {
    return this.entries.size;
  }
}

const sharedCache = new ResponsesReasoningCache();

export function lookupResponsesReasoning(messages: ChatMessage[], model: string): ResponsesReasoningItem[] | undefined {
  return sharedCache.lookup(messages, model);
}

export function storeResponsesReasoning(messages: ChatMessage[], model: string, items: unknown): boolean {
  return sharedCache.store(messages, model, items);
}

export function clearResponsesReasoningCache(): void {
  sharedCache.clear();
}
