const MAX_FRAME_BYTES = 4 * 1024 * 1024;
const MAX_LINE_BYTES = 1 * 1024 * 1024;

export type SseParserErrorCode = 'invalid_utf8' | 'line_too_large' | 'frame_too_large' | 'incomplete_frame' | 'parser_closed';

export class SseParserError extends Error {
  constructor(readonly code: SseParserErrorCode, message: string) {
    super(message);
    this.name = 'SseParserError';
  }
}

/** Incremental SSE parser; returns only data fields and never buffers beyond hard limits. */
export class SseStreamParser {
  private readonly decoder = new TextDecoder('utf-8', { fatal: true });
  private textBuffer = '';
  private dataLines: string[] = [];
  private frameBytes = 0;
  private closed = false;

  push(bytes: Uint8Array): string[] {
    if (this.closed) throw new SseParserError('parser_closed', 'SSE parser is already closed');
    let text: string;
    try {
      text = this.decoder.decode(bytes, { stream: true });
    } catch {
      throw new SseParserError('invalid_utf8', 'Provider stream contained invalid UTF-8');
    }
    this.textBuffer += text;
    return this.drainLines();
  }

  finish(): string[] {
    if (this.closed) throw new SseParserError('parser_closed', 'SSE parser is already closed');
    this.closed = true;
    try {
      this.textBuffer += this.decoder.decode();
    } catch {
      throw new SseParserError('invalid_utf8', 'Provider stream ended with invalid UTF-8');
    }
    const events = this.drainLines();
    if (this.textBuffer.length > 0 || this.dataLines.length > 0 || this.frameBytes > 0) {
      throw new SseParserError('incomplete_frame', 'Provider stream ended in an incomplete SSE frame');
    }
    return events;
  }

  private drainLines(): string[] {
    const events: string[] = [];
    while (true) {
      const lineEnd = this.findLineEnd(this.textBuffer);
      if (!lineEnd) break;
      const { index, length } = lineEnd;
      const line = this.textBuffer.slice(0, index);
      this.textBuffer = this.textBuffer.slice(index + length);
      const lineBytes = Buffer.byteLength(line, 'utf8');
      if (lineBytes > MAX_LINE_BYTES) {
        throw new SseParserError('line_too_large', 'Provider SSE line exceeds the size limit');
      }
      this.frameBytes += lineBytes + length;
      if (this.frameBytes > MAX_FRAME_BYTES) {
        throw new SseParserError('frame_too_large', 'Provider SSE frame exceeds the size limit');
      }
      if (line.length === 0) {
        if (this.dataLines.length > 0) events.push(this.dataLines.join('\n'));
        this.dataLines = [];
        this.frameBytes = 0;
        continue;
      }
      if (line.startsWith(':')) continue;
      const separator = line.indexOf(':');
      const field = separator === -1 ? line : line.slice(0, separator);
      let value = separator === -1 ? '' : line.slice(separator + 1);
      if (value.startsWith(' ')) value = value.slice(1);
      if (field === 'data') this.dataLines.push(value);
      // event/id/retry and unknown fields are intentionally ignored by the
      // OpenAI-compatible adapter; data-only framing is its contract.
    }
    return events;
  }

  private findLineEnd(value: string): { index: number; length: number } | null {
    for (let index = 0; index < value.length; index++) {
      const char = value[index];
      if (char === '\n') return { index, length: 1 };
      if (char === '\r') return { index, length: value[index + 1] === '\n' ? 2 : 1 };
    }
    if (Buffer.byteLength(value, 'utf8') > MAX_LINE_BYTES) {
      throw new SseParserError('line_too_large', 'Provider SSE line exceeds the size limit');
    }
    return null;
  }
}
