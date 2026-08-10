'use strict';

class SseParserError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'SseParserError';
    this.code = code;
  }
}

/**
 * Incremental SSE parser for provider streams.
 * It emits only complete `data:` frames and never guesses through malformed or
 * unterminated input. UTF-8 and line/frame budgets are bounded explicitly.
 */
class SseStreamParser {
  constructor({ maxLineBytes = 1024 * 1024, maxFrameBytes = 4 * 1024 * 1024 } = {}) {
    this.maxLineBytes = maxLineBytes;
    this.maxFrameBytes = maxFrameBytes;
    this.decoder = new TextDecoder('utf-8', { fatal: true });
    this.buffer = '';
    this.dataLines = [];
    this.frameBytes = 0;
    this.finished = false;
  }

  push(chunk) {
    if (this.finished) throw new SseParserError('after_finish', 'SSE parser received data after finish');
    if (!(chunk instanceof Uint8Array)) {
      throw new SseParserError('invalid_chunk', 'SSE parser requires Uint8Array chunks');
    }
    try {
      this.buffer += this.decoder.decode(chunk, { stream: true });
    } catch {
      throw new SseParserError('invalid_utf8', 'SSE stream contains invalid UTF-8');
    }
    return this.drain(false);
  }

  finish() {
    if (this.finished) throw new SseParserError('after_finish', 'SSE parser finished twice');
    this.finished = true;
    try {
      this.buffer += this.decoder.decode();
    } catch {
      throw new SseParserError('invalid_utf8', 'SSE stream ends with incomplete UTF-8');
    }
    const frames = this.drain(true);
    if (this.buffer.length > 0 || this.dataLines.length > 0) {
      throw new SseParserError('incomplete_frame', 'SSE stream ends before a complete frame');
    }
    return frames;
  }

  drain(final) {
    const frames = [];
    for (;;) {
      const newline = this.buffer.indexOf('\n');
      const carriage = this.buffer.indexOf('\r');
      let index = -1;
      let terminatorLength = 0;

      if (newline === -1 && carriage === -1) {
        this.assertLineBudget();
        break;
      }
      if (newline === -1 || (carriage !== -1 && carriage < newline)) {
        index = carriage;
        if (index + 1 < this.buffer.length && this.buffer[index + 1] === '\n') {
          terminatorLength = 2;
        } else if (index + 1 === this.buffer.length && !final) {
          this.assertLineBudget();
          break;
        } else {
          terminatorLength = 1;
        }
      } else {
        index = newline;
        terminatorLength = 1;
      }

      const line = this.buffer.slice(0, index);
      this.buffer = this.buffer.slice(index + terminatorLength);
      this.assertLineBudget(line);
      this.consumeLine(line, frames);
    }
    return frames;
  }

  assertLineBudget(line = this.buffer) {
    if (Buffer.byteLength(line, 'utf8') > this.maxLineBytes) {
      throw new SseParserError('line_too_large', `SSE line exceeds ${this.maxLineBytes} bytes`);
    }
  }

  consumeLine(line, frames) {
    if (line === '') {
      if (this.dataLines.length > 0) {
        const data = this.dataLines.join('\n');
        if (this.frameBytes > this.maxFrameBytes) {
          throw new SseParserError('frame_too_large', `SSE frame exceeds ${this.maxFrameBytes} bytes`);
        }
        frames.push(data);
      }
      this.dataLines = [];
      this.frameBytes = 0;
      return;
    }

    // Comments/heartbeats and non-data SSE fields are intentionally ignored.
    if (line.startsWith(':') || !line.startsWith('data:')) return;
    let value = line.slice(5);
    if (value.startsWith(' ')) value = value.slice(1);
    this.dataLines.push(value);
    this.frameBytes += Buffer.byteLength(value, 'utf8');
    if (this.frameBytes > this.maxFrameBytes) {
      throw new SseParserError('frame_too_large', `SSE frame exceeds ${this.maxFrameBytes} bytes`);
    }
  }
}

module.exports = { SseParserError, SseStreamParser };
