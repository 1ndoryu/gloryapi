const assert = require('node:assert/strict');
const test = require('node:test');
const { assertSafeVisionEndpoint, isPrivateAddress, resolveSafeVisionEndpoint } = require('../bridge/endpoint-security');

test('endpoint security classifies loopback, private IPv4/IPv6 and metadata ranges', () => {
  for (const host of ['127.0.0.1', '10.0.0.1', '172.16.0.1', '192.168.1.1', '169.254.169.254', '::1', 'fd00::1', 'fe80::1', 'service.local']) {
    assert.equal(isPrivateAddress(host), true, host);
  }
  assert.equal(isPrivateAddress('8.8.8.8'), false);
  assert.equal(assertSafeVisionEndpoint('https://example.com').protocol, 'https:');
  assert.throws(() => assertSafeVisionEndpoint('http://example.com'), /public HTTPS/);
});

test('vision DNS resolution rechecks all addresses and fails closed on rebinding', async () => {
  await assert.rejects(
    resolveSafeVisionEndpoint('https://vision.example', async () => [{ address: '93.184.216.34' }, { address: '127.0.0.1' }]),
    /private or unavailable/,
  );
  const safe = await resolveSafeVisionEndpoint('https://vision.example', async () => [{ address: '93.184.216.34' }]);
  assert.equal(safe.hostname, 'vision.example');
  assert.deepEqual(safe.__validatedAddresses, [{ address: '93.184.216.34', family: 4 }]);
});
