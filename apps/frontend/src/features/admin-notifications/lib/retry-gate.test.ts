/**
 * `deriveRetryGate` + `attemptBadgeConf` strict tests per memory
 * `feedback_strict_tests.md` — FULL state-matrix coverage.
 *
 * Test plan:
 *   deriveRetryGate — full 2×3 matrix (status × canRetry):
 *     [G1] status=sent, canRetry=true   → disabled, "already sent" reason
 *     [G2] status=sent, canRetry=false  → disabled, "already sent" wins (sent
 *          beats RBAC — UI logic must show the more specific reason first)
 *     [G3] status=pending, canRetry=true  → ENABLED, reason: null
 *     [G4] status=pending, canRetry=false → disabled, "role required" reason
 *     [G5] status=failed, canRetry=true   → ENABLED, reason: null
 *     [G6] status=failed, canRetry=false  → disabled, "role required" reason
 *
 *   deriveRetryGate — defensive on unknown status:
 *     [GU1] status='UNKNOWN', canRetry=true  → ENABLED (never block on unknown
 *           — backend will reject if invalid; frontend must not silently swallow
 *           the operator action)
 *     [GU2] status='UNKNOWN', canRetry=false → disabled, "role required"
 *
 *   attemptBadgeConf — exact match for ALL 3 attempt kinds:
 *     [BB1] sent                → "Отправлено"        / secondary
 *     [BB2] transient_failure   → "Временная ошибка"  / outline
 *     [BB3] permanent_failure   → "Постоянная ошибка" / destructive
 *
 *   Immutability:
 *     [I1] mutating returned RetryGate.reason does NOT poison subsequent calls
 *     [I2] mutating returned AttemptBadgeConf.label does NOT poison subsequent calls
 */
import { describe, expect, test } from 'vitest'
import { attemptBadgeConf, deriveRetryGate } from './retry-gate.ts'

describe('deriveRetryGate — 2×3 status × canRetry matrix', () => {
	test('[G1] sent + canRetry=true → disabled, already-sent reason', () => {
		expect(deriveRetryGate({ status: 'sent', canRetry: true })).toEqual({
			enabled: false,
			reason: 'Уведомление уже отправлено — повторить нельзя',
		})
	})
	test('[G2] sent + canRetry=false → disabled, already-sent reason wins', () => {
		expect(deriveRetryGate({ status: 'sent', canRetry: false })).toEqual({
			enabled: false,
			reason: 'Уведомление уже отправлено — повторить нельзя',
		})
	})
	test('[G3] pending + canRetry=true → ENABLED, no reason', () => {
		expect(deriveRetryGate({ status: 'pending', canRetry: true })).toEqual({
			enabled: true,
			reason: null,
		})
	})
	test('[G4] pending + canRetry=false → disabled, role-required reason', () => {
		expect(deriveRetryGate({ status: 'pending', canRetry: false })).toEqual({
			enabled: false,
			reason: 'Повторная отправка: требуется роль Менеджер или Владелец',
		})
	})
	test('[G5] failed + canRetry=true → ENABLED, no reason', () => {
		expect(deriveRetryGate({ status: 'failed', canRetry: true })).toEqual({
			enabled: true,
			reason: null,
		})
	})
	test('[G6] failed + canRetry=false → disabled, role-required reason', () => {
		expect(deriveRetryGate({ status: 'failed', canRetry: false })).toEqual({
			enabled: false,
			reason: 'Повторная отправка: требуется роль Менеджер или Владелец',
		})
	})
})

describe('deriveRetryGate — defensive unknown status', () => {
	test('[GU1] unknown status + canRetry=true → ENABLED (do not silently block)', () => {
		expect(deriveRetryGate({ status: 'UNKNOWN_FROM_BACKEND', canRetry: true })).toEqual({
			enabled: true,
			reason: null,
		})
	})
	test('[GU2] unknown status + canRetry=false → disabled, role reason', () => {
		expect(deriveRetryGate({ status: 'UNKNOWN', canRetry: false })).toEqual({
			enabled: false,
			reason: 'Повторная отправка: требуется роль Менеджер или Владелец',
		})
	})
})

describe('attemptBadgeConf — exact match all 3 kinds', () => {
	test('[BB1] sent', () => {
		expect(attemptBadgeConf('sent')).toEqual({ label: 'Отправлено', variant: 'secondary' })
	})
	test('[BB2] transient_failure', () => {
		expect(attemptBadgeConf('transient_failure')).toEqual({
			label: 'Временная ошибка',
			variant: 'outline',
		})
	})
	test('[BB3] permanent_failure', () => {
		expect(attemptBadgeConf('permanent_failure')).toEqual({
			label: 'Постоянная ошибка',
			variant: 'destructive',
		})
	})
})

describe('retry-gate — immutability', () => {
	test('[I1] mutating RetryGate.reason does NOT poison subsequent calls', () => {
		const g1 = deriveRetryGate({ status: 'sent', canRetry: true })
		g1.reason = 'MUTATED'
		const g2 = deriveRetryGate({ status: 'sent', canRetry: true })
		expect(g2.reason).toBe('Уведомление уже отправлено — повторить нельзя')
	})
	test('[I2] mutating AttemptBadgeConf.label does NOT poison subsequent calls', () => {
		const a = attemptBadgeConf('sent')
		a.label = 'MUTATED'
		expect(attemptBadgeConf('sent').label).toBe('Отправлено')
	})
})
