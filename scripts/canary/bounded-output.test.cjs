const assert = require('node:assert/strict');
const test = require('node:test');
const { createBoundedCapture } = require('./bounded-output.cjs');

test('bounded canary capture enforces one byte budget across stdout and stderr', () => {
  const capture = createBoundedCapture(1024 * 1024);

  capture.append('stdout', Buffer.alloc(600 * 1024, 'o'));
  capture.append('stderr', Buffer.alloc(600 * 1024, 'e'));

  assert.equal(capture.capturedBytes, 1024 * 1024);
  assert.equal(Buffer.byteLength(capture.text('stdout')) + Buffer.byteLength(capture.text('stderr')), 1024 * 1024);
  assert.equal(capture.exceeded, true);
  capture.append('stdout', Buffer.from('ignored'));
  assert.equal(capture.text('stdout').endsWith('ignored'), false);
});

test('bounded canary capture truncates before concatenating an oversized chunk', () => {
  const capture = createBoundedCapture(8);
  capture.append('stdout', Buffer.from('0123456789'));

  assert.equal(capture.text('stdout'), '01234567');
  assert.equal(capture.capturedBytes, 8);
  assert.equal(capture.exceeded, true);
});

test('bounded canary capture preserves split UTF-8 and omits a partial final character', () => {
  const split = createBoundedCapture(16);
  split.append('stdout', Buffer.from([0x73, 0xf0]));
  split.append('stdout', Buffer.from([0x9f, 0x99]));
  split.append('stdout', Buffer.from([0x82]));
  assert.equal(split.text('stdout'), 's🙂');

  const truncated = createBoundedCapture(3);
  truncated.append('stdout', Buffer.from('a🙂'));
  assert.equal(truncated.text('stdout'), 'a');
  assert.equal(truncated.capturedBytes, 3);
  assert.equal(truncated.exceeded, true);
  assert.equal(Buffer.byteLength(truncated.text('stdout')), 1);
});
