/**
 * Strict tests for the new M8.A.0.6 surface:
 *   - `NotificationKind` enum extended with 3 new kinds (10 total)
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
	]

	it.each(allValues)('accepts canonical kind %s', (k) => {
		expect(notificationKindSchema.parse(k)).toBe(k)
	})

	it('exposes exactly 10 kinds (7 internal + 3 public-widget)', () => {
		expect(notificationKindSchema.options).toHaveLength(10)
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
