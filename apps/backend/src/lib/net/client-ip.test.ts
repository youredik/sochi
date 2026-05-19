/**
 * Strict unit tests для right-most-trusted-proxy client IP resolution
 * (B7 XFF canon refactor, 2026-05-19).
 *
 * Pins canonical behaviour against CVE-2025-68949-class attacks: any
 * regression to «leftmost wins» breaks here.
 */

import { describe, expect, test } from 'bun:test'
import { resolveClientIp, resolveClientIpSync } from './client-ip.ts'

const TRUSTED = ['10.0.0.0/8', '127.0.0.0/8', '::1/128'] as const

describe('resolveClientIp — right-most-trusted-proxy canon', () => {
	test('direct attacker (TCP NOT в trusted CIDRs) → ignore XFF, trust TCP only', () => {
		// Attacker sets bogus XFF; their real TCP peer is the source of truth.
		const ip = resolveClientIp({
			headers: new Headers({ 'x-forwarded-for': '1.2.3.4, 5.6.7.8' }),
			tcpRemoteAddress: '203.0.113.99',
			trustedProxyCidrs: TRUSTED,
		})
		expect(ip).toBe('203.0.113.99')
	})

	test('behind trusted proxy: walks XFF right-to-left, returns first non-trusted', () => {
		// Chain: client → trusted-proxy-1 → trusted-proxy-2 → backend
		// XFF: client, proxy1, proxy2 (in arrival order; rightmost = closest hop)
		const ip = resolveClientIp({
			headers: new Headers({ 'x-forwarded-for': '203.0.113.42, 10.0.0.1, 10.0.0.2' }),
			tcpRemoteAddress: '10.0.0.2',
			trustedProxyCidrs: TRUSTED,
		})
		expect(ip).toBe('203.0.113.42')
	})

	test('attacker-spoofed XFF entry skipped if direct hop is untrusted', () => {
		// Attacker tries: «I am 8.8.8.8» but TCP shows 198.51.100.1 (untrusted).
		// Canon: return TCP peer (attacker XFF discarded entirely).
		const ip = resolveClientIp({
			headers: new Headers({ 'x-forwarded-for': '8.8.8.8' }),
			tcpRemoteAddress: '198.51.100.1',
			trustedProxyCidrs: TRUSTED,
		})
		expect(ip).toBe('198.51.100.1')
	})

	test('all hops trusted (rare) → MDN fallback к chain[0]', () => {
		const ip = resolveClientIp({
			headers: new Headers({ 'x-forwarded-for': '10.0.0.5, 10.0.0.4, 10.0.0.3' }),
			tcpRemoteAddress: '10.0.0.3',
			trustedProxyCidrs: TRUSTED,
		})
		expect(ip).toBe('10.0.0.5')
	})

	test('test harness (tcpRemoteAddress null) → XFF right-walk only', () => {
		const ip = resolveClientIp({
			headers: new Headers({ 'x-forwarded-for': '203.0.113.7, 10.0.0.1' }),
			tcpRemoteAddress: null,
			trustedProxyCidrs: TRUSTED,
		})
		expect(ip).toBe('203.0.113.7')
	})

	test('no XFF, no x-real-ip, only TCP → TCP', () => {
		const ip = resolveClientIp({
			headers: new Headers({}),
			tcpRemoteAddress: '203.0.113.50',
			trustedProxyCidrs: [],
		})
		expect(ip).toBe('203.0.113.50')
	})

	test('no XFF, fallback к x-real-ip', () => {
		const ip = resolveClientIp({
			headers: new Headers({ 'x-real-ip': '203.0.113.77' }),
			tcpRemoteAddress: null,
			trustedProxyCidrs: TRUSTED,
		})
		expect(ip).toBe('203.0.113.77')
	})

	test('nothing supplied → null', () => {
		const ip = resolveClientIp({
			headers: new Headers({}),
			tcpRemoteAddress: null,
			trustedProxyCidrs: TRUSTED,
		})
		expect(ip).toBeNull()
	})

	test('empty-string tcpRemoteAddress treated as null (adversarial-pass guard)', () => {
		// `getConnInfo().remote.address` rarely returns '' but defensive guard
		// avoids "" leaking as the resolved IP.
		const ip = resolveClientIp({
			headers: new Headers({ 'x-forwarded-for': '203.0.113.1' }),
			tcpRemoteAddress: '',
			trustedProxyCidrs: TRUSTED,
		})
		expect(ip).toBe('203.0.113.1')
		// And without XFF: returns null, NOT empty string.
		const ip2 = resolveClientIp({
			headers: new Headers({}),
			tcpRemoteAddress: '',
			trustedProxyCidrs: TRUSTED,
		})
		expect(ip2).toBeNull()
	})

	test('empty XFF string ignored (no false-truthy via empty entry)', () => {
		const ip = resolveClientIp({
			headers: new Headers({ 'x-forwarded-for': '', 'x-real-ip': '203.0.113.88' }),
			tcpRemoteAddress: null,
			trustedProxyCidrs: TRUSTED,
		})
		expect(ip).toBe('203.0.113.88')
	})

	test('XFF с whitespace trimmed per entry', () => {
		const ip = resolveClientIp({
			headers: new Headers({ 'x-forwarded-for': '  203.0.113.7  ,  10.0.0.1  ' }),
			tcpRemoteAddress: null,
			trustedProxyCidrs: TRUSTED,
		})
		expect(ip).toBe('203.0.113.7')
	})
})

