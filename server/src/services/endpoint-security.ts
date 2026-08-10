import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';

const DNS_CACHE_TTL_MS = 60_000;
const dnsCache = new Map<string, { expiresAt: number; addresses: string[] }>();

function isPrivateIpv4(address: string): boolean {
  const octets = address.split('.').map(Number);
  if (octets.length !== 4 || octets.some(octet => !Number.isInteger(octet) || octet < 0 || octet > 255)) return false;
  const [a, b] = octets;
  return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) ||
    (a === 100 && b >= 64 && b <= 127) || (a === 198 && (b === 18 || b === 19));
}

function isPrivateIpv6(address: string): boolean {
  const normalized = address.toLowerCase().replace(/^\[|\]$/g, '');
  return normalized === '::' || normalized === '::1' || normalized.startsWith('fc') ||
    normalized.startsWith('fd') || normalized.startsWith('fe8') || normalized.startsWith('fe9') ||
    normalized.startsWith('fea') || normalized.startsWith('feb');
}

export function isPrivateAddress(address: string): boolean {
  const normalized = address.replace(/^\[|\]$/g, '');
  return isIP(normalized) === 4 ? isPrivateIpv4(normalized) : isPrivateIpv6(normalized);
}

function allowExplicitLocal(url: URL): boolean {
  return process.env.GLORYAPI_CANARY_MODE === '1' && url.protocol === 'http:' &&
    (url.hostname === '127.0.0.1' || url.hostname === 'localhost');
}

function rejectUnsafeUrl(url: URL): void {
  if (allowExplicitLocal(url)) return;
  if (url.protocol !== 'https:' || !url.hostname || url.username || url.password) {
    throw new Error('Upstream endpoint must use HTTPS without embedded credentials');
  }
  const hostname = url.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (hostname === 'localhost' || hostname.endsWith('.local') || isPrivateAddress(hostname)) {
    throw new Error('Upstream endpoint resolves to a private or local address');
  }
}

async function resolveAddresses(hostname: string): Promise<string[]> {
  const cached = dnsCache.get(hostname);
  if (cached && cached.expiresAt > Date.now()) return cached.addresses;
  const addresses = (await lookup(hostname, { all: true, verbatim: true })).map(entry => entry.address);
  dnsCache.set(hostname, { expiresAt: Date.now() + DNS_CACHE_TTL_MS, addresses });
  if (dnsCache.size > 256) dnsCache.delete(dnsCache.keys().next().value!);
  return addresses;
}

export async function assertSafeUpstreamUrl(rawUrl: string): Promise<URL> {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new Error('Upstream endpoint is not a valid URL');
  }
  rejectUnsafeUrl(url);
  if (allowExplicitLocal(url) || process.env.NODE_ENV === 'test' || process.env.VITEST) return url;
  const addresses = await resolveAddresses(url.hostname);
  if (addresses.length === 0 || addresses.some(isPrivateAddress)) {
    throw new Error('Upstream endpoint DNS resolution is private or unavailable');
  }
  return url;
}

export function clearEndpointSecurityCache(): void {
  dnsCache.clear();
}
