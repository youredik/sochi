/**
 * Strict tests for the M8.A.0.6 + M9.widget.5 notification surface:
 *   - `NotificationKind` enum: 4 payment + 3 internal + 3 public-widget guest
 *     journey + 1 magic-link = 11 total. М9.widget.5/A3.1.c added
 *     `booking_magic_link` for find-by-ref-email magic-link delivery.
 *   - `NotificationRecipientKind` enum with 4 values
 *   - `Notification.recipientKind` field is required+nullable on the
 *     domain type (forward-compat with M7 rows that have NULL)
 *
 * Per `feedback_strict_tests.md`:
 *   - exact-value asserts on every enum member (no count alone)
 *   - regression: removing/renaming a value WILL fail loud
 */
import { describe, expect, it } from 'vitest'
import {
	deriveRecipientKindFromNotificationKind,
	type NotificationKind,
	type NotificationRecipientKind,
	notificationKindSchema,
	notificationRecipientKindSchema,
} from './notification.ts'

describe('NotificationKind enum (regression — fail loud)', () => {
	const allValues: NotificationKind[] = [
		'payment_succeeded',
		'payment_failed',
		'receipt_confirmed',
		'receipt_failed',
		'booking_confirmed',
		'checkin_reminder',
		'review_request',
		'pre_arrival',
		'booking_cancelled',
		'booking_modified',
		'booking_magic_link',
	]

	it.each(allValues)('accepts canonical kind %s', (k) => {
		expect(notificationKindSchema.parse(k)).toBe(k)
	})

	it('exposes exactly 11 kinds (4 payment + 3 internal + 3 public-widget + 1 magic-link)', () => {
		expect(notificationKindSchema.options).toHaveLength(11)
	})

	it('rejects unknown kind', () => {
		expect(() => notificationKindSchema.parse('unknown_kind')).toThrow()
	})

	it('rejects empty string', () => {
		expect(() => notificationKindSchema.parse('')).toThrow()
	})
})

describe('NotificationRecipientKind enum (regression — fail loud)', () => {
	const allValues: NotificationRecipientKind[] = ['user', 'guest', 'system', 'channel']

	it.each(allValues)('accepts canonical recipientKind %s', (k) => {
		expect(notificationRecipientKindSchema.parse(k)).toBe(k)
	})

	it('exposes exactly 4 recipient kinds', () => {
		expect(notificationRecipientKindSchema.options).toHaveLength(4)
	})

	it('rejects unknown recipientKind (e.g. "admin")', () => {
		expect(() => notificationRecipientKindSchema.parse('admin')).toThrow()
	})

	it('rejects null on schema (nullability is at the row level, not enum)', () => {
		expect(() => notificationRecipientKindSchema.parse(null)).toThrow()
	})

	it('rejects empty string', () => {
		expect(() => notificationRecipientKindSchema.parse('')).toThrow()
	})
})

describe('M8.A.0.6 new public-widget kinds (locked-in subset)', () => {
	const newKinds = ['pre_arrival', 'booking_cancelled', 'booking_modified'] as const

	it.each(newKinds)('%s is a valid NotificationKind', (k) => {
		expect(notificationKindSchema.parse(k)).toBe(k)
	})
})

describe('deriveRecipientKindFromNotificationKind — full enum coverage', () => {
	// Ops alerts → 'system' (no human recipient at this layer)
	it.each(['payment_failed', 'receipt_failed'] as const)('%s → system (ops alert)', (k) => {
		expect(deriveRecipientKindFromNotificationKind(k)).toBe('system')
	})

	// Guest-facing → 'guest' (9 of 11 kinds)
	it.each([
		'payment_succeeded',
		'receipt_confirmed',
		'booking_confirmed',
		'checkin_reminder',
		'review_request',
		'pre_arrival',
		'booking_cancelled',
		'booking_modified',
		'booking_magic_link',
	] as const)('%s → guest', (k) => {
		expect(deriveRecipientKindFromNotificationKind(k)).toBe('guest')
	})

	it('switch is exhaustive over all 11 kinds (no fallthrough/throws)', () => {
		const all: NotificationKind[] = [
			'payment_succeeded',
			'payment_failed',
			'receipt_confirmed',
			'receipt_failed',
			'booking_confirmed',
			'checkin_reminder',
			'review_request',
			'pre_arrival',
			'booking_cancelled',
			'booking_modified',
			'booking_magic_link',
		]
		for (const k of all) {
			const out = deriveRecipientKindFromNotificationKind(k)
			expect(['user', 'guest', 'system', 'channel']).toContain(out)
		}
	})
})
