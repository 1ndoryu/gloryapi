import { describe, it, expect } from 'vitest';
import { isRetryableError, isToolSchemaCompatibilityError } from '../../routes/proxy.js';

describe('isRetryableError', () => {
  describe('413 Payload Too Large', () => {
    it('treats explicit "413" in the error message as retryable', () => {
      expect(isRetryableError(new Error('GitHub Models API error 413: Request body too large'))).toBe(true);
      expect(isRetryableError(new Error('Cloudflare API error 413: Payload Too Large'))).toBe(true);
    });

    it('treats common 413 phrasings (no status code) as retryable', () => {
      expect(isRetryableError(new Error('Payload Too Large'))).toBe(true);
      expect(isRetryableError(new Error('Request body too large for this model'))).toBe(true);
      expect(isRetryableError(new Error('Request entity too large'))).toBe(true);
      expect(isRetryableError(new Error('Content too large'))).toBe(true);
    });
  });

  describe('404 model removed / not found (the bug #66 fixes)', () => {
    it('treats explicit "404" in the error message as retryable', () => {
      expect(isRetryableError(new Error('OpenRouter API error 404: Provider returned error'))).toBe(true);
      expect(isRetryableError(new Error('Groq API error 404: model not found'))).toBe(true);
    });

    it('catches OpenRouter\'s "No endpoints found" phrasing for deprecated models', () => {
      expect(isRetryableError(new Error('No endpoints found for openrouter/minimax/minimax-m2.5:free'))).toBe(true);
    });

    it('catches bare "not found" phrasing (any provider, any case)', () => {
      expect(isRetryableError(new Error('Model not found'))).toBe(true);
      expect(isRetryableError(new Error('The requested model was not found'))).toBe(true);
    });
  });

  describe('existing categories still classify correctly', () => {
    it('429 / rate limits are retryable', () => {
      expect(isRetryableError(new Error('429 Too Many Requests'))).toBe(true);
      expect(isRetryableError(new Error('rate limit exceeded'))).toBe(true);
      expect(isRetryableError(new Error('quota exhausted'))).toBe(true);
    });

    it('5xx and network errors are retryable', () => {
      expect(isRetryableError(new Error('503 Service Unavailable'))).toBe(true);
      expect(isRetryableError(new Error('500 Internal Server Error'))).toBe(true);
      expect(isRetryableError(new Error('ETIMEDOUT'))).toBe(true);
      expect(isRetryableError(new Error('ECONNREFUSED'))).toBe(true);
    });

    it('4xx auth errors ARE retryable (different key may work); 400 is NOT (schema mismatch handled separately)', () => {
      // 401/403: key-level auth — a different key in the fallback chain may work.
      expect(isRetryableError(new Error('401 Unauthorized'))).toBe(true);
      expect(isRetryableError(new Error('403 Forbidden'))).toBe(true);
      // 400: validation / bad request — not recoverable by retrying another key.
      // Provider-specific schema mismatches are handled by isToolSchemaCompatibilityError.
      expect(isRetryableError(new Error('400 Bad Request'))).toBe(false);
      // Keyword-based: "invalid api key" has no status code, treated as key-level failure.
      expect(isRetryableError(new Error('Invalid API key'))).toBe(true);
    });
  });
});

describe('isToolSchemaCompatibilityError', () => {
  it('treats provider tool-schema unknown-field errors as fallbackable', () => {
    expect(
      isToolSchemaCompatibilityError(
        new Error('Invalid JSON payload received. Unknown name "futureField" at \'tools[0].function_declarations[0].parameters.properties[0].value\': Cannot find field.'),
      ),
    ).toBe(true);
  });

  it('treats missing thought_signature validation errors as fallbackable', () => {
    expect(
      isToolSchemaCompatibilityError(
        new Error('Google API error 400: Bad Request. messages[2].tool_calls[0].thought_signature should be specified for function call turns.'),
      ),
    ).toBe(true);
  });

  it('does not classify generic 400 validation errors as schema mismatches', () => {
    expect(isToolSchemaCompatibilityError(new Error('400 Bad Request: content is required'))).toBe(false);
  });
});
