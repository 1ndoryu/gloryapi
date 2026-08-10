'use strict';

// Prompt-bearing remote failures must cross the diagnostic boundary as a
// closed metadata schema. Never pass a provider error body or message here.
function safeStatus(value) {
  return Number.isSafeInteger(value) && value >= 100 && value <= 599 ? value : 'none';
}

function safeBytes(value) {
  if (value === 'unknown') return value;
  return Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

function formatRemoteFailure(surface, failure = {}) {
  const safeSurface = /^[a-z][a-z0-9_-]{0,31}$/i.test(String(surface || '')) ? String(surface) : 'remote';
  const kind = /^[a-z][a-z0-9_-]{0,31}$/i.test(String(failure.kind || '')) ? String(failure.kind) : 'unknown';
  return `${safeSurface} failed kind=${kind} status=${safeStatus(failure.status)} bytes=${safeBytes(failure.bytes)}`;
}

function responseByteLength(response) {
  const raw = response && response.headers && response.headers.get ? response.headers.get('content-length') : null;
  if (raw == null || String(raw).trim() === '') return 'unknown';
  const value = Number(raw);
  return Number.isSafeInteger(value) && value >= 0 ? value : 'unknown';
}

module.exports = { formatRemoteFailure, responseByteLength };
