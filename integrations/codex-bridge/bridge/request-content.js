function crearContent(ctx) {
  const { VISION_CHANNEL_NOTE, VISION_FAILURE_NOTE, describeImage, describeImageResult, validateImageReference } = ctx;

function normalizeOutput(output) {
  // Responses function_call_output.output can be:
  //   - a plain string
  //   - an array of content items [{type:"input_text", text}, ...]
  //   - an object { body: <string | content items> } (internal payload)
  let value = output;
  if (value && typeof value === 'object' && !Array.isArray(value) && 'body' in value) {
    value = value.body;
  }
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) {
    return value
      .map((c) => (c && c.type === 'input_text' ? c.text : c && c.type === 'output_text' ? c.text : ''))
      .filter((t) => typeof t === 'string')
      .join('\n');
  }
  return String(value ?? '');
}

/**
 * Convert Responses content parts into chat content parts.
 *
 * input_image items are replaced by a text description produced by the vision
 * model (agent-vision-toolkit pattern): the image itself is NEVER forwarded to
 * the text-only main model. The vision model only receives the image + the
 * focus hint (the user's latest text) and its description is injected here.
 * All images in one message are described in parallel; on vision failure the
 * image is replaced by an explicit diagnostic note (fail-open), never breaking
 * the request or allowing the text-only model to infer that the image was empty.
 */
async function chatContentParts(content, focusHint, channelNote, nativeVision) {
  // Some clients send a single content part object instead of an array
  // (e.g. { type: 'input_text', text }). Normalize it so the iteration below
  // never throws on a non-iterable.
  if (content && typeof content === 'object' && !Array.isArray(content)) content = [content];
  const textParts = [];
  const imageJobs = [];
  for (const c of content || []) {
    if (!c) continue;
    if (c.type === 'input_text' || c.type === 'output_text') {
      textParts.push({ type: 'text', text: c.text });
    } else if (c.type === 'input_image') {
      imageJobs.push(c);
    }
    // input_audio / encrypted_content: not supported locally -> skipped
  }
  if (!imageJobs.length) return textParts;

  // Native vision (Muse Spark 1.2): forward the validated image_url block to
  // the upstream so the multimodal model sees the image directly instead of a
  // lossy text description. Each image is fail-closed: an invalid reference
  // becomes an explicit diagnostic note, never a silent drop that the model
  // could misread as "the folder is empty".
  if (nativeVision) {
    const parts = textParts.slice();
    for (let i = 0; i < imageJobs.length; i++) {
      const image = imageJobs[i];
      try {
        validateImageReference(image.image_url);
        parts.push({ type: 'image_url', image_url: { url: image.image_url } });
      } catch {
        parts.push({
          type: 'text',
          text: formatVisionFailure(i + 1, { kind: 'validation', status: 'none', bytes: 0 }, VISION_FAILURE_NOTE),
        });
      }
    }
    return parts;
  }

  const descriptions = await Promise.all(imageJobs.map(async (c) => {
    try {
      validateImageReference(c.image_url);
    } catch {
      return { text: null, failure: { kind: 'validation', status: 'none', bytes: 0 } };
    }
    if (typeof describeImageResult === 'function') return describeImageResult(c.image_url, focusHint);
    const text = await describeImage(c.image_url, focusHint);
    return text ? { text, failure: null } : { text: null, failure: { kind: 'unknown', status: 'none', bytes: 0 } };
  }));
  const parts = [];
  // Channel note: tell the main model once per request that images arrive as
  // text (only when there actually is an image to describe).
  if (channelNote && !channelNote.sent) {
    channelNote.sent = true;
    parts.push({ type: 'text', text: VISION_CHANNEL_NOTE });
  }
  for (let i = 0; i < descriptions.length; i++) {
    const result = descriptions[i] || {};
    const desc = typeof result === 'string' ? result : result.text;
    parts.push(
      desc
        ? { type: 'text', text: `[Imagen ${i + 1} descrita por el modelo de visión:]
${desc}` }
        : { type: 'text', text: formatVisionFailure(i + 1, typeof result === 'string' ? null : result.failure, VISION_FAILURE_NOTE) }
    );
  }
  return parts;
}

function formatVisionFailure(index, failure, configuredNote) {
  const status = failure && Number.isSafeInteger(failure.status) ? ` HTTP ${failure.status}` : '';
  const detail = failure && failure.kind === 'validation'
    ? 'la referencia no pudo validarse'
    : failure && failure.kind === 'disabled'
      ? 'la visión está desactivada'
      : failure && failure.kind === 'http' && failure.status === 429
        ? 'el proveedor de visión está temporalmente limitado o sin cuota'
        : 'el proveedor de visión no devolvió una descripción';
  const prefix = configuredNote || '[visión] La imagen sí fue recibida por el bridge.';
  return `${prefix} [Imagen ${index} no descrita: ${detail}${status}. No concluyas que la imagen, carpeta o visualización está vacía; informa de esta limitación o continúa sin inventar su contenido.]`;
}

/**
 * True when the leading text of the content parts starts with `prefix`
 * (case-insensitive, after trimming). Used to detect supervisor reminders that
 * must be relayed as `user` messages instead of weak `system` ones.
 */
function partsStartWith(parts, prefix) {
  for (const p of parts) {
    if (p && typeof p.text === 'string' && p.text.trim()) {
      return p.text.trimStart().toLowerCase().startsWith(prefix.toLowerCase());
    }
  }
  return false;
}

  return { normalizeOutput, chatContentParts, partsStartWith };
}

module.exports = { crearContent };
