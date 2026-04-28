/**
 * statusBadgeFor — strict tests с FULL enum coverage.
 *
 * Pre-done audit: per `feedback_pre_done_audit.md` — все 14 EPGU_STATUS_CODES
 * value mapped + verified.
 *
 * Test matrix:
 *   [E1-E14] Every EPGU_STATUS_CODES value → correct badge severity
 *   [E15] Unknown statusCode → fallback 'pending' severity, label "Status N"
 *   [C1] CHANNEL_LABEL_RU contains 3 valid channels
 */
import { EPGU_STATUS_CODES } from '@horeca/shared'
import { describe, expect, test } from 'vitest'
import { CHANNEL_LABEL_RU, statusBadgeFor } from './migration-status-labels.ts'

describe('statusBadgeFor — FULL enum coverage (all 14 EPGU codes)', () => {
	test('[E1] draft (0) → severity pending', () => {
		const b = statusBadgeFor(EPGU_STATUS_CODES.draft)
		expect(b.severity).toBe('pending')
		expect(b.variant).toBe('outline')
		expect(b.label).toBeTruthy()
	})

	test('[E2] registered (1) → severity in_flight', () => {
		expect(statusBadgeFor(EPGU_STATUS_CODES.registered).severity).toBe('in_flight')
	})

	test('[E3] sent_to_authority (2) → severity in_flight', () => {
		expect(statusBadgeFor(EPGU_STATUS_CODES.sent_to_authority).severity).toBe('in_flight')
	})

	test('[E4] executed (3) → severity success + variant default', () => {
		const b = statusBadgeFor(EPGU_STATUS_CODES.executed)
		expect(b.severity).toBe('success')
		expect(b.variant).toBe('default')
	})

	test('[E5] refused (4) → severity refused + variant destructive', () => {
		const b = statusBadgeFor(EPGU_STATUS_CODES.refused)
		expect(b.severity).toBe('refused')
		expect(b.variant).toBe('destructive')
	})

	test('[E6] send_error (5) → severity error + variant destructive', () => {
		const b = statusBadgeFor(EPGU_STATUS_CODES.send_error)
		expect(b.severity).toBe('error')
		expect(b.variant).toBe('destructive')
	})

	test('[E7] cancellation_pending (9) → severity in_flight', () => {
		expect(statusBadgeFor(EPGU_STATUS_CODES.cancellation_pending).severity).toBe('in_flight')
	})

	test('[E8] cancelled (10) → severity cancelled + variant outline (FINAL)', () => {
		const b = statusBadgeFor(EPGU_STATUS_CODES.cancelled)
		expect(b.severity).toBe('cancelled')
		expect(b.variant).toBe('outline')
	})

	test('[E9] awaiting_info (14) → severity in_flight', () => {
		expect(statusBadgeFor(EPGU_STATUS_CODES.awaiting_info).severity).toBe('in_flight')
	})

	test('[E10] requires_correction (15) → severity error', () => {
		expect(statusBadgeFor(EPGU_STATUS_CODES.requires_correction).severity).toBe('error')
	})

	test('[E11] submitted (17) → severity in_flight + variant secondary', () => {
		const b = statusBadgeFor(EPGU_STATUS_CODES.submitted)
		expect(b.severity).toBe('in_flight')
		expect(b.variant).toBe('secondary')
	})

	test('[E12] acknowledged (21) → severity in_flight', () => {
		expect(statusBadgeFor(EPGU_STATUS_CODES.acknowledged).severity).toBe('in_flight')
	})

	test('[E13] delivery_error (22) → severity error', () => {
		expect(statusBadgeFor(EPGU_STATUS_CODES.delivery_error).severity).toBe('error')
	})

	test('[E14] processing_error (24) → severity error', () => {
		expect(statusBadgeFor(EPGU_STATUS_CODES.processing_error).severity).toBe('error')
	})

	test('[E15] unknown statusCode → fallback severity pending + label "Status N"', () => {
		const b = statusBadgeFor(999)
		expect(b.severity).toBe('pending')
		expect(b.variant).toBe('outline')
		expect(b.label).toContain('999')
	})
})

describe('CHANNEL_LABEL_RU', () => {
	test('[C1] all 3 valid channels mapped to Russian labels', () => {
		expect(CHANNEL_LABEL_RU['gost-tls']).toBe('ГОСТ TLS')
		expect(CHANNEL_LABEL_RU.svoks).toBe('СВОКС')
		expect(CHANNEL_LABEL_RU['proxy-via-partner']).toBe('Партнёр')
	})
})
