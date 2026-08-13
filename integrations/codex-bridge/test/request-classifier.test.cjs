const assert = require('node:assert/strict');
const test = require('node:test');
const { createRequestClassifier, requestFingerprint } = require('../bridge/request-classifier');
const { localTitle, localTitleOutput, titleMaxLength } = require('../bridge/title-responder');

function request(model, text) {
  return {
    model,
    stream: true,
    input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text }] }],
  };
}

function structuredTitleRequest(model, text) {
  return {
    ...request(model, `Instrucciones internas distintas.\n\nUser prompt:\n${text}`),
    text: {
      format: {
        type: 'json_schema',
        name: 'codex_output_schema',
        strict: true,
        schema: {
          type: 'object',
          properties: {
            title: { type: 'string', minLength: 1, maxLength: 36 },
            description: { type: 'string', minLength: 1 },
          },
          required: ['title', 'description'],
          additionalProperties: false,
        },
      },
    },
  };
}

test('el contrato estructurado de título se resuelve aunque el prompt no coincida', () => {
  const classifier = createRequestClassifier();
  const title = classifier.classify(structuredTitleRequest('gpt-5.6-luna', 'hola, esto es un test'), 1000);
  assert.equal(title.kind, 'auxiliary_title');
  assert.equal(title.reason, 'structured_title_schema');
});

test('el contrato estructurado no convierte otros modelos del selector en títulos', () => {
  const classifier = createRequestClassifier();
  const muse = classifier.classify(structuredTitleRequest('gpt-5.6-terra', 'hola'), 1000);
  assert.equal(muse.kind, 'main');
});

test('la respuesta local respeta el JSON estructurado y el máximo de título', () => {
  const body = structuredTitleRequest('gpt-5.6-luna', 'corrige las solicitudes duplicadas del bridge');
  const title = localTitle(body, titleMaxLength(body));
  const output = JSON.parse(localTitleOutput(body, title));
  assert.equal(output.title.length <= 36, true);
  assert.equal(output.description, output.title);
  assert.match(output.title, /^corrige las solicitudes/i);
});

test('un primer request explícito a Pro no se convierte en título', () => {
  const classifier = createRequestClassifier();
  const result = classifier.classify(request('gpt-5.6-luna', 'revisa el bridge'), 1000);
  assert.equal(result.kind, 'main');
});

test('un primer request explícito a Muse no se convierte en título', () => {
  const classifier = createRequestClassifier({
    duplicateWindowMs: 15000,
    defaultTitleModels: ['gpt-5.6-sol', 'gpt-5.6-luna', 'gpt-5.6-terra'],
  });
  const result = classifier.classify(request('gpt-5.6-terra', 'revisa una imagen'), 1000);
  assert.equal(result.kind, 'main');
});

test('repetir texto entre modelos no basta para clasificar una solicitud como título', () => {
  const classifier = createRequestClassifier();
  classifier.classify(request('gpt-5.6-sol', 'misma petición'));
  const explicitPro = classifier.classify(request('gpt-5.6-luna', 'misma petición'));
  assert.equal(explicitPro.kind, 'main');
});

test('la huella no contiene el texto y el título local queda acotado', () => {
  const body = request('gpt-5.6-sol', 'corrige el bridge y revisa los errores');
  const fingerprint = requestFingerprint(body);
  assert.match(fingerprint, /^[a-f0-9]{24}$/);
  assert.equal(localTitle(body), 'corrige el bridge y revisa los errores');
});
