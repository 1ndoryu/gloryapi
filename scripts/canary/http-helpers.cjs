async function readResponseTextBounded(response, maxBytes = 256 * 1024) {
  const declared = Number.parseInt(response.headers.get('content-length') || '', 10);
  if (Number.isSafeInteger(declared) && declared > maxBytes) {
    try { await response.body?.cancel(); } catch {}
    throw new Error(`canary response exceeded ${maxBytes} bytes`);
  }
  if (!response.body?.getReader) throw new Error('canary response has no readable body');
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let bytes = 0;
  let text = '';
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > maxBytes) {
        await reader.cancel();
        throw new Error(`canary response exceeded ${maxBytes} bytes`);
      }
      text += decoder.decode(value, { stream: true });
    }
    return text + decoder.decode();
  } catch (error) {
    try { await reader.cancel(); } catch {}
    throw error;
  }
}

async function requestResponsesStream(url, options, maxBytes = 256 * 1024, fetchImpl = globalThis.fetch) {
  const response = await fetchImpl(url, options);
  if (!response.ok) {
    const body = await readResponseTextBounded(response, maxBytes).catch(error => `[bounded-read-failed: ${error.message}]`);
    throw new Error(`${options?.method || 'GET'} ${url} returned ${response.status}: ${body.slice(0, 500)}`);
  }
  if (!response.headers.get('content-type')?.includes('text/event-stream')) {
    try { await response.body?.cancel(); } catch {}
    throw new Error(`stream response from ${url} did not use text/event-stream`);
  }
  if (!response.body?.getReader) throw new Error(`stream response from ${url} has no readable body`);
  const raw = await readResponseTextBounded(response, maxBytes);
  const events = [];
  for (const block of raw.split(/\r?\n\r?\n/)) {
    const lines = block.split(/\r?\n/);
    const event = lines.find(line => line.startsWith('event:'))?.slice(6).trim() || null;
    const data = lines.filter(line => line.startsWith('data:')).map(line => line.slice(5).replace(/^ /, '')).join('\n');
    if (!data) continue;
    if (data === '[DONE]') {
      events.push({ event, data: '[DONE]' });
      continue;
    }
    events.push({ event, data: JSON.parse(data) });
  }
  return { response, events };
}

module.exports = { readResponseTextBounded, requestResponsesStream };
