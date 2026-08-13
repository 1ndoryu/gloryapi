const assert = require('node:assert/strict');
const test = require('node:test');
const { createRequestClassifier, requestFingerprint } = require('../bridge/request-classifier');
const { localTitle } = require('../bridge/title-responder');

function request(model, text) {
  return {
    model,
    stream: true,
    input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text }] }],
  };
}

test('el alias de título solo se clasifica tras repetir el mismo input desde otro modelo', () => {
  const classifier = createRequestClassifier({ duplicateWindowMs: 15000 });
  const first = classifier.classify(request('gpt-5.6-sol', 'hola esto es un test'), 1000);
  const title = classifier.classify(request('gpt-5.6-luna', 'hola esto es un test'), 2000);
  assert.equal(first.kind, 'main');
  assert.equal(title.kind, 'auxiliary_title');
  assert.equal(title.reason, 'repeated_input_with_title_alias');
});

test('un primer request explícito a Pro no se convierte en título', () => {
  const classifier = createRequestClassifier({ duplicateWindowMs: 15000 });
  const result = classifier.classify(request('gpt-5.6-luna', 'revisa el bridge'), 1000);
  assert.equal(result.kind, 'main');
});

test('un input distinto no se clasifica como título', () => {
  const classifier = createRequestClassifier({ duplicateWindowMs: 15000 });
  classifier.classify(request('gpt-5.6-sol', 'primera tarea'), 1000);
  const result = classifier.classify(request('gpt-5.6-luna', 'segunda tarea'), 2000);
  assert.equal(result.kind, 'main');
});

test('la huella no contiene el texto y el título local queda acotado', () => {
  const body = request('gpt-5.6-sol', 'corrige el bridge y revisa los errores');
  const fingerprint = requestFingerprint(body);
  assert.match(fingerprint, /^[a-f0-9]{24}$/);
  assert.equal(localTitle(body), 'corrige el bridge y revisa los errores');
});
