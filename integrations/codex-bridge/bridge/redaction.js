'use strict';

const SENSITIVE_KEY = /^(?:authorization|proxy-authorization|cookie|set-cookie|x-api-key|api[_-]?key|access[_-]?token|refresh[_-]?token|client[_-]?secret|private[_-]?key|password|secret|credential)$/i;

function redactString(value, maxLength = 500) {
  return String(value == null ? '' : value)
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer [REDACTED]')
    .replace(/(?:sk|freellmapi|gloryapi|ghp|AIza|sk-ant)[_-][A-Za-z0-9._~+/=-]{8,}/gi, '[REDACTED]')
    .replace(/xox[baprs]-[A-Za-z0-9._-]{8,}/gi, '[REDACTED]')
    .replace(/(eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9._-]{10,}\.)[A-Za-z0-9._-]+/g, '$1[REDACTED]')
    .replace(/((?:api[_-]?key|access[_-]?token|refresh[_-]?token|client[_-]?secret|password|secret|credential)\s*[:=]\s*["']?)[^,\s"'}]+/gi, '$1[REDACTED]')
    .slice(0, maxLength);
}

function redactValue(value, { depth = 0, maxDepth = 8, maxArray = 128, maxStringLength = 2000 } = {}) {
  if (typeof value === 'string') return redactString(value, maxStringLength);
  if (value === null || typeof value !== 'object') return value;
  if (depth >= maxDepth) return '[REDACTED_DEPTH]';
  if (Array.isArray(value)) return value.slice(0, maxArray).map((entry) => redactValue(entry, {
    depth: depth + 1,
    maxDepth,
    maxArray,
    maxStringLength,
  }));
  const output = {};
  for (const [key, entry] of Object.entries(value)) {
    if (SENSITIVE_KEY.test(key) || /(?:token|secret|password|credential|api[-_]?key)/i.test(key)) {
      output[key] = '[REDACTED]';
    } else {
      output[key] = redactValue(entry, { depth: depth + 1, maxDepth, maxArray, maxStringLength });
    }
  }
  return output;
}

function redactHeaders(headers) {
  const output = {};
  for (const [key, value] of Object.entries(headers || {})) {
    output[key] = SENSITIVE_KEY.test(key) || /(?:token|secret|password|api[-_]?key)/i.test(key)
      ? '[REDACTED]'
      : redactString(Array.isArray(value) ? value.join(',') : value, 512);
  }
  return output;
}

function redactSseData(data) {
  if (data === '[DONE]') return data;
  try {
    return JSON.stringify(redactValue(JSON.parse(String(data))));
  } catch {
    return redactString(data, 4000);
  }
}

module.exports = { redactString, redactValue, redactHeaders, redactSseData };