describe('resolveClientIp — adversarial spoofing scenarios', () => {
	test('CVE-2025-68949 style: attacker prepends many fake IPs in XFF — leftmost-wins would pick fake; right-walk picks real', () => {
		// Attacker connection from 198.51.100.42 (untrusted). Sends XFF с many
		// forged entries hoping leftmost-wins backend trusts the first one.
		const ip = resolveClientIp({
			headers: new Headers({
				'x-forwarded-for': '1.1.1.1, 2.2.2.2, 3.3.3.3, 4.4.4.4, 5.5.5.5',
			}),
			tcpRemoteAddress: '198.51.100.42',
			trustedProxyCidrs: TRUSTED,
		})
		// Canon: ignore ALL XFF entries — direct TCP peer.
		expect(ip).toBe('198.51.100.42')
		expect(ip).not.toBe('1.1.1.1')
	})

	test('rate-limit defence: per-request unique XFF cannot bypass bucket', () => {
		// Same attacker, multiple requests с different forged XFF chains.
		const TCP = '198.51.100.99'
		const ip1 = resolveClientIp({
			headers: new Headers({ 'x-forwarded-for': '1.1.1.1' }),
			tcpRemoteAddress: TCP,
			trustedProxyCidrs: TRUSTED,
		})
		const ip2 = resolveClientIp({
			headers: new Headers({ 'x-forwarded-for': '2.2.2.2' }),
			tcpRemoteAddress: TCP,
			trustedProxyCidrs: TRUSTED,
		})
		const ip3 = resolveClientIp({
			headers: new Headers({ 'x-forwarded-for': '3.3.3.3' }),
			tcpRemoteAddress: TCP,
			trustedProxyCidrs: TRUSTED,
		})
		// ALL three resolve к same TCP peer → same rate-limit bucket key.
		expect(ip1).toBe(TCP)
		expect(ip2).toBe(TCP)
		expect(ip3).toBe(TCP)
	})

	test('attacker XFF entry matches trusted CIDR — still skipped because TCP untrusted', () => {
		// Attacker forges XFF chain claiming они proxied через 10.0.0.5,
		// but TCP connection is direct from internet.
		const ip = resolveClientIp({
			headers: new Headers({ 'x-forwarded-for': '203.0.113.7, 10.0.0.5' }),
			tcpRemoteAddress: '198.51.100.50',
			trustedProxyCidrs: TRUSTED,
		})
		// TCP не trusted → XFF discarded wholesale.
		expect(ip).toBe('198.51.100.50')
	})
})

describe('resolveClientIpSync — sync variant', () => {
	test('returns IP когда XFF chain has untrusted hop', () => {
		const ip = resolveClientIpSync(
			new Headers({ 'x-forwarded-for': '203.0.113.7, 10.0.0.1' }),
			TRUSTED,
		)
		expect(ip).toBe('203.0.113.7')
	})

	test('returns anonymous литерал когда no headers (NEVER null)', () => {
		const ip = resolveClientIpSync(new Headers({}), TRUSTED)
		expect(ip).toBe('anonymous')
	})

	test('returns anonymous когда XFF empty + no x-real-ip', () => {
		const ip = resolveClientIpSync(new Headers({ 'x-forwarded-for': '' }), TRUSTED)
		expect(ip).toBe('anonymous')
	})

	test('x-real-ip fallback used когда no XFF', () => {
		const ip = resolveClientIpSync(new Headers({ 'x-real-ip': '203.0.113.99' }), TRUSTED)
		expect(ip).toBe('203.0.113.99')
	})

	test('right-most canon: attacker XFF spoof → no per-request bucket bypass', () => {
		// Sync variant в test mode (no TCP peer). Все XFF entries trusted →
		// fallback to chain[0]. Adversarial XFF without trusted proxies leaves
		// us picking the first entry, which is BETTER than nothing but weaker
		// than the async-with-TCP path. Documented sync-variant trade-off.
		// Here we focus on the no-trust case to confirm walk semantics.
		const ip = resolveClientIpSync(
			new Headers({ 'x-forwarded-for': '1.1.1.1, 203.0.113.50' }),
			[], // no trusted proxies — every hop "untrusted"; rightmost wins
		)
		// Right-walk: 203.0.113.50 is rightmost-untrusted → returned.
		expect(ip).toBe('203.0.113.50')
	})
})
