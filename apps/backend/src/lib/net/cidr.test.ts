/**
 * CIDR membership — strict tests (IPv4 + IPv6 + adversarial).
 *
 * Coverage:
 *   - IPv4 inside / outside / boundary CIDRs
 *   - IPv6 inside / outside / boundary
 *   - Family mismatch (v4 against v6 CIDR) → false
 *   - Malformed IP / malformed CIDR → false
 *   - /0 matches everything in family
 *   - /32 / /128 — exact match only
 *   - ЮKassa allowlist canon (7 CIDRs from 2026-05-19 verified)
 */

import { describe, expect, test } from 'bun:test'
import { isIpInCidr } from './cidr.ts'

describe('isIpInCidr — IPv4', () => {
	test('inside /27', () => {
		expect(isIpInCidr('185.71.76.5', '185.71.76.0/27')).toBe(true)
		expect(isIpInCidr('185.71.76.31', '185.71.76.0/27')).toBe(true)
	})
	test('outside /27 (one past upper bound)', () => {
		expect(isIpInCidr('185.71.76.32', '185.71.76.0/27')).toBe(false)
	})
	test('inside /25', () => {
		expect(isIpInCidr('77.75.153.5', '77.75.153.0/25')).toBe(true)
		expect(isIpInCidr('77.75.153.127', '77.75.153.0/25')).toBe(true)
		expect(isIpInCidr('77.75.153.128', '77.75.153.0/25')).toBe(false)
	})
	test('/32 — exact match only', () => {
		expect(isIpInCidr('77.75.156.11', '77.75.156.11/32')).toBe(true)
		expect(isIpInCidr('77.75.156.12', '77.75.156.11/32')).toBe(false)
	})
	test('/0 — matches all IPv4', () => {
		expect(isIpInCidr('1.2.3.4', '0.0.0.0/0')).toBe(true)
		expect(isIpInCidr('203.0.113.255', '0.0.0.0/0')).toBe(true)
	})
})

describe('isIpInCidr — IPv6', () => {
	test('inside /32', () => {
		expect(isIpInCidr('2a02:5180::1', '2a02:5180::/32')).toBe(true)
		expect(isIpInCidr('2a02:5180:abc:def::1', '2a02:5180::/32')).toBe(true)
	})
	test('outside /32', () => {
		expect(isIpInCidr('2a02:5181::1', '2a02:5180::/32')).toBe(false)
	})
	test('/128 — exact match only', () => {
		expect(isIpInCidr('2001:db8::1', '2001:db8::1/128')).toBe(true)
		expect(isIpInCidr('2001:db8::2', '2001:db8::1/128')).toBe(false)
	})
	test('compressed forms equivalent', () => {
		expect(isIpInCidr('2a02:5180::', '2a02:5180:0000:0000:0000:0000:0000:0000/32')).toBe(true)
	})
})

describe('isIpInCidr — adversarial', () => {
	test('family mismatch v4 against v6 CIDR → false', () => {
		expect(isIpInCidr('1.2.3.4', '2a02:5180::/32')).toBe(false)
	})
	test('family mismatch v6 against v4 CIDR → false', () => {
		expect(isIpInCidr('2a02:5180::1', '185.71.76.0/27')).toBe(false)
	})
	test('malformed IP → false (no throw)', () => {
		expect(isIpInCidr('not-an-ip', '185.71.76.0/27')).toBe(false)
		expect(isIpInCidr('300.0.0.1', '0.0.0.0/0')).toBe(false)
		expect(isIpInCidr('1.2.3', '0.0.0.0/0')).toBe(false)
		expect(isIpInCidr('::ffff:1.2.3.4', '0.0.0.0/0')).toBe(false) // v4-mapped не support
	})
	test('malformed CIDR → false', () => {
		expect(isIpInCidr('1.2.3.4', 'not-a-cidr')).toBe(false)
		expect(isIpInCidr('1.2.3.4', '1.2.3.4')).toBe(false) // no slash
		expect(isIpInCidr('1.2.3.4', '1.2.3.4/33')).toBe(false) // prefix > 32 для v4
		expect(isIpInCidr('2a02::', '2a02::/129')).toBe(false) // prefix > 128 для v6
	})
})

describe('ЮKassa webhook IP allowlist canon (2026-05-19 verified)', () => {
	const cidrs = [
		'185.71.76.0/27',
		'185.71.77.0/27',
		'77.75.153.0/25',
		'77.75.154.128/25',
		'77.75.156.11/32',
		'77.75.156.35/32',
		'2a02:5180::/32',
	]
	test('representative IP from each CIDR matches', () => {
		const samples = [
			'185.71.76.5',
			'185.71.77.5',
			'77.75.153.5',
			'77.75.154.130',
			'77.75.156.11',
			'77.75.156.35',
			'2a02:5180::1',
		]
		for (let i = 0; i < samples.length; i++) {
			expect(isIpInCidr(samples[i]!, cidrs[i]!)).toBe(true)
		}
	})
	test('common public IP NOT matched by any CIDR', () => {
		const outside = '203.0.113.1'
		const anyMatch = cidrs.some((c) => isIpInCidr(outside, c))
		expect(anyMatch).toBe(false)
	})
})
