'use strict';

// 039A-1d: anti-loop master prompt. The bridge appends its own trailing
// system directive next to the execution directive on every upstream request
// with tools. Custom text via BRIDGE_LOOP_DIRECTIVE, off via
// BRIDGE_LOOP_DIRECTIVE=0.

const assert = require('node:assert/strict');
const test = require('node:test');
const { config } = require('../bridge/config');
const { createRequestTranslator } = require('../bridge/request-translator');

function makeTranslator(recoveryOverrides = {}) {
  return createRequestTranslator({
    config: {
      ...config,
      tools: { profile: 'generic' },
      recovery: { ...config.recovery, ...recoveryOverrides },
    },
    describeImage: async () => null,
    extractFocusHint: () => '',
    boundSystemContent: value => String(value),
    log: () => {},
    reasoningFor: () => null,
  });
}

function bodyWithTool() {
  return {
    model: 'gpt-5.6-sol',
    stream: false,
    tools: [{ type: 'function', name: 'shell_command', parameters: { type: 'object' } }],
    input: [
      { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'mide el proyecto' }] },
    ],
  };
}

test('default loop directive ships a Supervisor anti-bucle text', () => {
  if (process.env.BRIDGE_LOOP_DIRECTIVE !== undefined) {
    console.log('skip: BRIDGE_LOOP_DIRECTIVE set in ambient env');
    return;
  }
  const text = config.recovery.loopDirective;
  assert.equal(typeof text, 'string');
  assert.ok(text.startsWith('Supervisor'), 'promotable through the history-mapping rule');
  assert.match(text, /3 veces/);
  assert.match(text, /re-anuncies/);
});

test('translator appends the loop directive as trailing system message', async () => {
  const custom = 'Supervisor — CUSTOM LOOP RULE';
  const result = await makeTranslator({ loopDirective: custom }).translateRequest(bodyWithTool());
  const last = result.chat.messages[result.chat.messages.length - 1];
  assert.equal(last.role, 'system');
  assert.equal(last.content, custom);
});

test('translator skips the loop directive when disabled', async () => {
  const result = await makeTranslator({ loopDirective: '' }).translateRequest(bodyWithTool());
  const texts = result.chat.messages.map(m => String(m.content || ''));
  assert.equal(texts.some(t => t.includes('anti-bucle')), false);
});

test('translator skips the loop directive without tools', async () => {
  const body = bodyWithTool();
  delete body.tools;
  const result = await makeTranslator({ loopDirective: 'Supervisor — CUSTOM LOOP RULE' }).translateRequest(body);
  const texts = result.chat.messages.map(m => String(m.content || ''));
  assert.equal(texts.some(t => t.includes('CUSTOM LOOP RULE')), false);
});
