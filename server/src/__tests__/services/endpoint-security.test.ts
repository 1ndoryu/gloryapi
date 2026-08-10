import { describe, expect, it } from 'vitest';
import { assertSafeUpstreamUrl, isPrivateAddress } from '../../services/endpoint-security.js';

describe('upstream endpoint security', () => {
  it('classifies private IPv4/IPv6 ranges', () => {
    expect(isPrivateAddress('127.0.0.1')).toBe(true);
    expect(isPrivateAddress('10.0.0.7')).toBe(true);
    expect(isPrivateAddress('192.168.1.2')).toBe(true);
    expect(isPrivateAddress('::1')).toBe(true);
    expect(isPrivateAddress('fd00::1')).toBe(true);
    expect(isPrivateAddress('8.8.8.8')).toBe(false);
  });

  it('rejects local, credential-bearing, and non-HTTPS endpoints', async () => {
    await expect(assertSafeUpstreamUrl('http://127.0.0.1:3101/v1')).rejects.toThrow(/HTTPS|private|local/i);
    await expect(assertSafeUpstreamUrl('https://user:pass@example.com/v1')).rejects.toThrow(/credentials/i);
    await expect(assertSafeUpstreamUrl('ftp://example.com/v1')).rejects.toThrow(/HTTPS/i);
  });

  it('accepts a public HTTPS URL in test mode without performing network DNS', async () => {
    await expect(assertSafeUpstreamUrl('https://api.example.test/v1')).resolves.toBeInstanceOf(URL);
  });
});
