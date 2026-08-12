const http = require('node:http');
const https = require('node:https');
const crypto = require('node:crypto');
const net = require('node:net');
const { readResponseTextLimited, contentLengthOf } = require('./response-body');
const { readBoundedJson, writeJsonAtomic } = require('./atomic-json');

function createVisionAdapter({ config, assertSafeVisionEndpoint, resolveSafeVisionEndpoint, formatRemoteFailure, log }) {
  const { vision, limits } = config;
  const resolveEndpoint = resolveSafeVisionEndpoint || null;
  const cache = new Map();
  const pending = new Map();
  let cacheBytes = 0;
  let saveTimer = null;

  function entryBytes(key, value) {
    return Buffer.byteLength(key, 'utf8') + Buffer.byteLength(JSON.stringify(value), 'utf8');
  }

  function setCached(key, value) {
    const size = entryBytes(key, value);
    const maxCacheBytes = Number.isSafeInteger(vision.cacheMaxBytes) && vision.cacheMaxBytes > 0
      ? vision.cacheMaxBytes
      : 4 * 1024 * 1024;
    if (size > maxCacheBytes) return;
    const previous = cache.get(key);
    if (previous) cacheBytes -= entryBytes(key, previous);
    cache.delete(key);
    cache.set(key, value);
    cacheBytes += size;
    while (cache.size > vision.cacheMax || cacheBytes > maxCacheBytes) {
      const oldestKey = cache.keys().next().value;
      if (oldestKey === undefined) break;
      const oldest = cache.get(oldestKey);
      cache.delete(oldestKey);
      if (oldest) cacheBytes -= entryBytes(oldestKey, oldest);
    }
  }

  function getCached(key) {
    const cached = cache.get(key);
    if (!cached) return null;
    if (cached.ts && Date.now() - cached.ts > vision.cacheTtlMs) {
      cache.delete(key);
      cacheBytes -= entryBytes(key, cached);
      return null;
    }
    // Move hits to the newest position so eviction is LRU, not insertion-only.
    cache.delete(key);
    cache.set(key, cached);
    return cached;
  }

  function scheduleSave() {
    if (saveTimer) return;
    saveTimer = setTimeout(() => {
      saveTimer = null;
      try {
        writeJsonAtomic(vision.cacheFile, Object.fromEntries(cache), { maxBytes: vision.cacheMaxBytes });
      } catch (error) {
        log(`vision cache write failed (${error && error.name ? error.name : 'error'})`);
      }
    }, 800);
  }

  function loadCache() {
    try {
      const obj = readBoundedJson(vision.cacheFile, vision.cacheMaxBytes);
      if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return;
      for (const [key, value] of Object.entries(obj)) {
        const timestamp = Number(value && value.ts);
        if (key && value && typeof value.text === 'string' && value.text
          && (!timestamp || Date.now() - timestamp <= vision.cacheTtlMs)) setCached(key, value);
      }
      if (cache.size) log(`vision cache loaded: ${cache.size} entries`);
    } catch {}
  }

  function sha256hex(value) {
    return crypto.createHash('sha256').update(value, 'utf8').digest('hex');
  }

  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  function buildPrompt(focusHint) {
    let prompt =
      'Describe la imagen con precisión y detalle: elementos visibles, texto legible, colores, personas, acciones, contexto y cualquier dato relevante.';
    if (focusHint) prompt += `\n\nEnfócate en lo que el usuario necesita: ${focusHint}`;
    prompt += '\nResponde en el mismo idioma que usa el usuario (español salvo que el usuario escriba en otro idioma).';
    return prompt;
  }

  function validateImageReference(rawImage) {
    if (typeof rawImage !== 'string' || rawImage.length === 0 || rawImage.length > Math.ceil(limits.maxImageBytes * 4 / 3) + 256) {
      throw new Error('image reference exceeds the bounded input contract');
    }
    const match = rawImage.match(/^data:(image\/(?:png|jpeg|gif|webp));base64,([A-Za-z0-9+/=]+)$/i);
    if (!match) throw new Error('only bounded data:image PNG/JPEG/GIF/WEBP references are supported');
    const mime = match[1].toLowerCase();
    const bytes = Buffer.from(match[2], 'base64');
    if (bytes.length === 0 || bytes.length > limits.maxImageBytes) throw new Error('image exceeds the 8 MiB limit');
    const hex = bytes.subarray(0, 12).toString('hex').toLowerCase();
    const valid = (mime === 'image/png' && hex.startsWith('89504e470d0a1a0a'))
      || (mime === 'image/jpeg' && hex.startsWith('ffd8ff'))
      || (mime === 'image/gif' && bytes.subarray(0, 4).toString() === 'GIF8')
      || (mime === 'image/webp' && bytes.subarray(0, 4).toString() === 'RIFF' && bytes.subarray(8, 12).toString() === 'WEBP');
    if (!valid) throw new Error('image MIME and magic bytes do not match');
    return rawImage;
  }

  function requestPinnedVision(endpoint, address, options) {
    const url = new URL(endpoint);
    const client = url.protocol === 'https:' ? https : http;
    const hostname = url.hostname.replace(/^\[|\]$/g, '');
    const family = address.family || net.isIP(address.address);
    return new Promise((resolve, reject) => {
      let settled = false;
      let abort = () => {};
      const cleanup = () => options.signal?.removeEventListener('abort', abort);
      const fail = (error) => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(error);
      };
      const finish = (value) => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve(value);
      };
      const request = client.request({
        hostname,
        port: url.port || (url.protocol === 'https:' ? 443 : 80),
        path: `${url.pathname}${url.search}`,
        method: 'POST',
        headers: options.headers,
        servername: hostname,
        rejectUnauthorized: url.protocol === 'https:',
        // The resolver was already checked. This callback prevents node from
        // resolving the hostname a second time during the socket connection.
        lookup: (_host, lookupOptions, callback) => {
          if (lookupOptions && lookupOptions.all) callback(null, [{ address: address.address, family }]);
          else callback(null, address.address, family);
        },
      }, (incoming) => {
        const declared = contentLengthOf({ headers: { get: name => incoming.headers[String(name).toLowerCase()] } });
        if (declared != null && declared > options.maxBytes) {
          incoming.destroy();
          fail(new Error(`vision response exceeds ${options.maxBytes} bytes`));
          return;
        }
        const chunks = [];
        let size = 0;
        incoming.on('data', (chunk) => {
          size += chunk.length;
          if (size > options.maxBytes) {
            incoming.destroy(new Error(`vision response exceeds ${options.maxBytes} bytes`));
            return;
          }
          chunks.push(chunk);
        });
        incoming.on('error', fail);
        incoming.on('end', () => finish({
          ok: (incoming.statusCode || 0) >= 200 && (incoming.statusCode || 0) < 300,
          status: incoming.statusCode || 0,
          text: Buffer.concat(chunks).toString('utf8'),
          body: null,
        }));
      });
      abort = () => {
        const error = new Error('vision request aborted');
        error.name = 'AbortError';
        request.destroy(error);
      };
      request.on('error', fail);
      request.setTimeout(options.timeoutMs, () => {
        const error = new Error('vision request timed out');
        error.name = 'TimeoutError';
        request.destroy(error);
      });
      if (options.signal?.aborted) abort();
      else options.signal?.addEventListener('abort', abort, { once: true });
      request.end(options.body);
    });
  }

  async function fetchDescription(imageUrl, prompt, key) {
    const body = {
      model: vision.model,
      max_tokens: vision.maxTokens,
      messages: [{
        role: 'user',
        content: [
          { type: 'text', text: prompt },
          { type: 'image_url', image_url: { url: imageUrl } },
        ],
      }],
    };
    const endpoint = assertSafeVisionEndpoint(
      `${vision.baseUrl.replace(/\/$/, '')}${vision.completionsPath}`,
    ).toString();
    let lastFailure = { kind: 'unknown', status: 'none', bytes: 0 };

    for (let attempt = 0; attempt < 3; attempt++) {
      if (attempt > 0) await sleep(400 * attempt);
      let timer;
      try {
        const safeEndpoint = resolveEndpoint ? await resolveEndpoint(endpoint) : new URL(endpoint);
        const controller = new AbortController();
        timer = setTimeout(() => controller.abort(), vision.timeoutMs);
        const headers = { 'Content-Type': 'application/json' };
        if (vision.apiKey) headers.Authorization = `Bearer ${vision.apiKey}`;
        const validatedAddresses = safeEndpoint.__validatedAddresses;
        const response = validatedAddresses && validatedAddresses.length
          ? await requestPinnedVision(safeEndpoint.toString(), validatedAddresses[attempt % validatedAddresses.length], {
            headers,
            body: JSON.stringify(body),
            maxBytes: vision.maxResponseBytes,
            timeoutMs: vision.timeoutMs,
            signal: controller.signal,
          })
          : await fetch(safeEndpoint.toString(), {
            method: 'POST',
            redirect: 'error',
            headers,
            body: JSON.stringify(body),
            signal: controller.signal,
          });
        const raw = response.text && typeof response.text === 'string'
          ? response.text
          : await readResponseTextLimited(response, vision.maxResponseBytes, 'vision response');
        if (!response.ok) {
          lastFailure = { kind: 'http', status: response.status, bytes: Buffer.byteLength(raw, 'utf8') };
          continue;
        }
        const json = JSON.parse(raw);
        const message = json.choices && json.choices[0] && json.choices[0].message;
        let text = (message && message.content) || '';
        if (!String(text).trim() && message && message.reasoning_content) text = message.reasoning_content;
        if (!String(text).trim() && message && message.reasoning) text = String(message.reasoning);
        text = String(text).trim();
        if (!text) {
          lastFailure = { kind: 'empty_response', status: response.status, bytes: 0 };
          continue;
        }
        setCached(key, { text, ts: Date.now() });
        scheduleSave();
        log(`vision: described image (${text.length} chars)`);
        return text;
      } catch (error) {
        lastFailure = { kind: error && error.name === 'AbortError' ? 'timeout' : 'transport', status: 'none', bytes: 0 };
      } finally {
        if (timer) clearTimeout(timer);
      }
    }
    log(formatRemoteFailure('vision', lastFailure));
    return null;
  }

  async function describeImage(imageUrl, focusHint) {
    if (vision.disabled || !imageUrl) return null;
    try {
      imageUrl = validateImageReference(imageUrl);
    } catch {
      log(formatRemoteFailure('vision', { kind: 'validation' }));
      return null;
    }
    const prompt = buildPrompt(focusHint);
    const key = sha256hex(`${imageUrl}\x00${prompt}`);
    const cached = getCached(key);
    if (cached && typeof cached.text === 'string') return cached.text;
    const active = pending.get(key);
    if (active) return active;
    const task = fetchDescription(imageUrl, prompt, key);
    pending.set(key, task);
    try {
      return await task;
    } finally {
      pending.delete(key);
    }
  }

  function extractFocusHint(body) {
    let hint = '';
    for (const item of body.input || []) {
      if (item && item.type === 'message' && item.role === 'user' && Array.isArray(item.content)) {
        for (const content of item.content) {
          if (content && (content.type === 'input_text' || content.type === 'output_text') && typeof content.text === 'string' && content.text.trim()) {
            hint = content.text;
          }
        }
      }
    }
    return hint.trim().slice(0, 600);
  }

  loadCache();
  return {
    describeImage,
    extractFocusHint,
    validateImageReference,
    getCacheStats: () => ({ entries: cache.size, bytes: cacheBytes, pending: pending.size }),
  };
}

module.exports = { createVisionAdapter };
