/**
 * The guard on the one endpoint that makes outbound requests.
 *
 * `/api/publish/preflight` fetches a URL supplied by an anonymous caller.
 * Without a guard that field is a request forwarder into whatever the
 * container can reach — its own cloud metadata service, the database on the
 * private network, sibling services in the same project. None of that would
 * look like an error in a log; it would look like an agent that failed
 * conformance.
 *
 * These tests pin the refusals rather than the acceptances, because a guard
 * that fails open fails silently.
 */

import { describe, expect, it } from 'vitest';
import { assertFetchableEndpoint, PreflightError } from '../src/preflight.js';

/** Every literal address the guard must refuse without consulting DNS. */
const PRIVATE = [
  ['loopback', 'http://127.0.0.1:8080'],
  ['loopback, elsewhere in the /8', 'http://127.9.9.9/'],
  ['all-zeroes', 'http://0.0.0.0/'],
  ['RFC 1918 ten', 'http://10.0.0.5/agents/a'],
  ['RFC 1918 one-seven-two', 'http://172.16.0.1/'],
  ['RFC 1918 one-seven-two, top of range', 'http://172.31.255.254/'],
  ['RFC 1918 one-nine-two', 'http://192.168.1.1/'],
  ['carrier-grade NAT', 'http://100.64.0.1/'],
  ['multicast', 'http://224.0.0.1/'],
  ['IPv6 loopback', 'http://[::1]:8080/'],
  ['IPv6 unique-local', 'http://[fd00::1]/'],
  ['IPv6 link-local', 'http://[fe80::1]/'],
  ['IPv4 mapped into IPv6', 'http://[::ffff:127.0.0.1]/'],
  // The same address as the URL parser rewrites it. This is the form the guard
  // actually sees, and checking only the readable one left the hole open.
  ['IPv4 mapped into IPv6, in the hex form URL normalises to', 'http://[::ffff:7f00:1]/'],
  ['a mapped RFC 1918 address', 'http://[::ffff:192.168.1.1]/'],
  ['a mapped metadata address', 'http://[::ffff:169.254.169.254]/'],
  ['the deprecated IPv4-compatible form', 'http://[::127.0.0.1]/'],
  ['IPv6 multicast', 'http://[ff02::1]/'],
  ['unique-local at the top of fc00::/7', 'http://[fdff:ffff::1]/'],
  ['link-local at the top of fe80::/10', 'http://[febf::1]/'],
] as const;

describe('assertFetchableEndpoint', () => {
  for (const [what, url] of PRIVATE) {
    it(`refuses ${what}`, async () => {
      await expect(assertFetchableEndpoint(url)).rejects.toThrow(PreflightError);
    });
  }

  it('refuses the cloud metadata address specifically', async () => {
    // 169.254.169.254 is the one that turns an SSRF into stolen credentials on
    // most hosts, and it is worth its own test rather than being covered
    // incidentally by the link-local range.
    await expect(assertFetchableEndpoint('http://169.254.169.254/latest/meta-data/')).rejects.toThrow(
      /not a public address/,
    );
  });

  it('refuses a scheme that is not http', async () => {
    await expect(assertFetchableEndpoint('file:///etc/passwd')).rejects.toThrow(/http or https/);
    await expect(assertFetchableEndpoint('gopher://example.com/')).rejects.toThrow(/http or https/);
  });

  it('refuses a URL carrying credentials', async () => {
    await expect(assertFetchableEndpoint('https://user:pw@example.com/')).rejects.toThrow(
      /must not carry credentials/,
    );
  });

  it('refuses something that is not a URL at all', async () => {
    await expect(assertFetchableEndpoint('not a url')).rejects.toThrow(/is not a URL/);
  });

  it('refuses a hostname that does not resolve', async () => {
    await expect(
      assertFetchableEndpoint('https://this-host-does-not-exist.invalid/'),
    ).rejects.toThrow(/does not resolve/);
  });

  it('refuses a public-looking name that resolves to loopback', async () => {
    // The whole reason the guard resolves rather than pattern-matching the
    // hostname. localhost is the resolver's own answer, so this needs no
    // network and no attacker-controlled domain.
    await expect(assertFetchableEndpoint('http://localhost:8080/agents/a')).rejects.toThrow(
      /not a public address/,
    );
  });

  it('accepts a genuinely public IPv6 address', async () => {
    // The guard must not refuse all of IPv6 to be safe — an agent on a v6-only
    // host is a legitimate agent, and a blanket refusal would be a bug that
    // looks like caution.
    const url = await assertFetchableEndpoint('http://[2606:4700:4700::1111]/agents/a');
    expect(url.hostname).toBe('[2606:4700:4700::1111]');
  });

  it('accepts a public host, and normalises it', async () => {
    const url = await assertFetchableEndpoint('https://example.com/agents/audit');
    expect(url.hostname).toBe('example.com');
    expect(url.protocol).toBe('https:');
  });

  it('says how to publish an agent it will not reach, rather than only refusing', async () => {
    // Someone running an agent on their laptop is not attacking anything, and
    // the refusal should point them at the tool that works.
    await expect(assertFetchableEndpoint('http://127.0.0.1:8080')).rejects.toThrow(
      /npx @0gflow\/publish/,
    );
  });
});
