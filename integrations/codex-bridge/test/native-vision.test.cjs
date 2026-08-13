'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const { createRequestTranslator } = require('../bridge/request-translator');
const { DEFAULT_MODEL_CATALOG } = require('../bridge/model-catalog');

const PNG_DATA_URL = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';

function buildConfig() {
  return {
    upstream: { model: 'deepseek-v4-flash' },
    catalog: { entries: DEFAULT_MODEL_CATALOG },
    vision: {
      channelNote: '[visión] Las imágenes se te entregan como texto.',
      failureNote: '[visión] La imagen sí fue recibida por el bridge.',
    },
    reasoning: { fallback: 'El asistente decidió invocar una herramienta.' },
    recovery: { nudgeRetries: 0, executionDirective: 'Ejecuta la herramienta en este turno.' },
    tools: { profile: 'generic' },
  };
}

function createTranslator(overrides = {}) {
  const calls = { describeImage: 0 };
  const config = buildConfig();
  return {
    calls,
    translateRequest: createRequestTranslator({
      config,
      describeImage: async () => {
        calls.describeImage += 1;
        return 'DESCRIPCION_TEXTO';
      },
      extractFocusHint: () => '',
      validateImageReference: (imageUrl) => {
        if (typeof imageUrl !== 'string' || !imageUrl.startsWith('data:image/')) {
          throw new Error('image reference validation failed');
        }
        return imageUrl;
      },
      boundSystemContent: (value) => (typeof value === 'string' ? value : JSON.stringify(value)),
      log: () => {},
      reasoningFor: () => '',
      ...overrides,
    }).translateRequest,
  };
}

function imageBody(model) {
  return {
    model,
    stream: true,
    input: [
      {
        type: 'message',
        role: 'user',
        content: [
          { type: 'input_text', text: 'Describe esta imagen' },
          { type: 'input_image', image_url: PNG_DATA_URL },
        ],
      },
    ],
  };
}

test('native vision forwards the image_url block to a multimodal model', async () => {
  const { translateRequest, calls } = createTranslator();
  const { chat } = await translateRequest(imageBody('meta/muse-spark-1.2-contributor'));

  assert.equal(chat.model, 'meta/muse-spark-1.2-contributor');
  const userMessage = chat.messages.find((message) => message.role === 'user');
  const imagePart = userMessage.content.find((part) => part.type === 'image_url');
  assert.deepEqual(imagePart.image_url, { url: PNG_DATA_URL });
  // Sin adaptación de texto: el modelo de visión nunca se invoca.
  assert.equal(calls.describeImage, 0);
});

test('text-only models keep the lossy vision-to-text adaptation', async () => {
  const { translateRequest, calls } = createTranslator();
  const { chat } = await translateRequest(imageBody('deepseek/deepseek-v4-flash'));

  assert.equal(chat.model, 'deepseek/deepseek-v4-flash');
  const userMessage = chat.messages.find((message) => message.role === 'user');
  assert.equal(userMessage.content.some((part) => part.type === 'image_url'), false);
  const text = userMessage.content.map((part) => part.text || '').join('\n');
  assert.match(text, /DESCRIPCION_TEXTO/);
  assert.equal(calls.describeImage, 1);
});

test('auto and missing model keep the current default and lossy vision', async () => {
  const { translateRequest, calls } = createTranslator();
  const { chat } = await translateRequest(imageBody('auto'));
  assert.equal(chat.model, 'deepseek-v4-flash');
  const userMessage = chat.messages.find((message) => message.role === 'user');
  assert.equal(userMessage.content.some((part) => part.type === 'image_url'), false);
  assert.equal(calls.describeImage, 1);
});

test('an invalid image reference under native vision becomes a diagnostic note, not a silent drop', async () => {
  const { translateRequest } = createTranslator();
  const body = imageBody('meta/muse-spark-1.2-contributor');
  body.input[0].content[1].image_url = 'not-a-data-url';
  const { chat } = await translateRequest(body);

  const userMessage = chat.messages.find((message) => message.role === 'user');
  assert.equal(userMessage.content.some((part) => part.type === 'image_url'), false);
  const text = userMessage.content.map((part) => part.text || '').join('\n');
  assert.match(text, /Imagen 1 no descrita/);
});
