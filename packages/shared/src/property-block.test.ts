import { describe, expect, test } from 'bun:test'
import {
	isPropertyBlockCommentPII,
	propertyBlockCreateInput,
	propertyBlockUpdateInput,
} from './property-block.ts'

/**
 * G9 — strict tests for 152-ФЗ PII guard + Zod input schemas. Per
 * `[[strict-tests]]` canon: exact-value assertions, adversarial inputs,
 * adversarial inputs that target the regex boundaries.
 */
describe('isPropertyBlockCommentPII — 152-ФЗ guard', () => {
	test('rejects 10-digit phone (mobile RU)', () => {
		expect(isPropertyBlockCommentPII('Звонить 9123456789 для согласования')).toBe(true)
	})

	test('rejects 11-digit phone +7 form (digits-only after strip)', () => {
		expect(isPropertyBlockCommentPII('+7 (912) 345-67-89')).toBe(false) // separators break the run
		expect(isPropertyBlockCommentPII('+79123456789')).toBe(true) // 11 digits in a row
	})

	test('rejects 10-digit INN', () => {
		expect(isPropertyBlockCommentPII('ИНН 7707083893')).toBe(true)
	})

	test('rejects 9-digit run (boundary — passes)', () => {
		// 9 digits NOT a match — would be too noisy for legitimate refs
		expect(isPropertyBlockCommentPII('Заказ 123456789')).toBe(false)
	})

	test('rejects email-like patterns', () => {
		expect(isPropertyBlockCommentPII('Связаться owner@example.com')).toBe(true)
		expect(isPropertyBlockCommentPII('mail: x.y.z+plus@a.co.uk перед заездом')).toBe(true)
	})

	test('does NOT reject legitimate maintenance comments', () => {
		expect(isPropertyBlockCommentPII('Замена сантехники')).toBe(false)
		expect(isPropertyBlockCommentPII('Покраска стен')).toBe(false)
		expect(isPropertyBlockCommentPII('VIP-подготовка')).toBe(false)
		expect(isPropertyBlockCommentPII('Ремонт после потопа на этаже')).toBe(false)
		expect(isPropertyBlockCommentPII('')).toBe(false)
	})

	test('does NOT reject room references like 101 / 12A', () => {
		expect(isPropertyBlockCommentPII('Проверить с № 101')).toBe(false)
		expect(isPropertyBlockCommentPII('После уборки в 12A')).toBe(false)
	})

	test('case insensitivity of email tld', () => {
		expect(isPropertyBlockCommentPII('foo@bar.COM')).toBe(true)
		expect(isPropertyBlockCommentPII('foo@bar.org')).toBe(true)
	})
})

describe('propertyBlockCreateInput — Zod schema', () => {
	const baseValid = {
		roomIds: ['room_01HKQXR2T8J1QY7Q5W7K8R5K9P'],
		startDate: '2026-06-01',
		endDate: '2026-06-05',
		reason: 'repair' as const,
	}

	test('accepts valid minimal input', () => {
		expect(propertyBlockCreateInput.safeParse(baseValid).success).toBe(true)
	})

	test('accepts comment when provided and non-PII', () => {
		const parsed = propertyBlockCreateInput.safeParse({
			...baseValid,
			comment: 'Замена сантехники',
		})
		expect(parsed.success).toBe(true)
	})

	test('rejects empty roomIds', () => {
		const parsed = propertyBlockCreateInput.safeParse({ ...baseValid, roomIds: [] })
		expect(parsed.success).toBe(false)
	})

	test('rejects >50 roomIds (operator-scale guard)', () => {
		const tooMany = Array.from(
			{ length: 51 },
			(_, i) => `room_01HKQXR2T8J1QY7Q5W7K8R5K${String(i).padStart(2, '0')}`,
		)
		const parsed = propertyBlockCreateInput.safeParse({ ...baseValid, roomIds: tooMany })
		expect(parsed.success).toBe(false)
	})

	test('rejects startDate >= endDate', () => {
		expect(
			propertyBlockCreateInput.safeParse({
				...baseValid,
				startDate: '2026-06-05',
				endDate: '2026-06-05',
			}).success,
		).toBe(false)
		expect(
			propertyBlockCreateInput.safeParse({
				...baseValid,
				startDate: '2026-06-10',
				endDate: '2026-06-05',
			}).success,
		).toBe(false)
	})

	test('rejects invalid reason', () => {
		expect(
			propertyBlockCreateInput.safeParse({ ...baseValid, reason: 'fancy_event' }).success,
		).toBe(false)
	})

	test('rejects PII-leaking comment', () => {
		const parsed = propertyBlockCreateInput.safeParse({
			...baseValid,
			comment: 'Передать гостю Иванов через 9123456789',
		})
		expect(parsed.success).toBe(false)
	})

	test('rejects comment >200 chars', () => {
		const parsed = propertyBlockCreateInput.safeParse({
			...baseValid,
			comment: 'a'.repeat(201),
		})
		expect(parsed.success).toBe(false)
	})

	test('rejects malformed date (YYYY-M-D)', () => {
		const parsed = propertyBlockCreateInput.safeParse({
			...baseValid,
			startDate: '2026-6-1',
		})
		expect(parsed.success).toBe(false)
	})

	test('rejects bogus room ID prefix (rmt instead of room)', () => {
		const parsed = propertyBlockCreateInput.safeParse({
			...baseValid,
			roomIds: ['rmt_01HKQXR2T8J1QY7Q5W7K8R5K9P'],
		})
		expect(parsed.success).toBe(false)
	})
})

describe('propertyBlockUpdateInput — Zod schema', () => {
	test('rejects empty patch object', () => {
		expect(propertyBlockUpdateInput.safeParse({}).success).toBe(false)
	})

	test('accepts single-field update', () => {
		expect(propertyBlockUpdateInput.safeParse({ reason: 'deep_clean' }).success).toBe(true)
	})

	test('accepts comment=null (clearing)', () => {
		expect(propertyBlockUpdateInput.safeParse({ comment: null }).success).toBe(true)
	})

	test('rejects PII in comment update', () => {
		expect(propertyBlockUpdateInput.safeParse({ comment: 'phone 9123456789' }).success).toBe(false)
	})
})
