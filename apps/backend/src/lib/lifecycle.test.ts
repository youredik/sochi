/**
 * Strict unit tests для the process lifecycle / draining flag.
 */

import { afterEach, describe, expect, test } from 'bun:test'
import {
	__resetLifecycleForTesting,
	beginDraining,
	isDraining,
	shouldRejectWhileDraining,
} from './lifecycle.ts'

afterEach(__resetLifecycleForTesting)

describe('lifecycle draining flag', () => {
	test('isDraining is false at process start', () => {
		expect(isDraining()).toBe(false)
	})

	test('beginDraining flips it to true', () => {
		beginDraining()
		expect(isDraining()).toBe(true)
	})

	test('beginDraining is idempotent — second call keeps it true', () => {
		beginDraining()
		beginDraining()
		expect(isDraining()).toBe(true)
	})

	test('__resetLifecycleForTesting restores false (test isolation)', () => {
		beginDraining()
		expect(isDraining()).toBe(true)
		__resetLifecycleForTesting()
		expect(isDraining()).toBe(false)
	})
})

describe('shouldRejectWhileDraining — drain guard decision', () => {
	test('not draining → never reject (any path)', () => {
		expect(shouldRejectWhileDraining('/api/v1/properties', false)).toBe(false)
		expect(shouldRejectWhileDraining('/', false)).toBe(false)
	})

	test('draining → reject normal API + SPA paths', () => {
		expect(shouldRejectWhileDraining('/api/v1/properties', true)).toBe(true)
		expect(shouldRejectWhileDraining('/api/auth/sign-in/magic-link', true)).toBe(true)
		expect(shouldRejectWhileDraining('/api/public/demo/inbox', true)).toBe(true)
		expect(shouldRejectWhileDraining('/', true)).toBe(true)
		expect(shouldRejectWhileDraining('/booking/abc', true)).toBe(true)
	})

	test('draining → health endpoints EXEMPT (liveness must stay 200)', () => {
		expect(shouldRejectWhileDraining('/health', true)).toBe(false)
		expect(shouldRejectWhileDraining('/health/live', true)).toBe(false)
		expect(shouldRejectWhileDraining('/health/ready', true)).toBe(false)
		expect(shouldRejectWhileDraining('/health/db', true)).toBe(false)
	})

	test('reads the live flag when draining arg omitted', () => {
		expect(shouldRejectWhileDraining('/api/x')).toBe(false)
		beginDraining()
		expect(shouldRejectWhileDraining('/api/x')).toBe(true)
		expect(shouldRejectWhileDraining('/health/live')).toBe(false)
	})
})
