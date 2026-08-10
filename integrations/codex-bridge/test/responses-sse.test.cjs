const assert = require('node:assert/strict');
const test = require('node:test');
const { SseParserError, SseStreamParser } = require('../bridge/responses-sse');

test('parses fragmented UTF-8, comments, multiline data and mixed line endings', () => {
  const parser = new SseStreamParser();
  const text = ': heartbeat\r\ndata: {"text":"🙂"}\r\n\r\ndata: line-one\ndata: line-two\r\n\r\ndata: [DONE]\n\n';
  const bytes = new TextEncoder().encode(text);
  const frames = [];
  for (let index = 0; index < bytes.length; index += 1) {
    frames.push(...parser.push(bytes.slice(index, index + 1)));
  }
  frames.push(...parser.finish());
  assert.deepEqual(frames, ['{"text":"🙂"}', 'line-one\nline-two', '[DONE]']);
});

test('rejects invalid UTF-8 and an EOF inside a frame', () => {
  const invalid = new SseStreamParser();
  assert.throws(() => invalid.push(Uint8Array.from([0xc3, 0x28])), (error) => {
    assert.ok(error instanceof SseParserError);
    assert.equal(error.code, 'invalid_utf8');
    return true;
  });

  const truncated = new SseStreamParser();
  truncated.push(new TextEncoder().encode('data: {"partial":true}\n'));
  assert.throws(() => truncated.finish(), (error) => {
    assert.ok(error instanceof SseParserError);
    assert.equal(error.code, 'incomplete_frame');
    return true;
  });
});

test('bounds line and frame sizes', () => {
  const lineLimited = new SseStreamParser({ maxLineBytes: 8 });
  assert.throws(() => lineLimited.push(new TextEncoder().encode('data: too-long\n')), /line exceeds/);

  const frameLimited = new SseStreamParser({ maxFrameBytes: 8 });
  assert.throws(() => frameLimited.push(new TextEncoder().encode('data: 123456789\n\n')), /frame exceeds/);
});

test('property-style chunk partitioning is invariant for valid UTF-8 frames', () => {
  const text = `data: ${JSON.stringify({ text: 'fragmented🙂'.repeat(8) })}\r\n\r\ndata: [DONE]\n\n`;
  const bytes = new TextEncoder().encode(text);
  for (let seed = 1; seed <= 32; seed += 1) {
    const parser = new SseStreamParser();
    const frames = [];
    let offset = 0;
    let state = seed;
    while (offset < bytes.length) {
      state = (state * 1664525 + 1013904223) >>> 0;
      const width = 1 + (state % 11);
      frames.push(...parser.push(bytes.slice(offset, offset + width)));
      offset += width;
    }
    frames.push(...parser.finish());
    assert.deepEqual(frames, [JSON.stringify({ text: 'fragmented🙂'.repeat(8) }), '[DONE]']);
  }
});

test('rejects malformed JSON payloads at the contract boundary without guessing', () => {
  const parser = new SseStreamParser();
  const frames = parser.push(new TextEncoder().encode('data: {"unterminated":\n\n'));
  frames.push(...parser.finish());
  assert.equal(frames.length, 1);
  assert.throws(() => JSON.parse(frames[0]), SyntaxError);
});
