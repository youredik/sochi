/**
 * Fast unit tests for `isLocalYdbPlannerQuirk` — the detector that downgrades
 * the known LOCAL single-node YDB Docker `ERROR(1030): Type annotation`
 * (RemovePrefixMembers) lazy-render failure from a ~105×-at-boot WARN spam to a
 * single INFO, while leaving genuine failures at WARN. Managed YDB (production)
 * accepts the query — verified vs 7 days of demo prod logs (zero occurrences).
 */

import { describe, expect, test } from 'bun:test'
import { isLocalYdbPlannerQuirk } from './notification-dispatcher.ts'

describe('isLocalYdbPlannerQuirk', () => {
	test('matches the YDBError "Type annotation" signature (direct)', () => {
		const err = new Error('GENERIC_ERROR, Issues: ERROR(1030): Type annotation')
		expect(isLocalYdbPlannerQuirk(err)).toBe(true)
	})

	test('matches a plain object carrying the message (YDBError shape)', () => {
		expect(isLocalYdbPlannerQuirk({ message: 'ERROR(1030): Type annotation' })).toBe(true)
	})

	test('matches when wrapped in a cause chain', () => {
		const inner = new Error('GENERIC_ERROR, Issues: ERROR(1030): Type annotation')
		const outer = new Error('lazy-render failed', { cause: inner })
		expect(isLocalYdbPlannerQuirk(outer)).toBe(true)
	})

	test('does NOT match a genuine unrelated YDB/runtime error', () => {
		expect(isLocalYdbPlannerQuirk(new Error('Connection refused'))).toBe(false)
		expect(isLocalYdbPlannerQuirk(new Error('ERROR(2012): Conflict with existing key'))).toBe(false)
		expect(isLocalYdbPlannerQuirk({ message: 'Reader is disposed' })).toBe(false)
	})

	test('does NOT match non-error inputs', () => {
		expect(isLocalYdbPlannerQuirk(null)).toBe(false)
		expect(isLocalYdbPlannerQuirk(undefined)).toBe(false)
		expect(isLocalYdbPlannerQuirk('Type annotation')).toBe(false)
		expect(isLocalYdbPlannerQuirk(1030)).toBe(false)
	})

	test('is cycle-safe — a self-referential cause chain does not hang', () => {
		const cyclic: { message: string; cause?: unknown } = { message: 'boom' }
		cyclic.cause = cyclic
		expect(isLocalYdbPlannerQuirk(cyclic)).toBe(false)
	})
})
