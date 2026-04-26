/**
 * `notification-labels` strict tests per memory `feedback_strict_tests.md` +
 * FULL enum coverage per `feedback_pre_done_audit.md`.
 *
 * Test plan:
 *   notificationStatusBadge — exact match for ALL 3 canonical statuses:
 *     [SS1] pending → "В очереди" / outline
 *     [SS2] sent    → "Отправлено" / secondary
 *     [SS3] failed  → "Ошибка"     / destructive
 *
 *   notificationStatusBadge — unknown fallback (defence-in-depth):
 *     [SU1] empty string → label '' / outline
 *     [SU2] hypothetical "queued" (capitalized variant) → raw code / outline
 *
 *   notificationKindLabel — exact match for ALL 7 canonical kinds:
 *     [KK1] payment_succeeded → "Платёж получен"
 *     [KK2] payment_failed    → "Платёж не прошёл"
 *     [KK3] receipt_confirmed → "Чек ОФД"
 *     [KK4] receipt_failed    → "Ошибка чека"
 *     [KK5] booking_confirmed → "Бронь подтверждена"
 *     [KK6] checkin_reminder  → "Напоминание о заезде"
 *     [KK7] review_request    → "Просьба об отзыве"
 *
 *   notificationKindLabel — unknown fallback:
 *     [KU1] new "promo_offer" → returns raw code
 *
 *   Immutability:
 *     [I1] mutating returned StatusBadgeConf does NOT poison config
 */
import { describe, expect, test } from 'vitest'
import { notificationKindLabel, notificationStatusBadge } from './notification-labels.ts'

describe('notificationStatusBadge — exact match', () => {
	test('[SS1] pending', () => {
		expect(notificationStatusBadge('pending')).toEqual({
			label: 'В очереди',
			variant: 'outline',
		})
	})
	test('[SS2] sent', () => {
		expect(notificationStatusBadge('sent')).toEqual({
			label: 'Отправлено',
			variant: 'secondary',
		})
	})
	test('[SS3] failed', () => {
		expect(notificationStatusBadge('failed')).toEqual({
			label: 'Ошибка',
			variant: 'destructive',
		})
	})
})

describe('notificationStatusBadge — unknown fallback', () => {
	test('[SU1] empty string → label "" / outline', () => {
		expect(notificationStatusBadge('')).toEqual({ label: '', variant: 'outline' })
	})
	test('[SU2] capitalised "PENDING" NOT normalized → raw code', () => {
		expect(notificationStatusBadge('PENDING')).toEqual({
			label: 'PENDING',
			variant: 'outline',
		})
	})
	test('[SU3] future "queued" → raw code', () => {
		expect(notificationStatusBadge('queued')).toEqual({
			label: 'queued',
			variant: 'outline',
		})
	})
})

describe('notificationKindLabel — exact match all 7 canonical kinds', () => {
	test('[KK1] payment_succeeded', () => {
		expect(notificationKindLabel('payment_succeeded')).toBe('Платёж получен')
	})
	test('[KK2] payment_failed', () => {
		expect(notificationKindLabel('payment_failed')).toBe('Платёж не прошёл')
	})
	test('[KK3] receipt_confirmed', () => {
		expect(notificationKindLabel('receipt_confirmed')).toBe('Чек ОФД')
	})
	test('[KK4] receipt_failed', () => {
		expect(notificationKindLabel('receipt_failed')).toBe('Ошибка чека')
	})
	test('[KK5] booking_confirmed', () => {
		expect(notificationKindLabel('booking_confirmed')).toBe('Бронь подтверждена')
	})
	test('[KK6] checkin_reminder', () => {
		expect(notificationKindLabel('checkin_reminder')).toBe('Напоминание о заезде')
	})
	test('[KK7] review_request', () => {
		expect(notificationKindLabel('review_request')).toBe('Просьба об отзыве')
	})
})

describe('notificationKindLabel — unknown fallback', () => {
	test('[KU1] future "promo_offer" → raw code', () => {
		expect(notificationKindLabel('promo_offer')).toBe('promo_offer')
	})
	test('[KU2] empty string → empty', () => {
		expect(notificationKindLabel('')).toBe('')
	})
})

describe('notification-labels — immutability', () => {
	test('[I1] mutating returned conf does NOT poison config', () => {
		const a = notificationStatusBadge('pending')
		a.label = 'MUTATED'
		expect(notificationStatusBadge('pending').label).toBe('В очереди')
	})
})
