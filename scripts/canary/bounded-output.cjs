const { StringDecoder } = require('node:string_decoder');

function createBoundedCapture(maxBytes) {
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) {
    throw new RangeError('maxBytes must be a positive safe integer');
  }

  let capturedBytes = 0;
  let exceeded = false;
  const decoders = new Map();
  const textByStream = new Map();

  return {
    append(stream, chunk) {
      if (exceeded) return;
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
      const remaining = maxBytes - capturedBytes;
      const acceptedBytes = Math.min(buffer.byteLength, remaining);
      if (acceptedBytes > 0) {
        capturedBytes += acceptedBytes;
        const decoder = decoders.get(stream) || new StringDecoder('utf8');
        decoders.set(stream, decoder);
        textByStream.set(stream, `${textByStream.get(stream) || ''}${decoder.write(buffer.subarray(0, acceptedBytes))}`);
      }
      if (acceptedBytes < buffer.byteLength) exceeded = true;
    },
    text(stream) { return textByStream.get(stream) || ''; },
    get capturedBytes() { return capturedBytes; },
    get exceeded() { return exceeded; },
  };
}

module.exports = { createBoundedCapture };
