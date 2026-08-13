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

test('varios aliases auxiliares consecutivos del catálogo se resuelven localmente', () => {
  const classifier = createRequestClassifier({
    duplicateWindowMs: 15000,
    defaultTitleModels: ['gpt-5.6-sol', 'gpt-5.6-luna', 'gpt-5.6-terra'],
  });
  const first = classifier.classify(request('gpt-5.6-sol', 'analiza esta tarea'), 1000);
  const pro = classifier.classify(request('gpt-5.6-luna', 'analiza esta tarea'), 2000);
  const muse = classifier.classify(request('gpt-5.6-terra', 'analiza esta tarea'), 3000);
  assert.equal(first.kind, 'main');
  assert.equal(pro.kind, 'auxiliary_title');
  assert.equal(muse.kind, 'auxiliary_title');
});

test('cambiar deliberadamente de modelo tras completar el request no se confunde con un auxiliar', () => {
  const classifier = createRequestClassifier({
    duplicateWindowMs: 15000,
    defaultTitleModels: ['gpt-5.6-sol', 'gpt-5.6-terra'],
  });
  const flash = classifier.classify(request('gpt-5.6-sol', 'compara esta respuesta'), 1000);
  assert.equal(classifier.complete(flash), true);
  const muse = classifier.classify(request('gpt-5.6-terra', 'compara esta respuesta'), 2000);
  assert.equal(muse.kind, 'main');
});

test('el historial temporal conserva un límite estricto y expulsa la entrada más antigua', () => {
  const classifier = createRequestClassifier({ maxRecentEntries: 8 });
  for (let index = 0; index < 20; index += 1) {
    classifier.classify(request('gpt-5.6-sol', `entrada única ${index}`), 1000 + index);
  }
  assert.deepEqual(classifier.stats(), { recentEntries: 8, maxRecentEntries: 8 });
  const evictedDuplicate = classifier.classify(request('gpt-5.6-luna', 'entrada única 0'), 2000);
  assert.equal(evictedDuplicate.kind, 'main');
});

test('un primer request explícito a Pro no se convierte en título', () => {
  const classifier = createRequestClassifier({ duplicateWindowMs: 15000 });
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
