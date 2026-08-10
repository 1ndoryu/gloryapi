import { describe, expect, it } from 'vitest';
import { classifyProxyError } from '../../routes/proxy-errors.js';
import { MODEL_FALLBACK_OVERRIDES } from '../../routes/proxy-routing.js';
import { chatCompletionSchema } from '../../routes/proxy-contract.js';
import { ANDORYYU_REGRESSION_FIXTURE } from '../fixtures/andoryyu-regression.js';

describe('proxy error taxonomy', () => {
  it.each([
    [new Error('400 Bad Request: invalid field'), 'request_invalid', false],
    [new Error('401 Unauthorized'), 'authentication_failed', true],
    [new Error('429 Too Many Requests'), 'rate_limited', true],
    [new Error('request timed out'), 'request_timeout', true],
    [new Error('request timed out'), 'cold_start_timeout', true, { coldStartRetryMs: 1_000 }],
    [Object.assign(new Error('upstream closed'), { streamAbort: true }), 'stream_truncated', true],
    [Object.assign(new Error('client closed'), { cancelled: true, streamAbort: true }), 'request_cancelled', false],
    [new Error('503 Service Unavailable'), 'provider_unavailable', true],
  ] as const)('classifies %s as %s', (error, code, retryable, options) => {
    const result = classifyProxyError(error, options);
    expect(result.code).toBe(code);
    expect(result.retryable).toBe(retryable);
    expect(result.safeMessage.length).toBeGreaterThan(0);
  });

  it('classifies provider schema mismatch separately from generic request rejection', () => {
    expect(classifyProxyError(new Error('400 Bad Request: unknown field thought_signature')).code)
      .toBe('schema_incompatible');
    expect(classifyProxyError(new Error('400 Bad Request: content is required')).code)
      .toBe('request_invalid');
  });

  it('never exposes upstream text, URLs, credentials, or prompt content in the public result', () => {
    const result = classifyProxyError(new Error('Provider API error 500: https://secret.example/key?token=secret-token'));
    expect(result.safeMessage).toBe('Provider is temporarily unavailable.');
    expect(JSON.stringify(result)).not.toMatch(/secret|https?:\/\//i);
  });
});

describe('Andoryyu ChatGPT/VS Code regression fixture', () => {
  it('keeps both sanitized request shapes valid and makes stream truncation fallbackable', () => {
    const chatgpt = ANDORYYU_REGRESSION_FIXTURE.chatgpt;
    const vscode = ANDORYYU_REGRESSION_FIXTURE.vscode;
    expect(chatCompletionSchema.safeParse(chatgpt.request).success).toBe(true);
    expect(chatCompletionSchema.safeParse(vscode.request).success).toBe(true);

    const failure = Object.assign(new Error('fixture upstream EOF'), { streamAbort: true });
    const classification = classifyProxyError(failure);
    expect(classification.code).toBe(chatgpt.expectedErrorCode);
    expect(classification.retryable).toBe(chatgpt.expectedFallback);
    expect(MODEL_FALLBACK_OVERRIDES[ANDORYYU_REGRESSION_FIXTURE.model][1].platform)
      .toBe(chatgpt.expectedNextPlatform);

    expect(vscode.expectedFallback).toBe(false);
    expect(vscode.expectedErrorCode).toBeNull();
  });
});
