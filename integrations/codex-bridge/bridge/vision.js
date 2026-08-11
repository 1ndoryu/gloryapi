const fs = require('node:fs');
const crypto = require('node:crypto');
const { readResponseTextLimited } = require('./response-body');

function createVisionAdapter({ config, assertSafeVisionEndpoint, formatRemoteFailure, log }) {
  const { vision, limits } = config;
  const cache = new Map();
  let saveTimer = null;

  function scheduleSave() {
    if (saveTimer) return;
    saveTimer = setTimeout(() => {
      saveTimer = null;
      try {
        fs.writeFileSync(vision.cacheFile, JSON.stringify(Object.fromEntries(cache)));
      } catch {}
    }, 800);
  }

  function loadCache() {
    try {
      const raw = fs.readFileSync(vision.cacheFile, 'utf8');
      const obj = JSON.parse(raw);
      for (const [key, value] of Object.entries(obj)) {
        if (key && value && typeof value.text === 'string' && value.text) cache.set(key, value);
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
    const cached = cache.get(key);
    if (cached && typeof cached.text === 'string') return cached.text;

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
        const controller = new AbortController();
        timer = setTimeout(() => controller.abort(), vision.timeoutMs);
        const headers = { 'Content-Type': 'application/json' };
        if (vision.apiKey) headers.Authorization = `Bearer ${vision.apiKey}`;
        const response = await fetch(endpoint, {
          method: 'POST',
          redirect: 'error',
          headers,
          body: JSON.stringify(body),
          signal: controller.signal,
        });
        const raw = await readResponseTextLimited(response, vision.maxResponseBytes, 'vision response');
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
        cache.set(key, { text, ts: Date.now() });
        if (cache.size > vision.cacheMax) cache.delete(cache.keys().next().value);
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
  return { describeImage, extractFocusHint, validateImageReference };
}

module.exports = { createVisionAdapter };
