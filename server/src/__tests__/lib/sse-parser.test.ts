import { describe, expect, it } from 'vitest';
import { SseParserError, SseStreamParser } from '../../lib/sse-parser.js';

describe('SseStreamParser', () => {
  it('joins data fields across CRLF frames and preserves split UTF-8', () => {
    const parser = new SseStreamParser();
    const bytes = new TextEncoder().encode('event: message\r\ndata: hello\r\ndata: 🙂\r\n\r\n');
    const split = bytes.findIndex((byte, index) => index > 0 && byte === 0x80);
    const first = parser.push(bytes.slice(0, Math.max(1, split)));
    const second = parser.push(bytes.slice(Math.max(1, split)));

    expect(first).toEqual([]);
    expect(second).toEqual(['hello\n🙂']);
    expect(parser.finish()).toEqual([]);
  });

  it('ignores comments and non-data fields but emits multiple frames', () => {
    const parser = new SseStreamParser();
    expect(parser.push(new TextEncoder().encode(': heartbeat\n\ndata: one\n\ndata: two\n\n'))).toEqual(['one', 'two']);
  });

  it('rejects invalid UTF-8 and incomplete frames', () => {
    const invalid = new SseStreamParser();
    expect(() => invalid.push(new Uint8Array([0xc3, 0x28]))).toThrowError(SseParserError);

    const incomplete = new SseStreamParser();
    incomplete.push(new TextEncoder().encode('data: partial\n'));
    expect(() => incomplete.finish()).toThrowError(/incomplete SSE frame/);
  });

  it('rejects oversized lines and use after close', () => {
    const oversized = new SseStreamParser();
    expect(() => oversized.push(new TextEncoder().encode(`data: ${'x'.repeat(1_048_577)}\n`))).toThrowError(/size limit/);

    const closed = new SseStreamParser();
    closed.finish();
    expect(() => closed.push(new Uint8Array())).toThrowError(/already closed/);
  });
});
