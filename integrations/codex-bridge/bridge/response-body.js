function contentLengthOf(response) {
  const raw = response && response.headers && typeof response.headers.get === 'function'
    ? response.headers.get('content-length')
    : null;
  const parsed = Number.parseInt(raw || '', 10);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null;
}

async function cancelResponseBody(response) {
  const body = response && response.body;
  if (body && typeof body.cancel === 'function') {
    try { await body.cancel(); } catch {}
  }
}

async function readResponseTextLimited(response, maxBytes, label = 'response') {
  const contentLength = contentLengthOf(response);
  if (contentLength != null && contentLength > maxBytes) {
    await cancelResponseBody(response);
    throw new Error(`${label} exceeds ${maxBytes} bytes`);
  }
  if (!response.body || typeof response.body.getReader !== 'function') {
    const text = await response.text();
    if (Buffer.byteLength(text, 'utf8') > maxBytes) throw new Error(`${label} exceeds ${maxBytes} bytes`);
    return text;
  }

  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > maxBytes) {
      try { await reader.cancel(); } catch {}
      throw new Error(`${label} exceeds ${maxBytes} bytes`);
    }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks).toString('utf8');
}

async function readResponseJsonLimited(response, maxBytes, label = 'response') {
  return JSON.parse(await readResponseTextLimited(response, maxBytes, label));
}

module.exports = { contentLengthOf, readResponseTextLimited, readResponseJsonLimited };
