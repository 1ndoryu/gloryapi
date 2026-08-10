'use strict';

const net = require('node:net');

function isPrivateAddress(hostname) {
  const host = hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (host === 'localhost' || host.endsWith('.local')) return true;
  if (net.isIP(host) === 4) {
    const [a, b] = host.split('.').map(Number);
    return a === 0 || a === 10 || a === 127 || (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
  }
  return net.isIP(host) === 6 && (host === '::1' || host.startsWith('fc') || host.startsWith('fd') || host.startsWith('fe8'));
}

function assertSafeVisionEndpoint(rawUrl) {
  const url = new URL(rawUrl);
  if (url.protocol !== 'https:' || url.username || url.password || isPrivateAddress(url.hostname)) {
    throw new Error('Vision endpoint must be public HTTPS without embedded credentials');
  }
  return url;
}

function assertSafeLoopbackUpstream(rawUrl) {
  const url = new URL(rawUrl);
  if (url.protocol !== 'http:' || !['127.0.0.1', 'localhost'].includes(url.hostname)) {
    throw new Error('Bridge upstream must be explicit loopback HTTP');
  }
  return url;
}

module.exports = { assertSafeVisionEndpoint, assertSafeLoopbackUpstream, isPrivateAddress };
