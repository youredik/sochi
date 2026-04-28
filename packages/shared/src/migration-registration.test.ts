/**
 * migration-registration.ts — strict tests per `feedback_strict_tests.md`.
 *
 * Test matrix:
 *   ─── Enum coverage (drift surface) ──────────────────────────────
 *     [E1] identityMethod has exactly 5 values (ПП-174)
 *     [E2] epguErrorCategory has exactly 8 values
 *     [E3] EPGU_STATUS_LABELS_RU has key for every observed code
 *     [E4] EPGU_FINAL_STATUS_CODES = {3, 4, 10}
 *
 *   ─── isEpguFinalStatus ──────────────────────────────────────────
 *     [F1] 3 → true, 4 → true, 10 → true
 *     [F2] 0/1/2/17/21 → false
 *
 *   ─── computeNextPollAtMs (canonical cadence) ────────────────────
 *     [P1] retryCount=0 → +1 min
 *     [P2] retryCount=9 → +1 min (still in initial 10-min window)
 *     [P3] retryCount=10 → +5 min (transition to 5-min cadence)
 *     [P4] retryCount=19 → +5 min
 *     [P5] retryCount=20 → +10 min (exp start)
 *     [P6] retryCount=21 → +20 min
 *     [P7] retryCount=22 → +40 min
 *     [P8] retryCount=30 → cap 24 hours (exp would be huge)
 *
 *   ─── checkStayPeriodInvariant ────────────────────────────────────
 *     [S1] 90 days exactly → null (no error, at boundary)
 *     [S2] 91 days → error string mentions 90
 *     [S3] departure < arrival → error
 *     [S4] invalid date format → error
 *     [S5] custom maxDays=180 (visa) — accepts 180 day stay
 *
 *   ─── Schema validation ───────────────────────────────────────────
 *     [V1] migrationRegistrationPatch empty → invalid
 *     [V2] migrationRegistrationPatch retryRequested=true → valid
 *     [V3] epguChannel valid set + invalid rejected
 */
import { describe, expect, test } from 'vitest'
import {
	checkStayPeriodInvariant,
	computeNextPollAtMs,
	EPGU_FINAL_STATUS_CODES,
	EPGU_STATUS_CODES,
	EPGU_STATUS_LABELS_RU,
	epguChannelSchema,
	epguErrorCategoryValues,
	identityMethodValues,
	isEpguFinalStatus,
	migrationRegistrationPatchSchema,
} from './migration-registration.ts'

describe('migration-registration — enums', () => {
	test('[E1] identityMethod has exactly 5 values (ПП-174)', () => {
		expect(identityMethodValues).toHaveLength(5)
		expect([...identityMethodValues].sort()).toEqual(
			['passport_paper', 'passport_zagran', 'driver_license', 'ebs', 'digital_id_max'].sort(),
		)
	})

	test('[E2] epguErrorCategory has exactly 8 values', () => {
		expect(epguErrorCategoryValues).toHaveLength(8)
	})

	test('[E3] EPGU_STATUS_LABELS_RU covers all observed codes', () => {
		const observedCodes = [0, 1, 2, 3, 4, 5, 9, 10, 14, 15, 17, 21, 22, 24]
		for (const code of observedCodes) {
			expect(EPGU_STATUS_LABELS_RU[code]).toBeDefined()
			expect(EPGU_STATUS_LABELS_RU[code]?.length).toBeGreaterThan(0)
		}
	})

	test('[E4] EPGU_FINAL_STATUS_CODES = {3, 4, 10}', () => {
		expect(EPGU_FINAL_STATUS_CODES.size).toBe(3)
		expect(EPGU_FINAL_STATUS_CODES.has(3)).toBe(true)
		expect(EPGU_FINAL_STATUS_CODES.has(4)).toBe(true)
		expect(EPGU_FINAL_STATUS_CODES.has(10)).toBe(true)
	})
})

describe('migration-registration — isEpguFinalStatus', () => {
	test('[F1] terminal statuses', () => {
		expect(isEpguFinalStatus(EPGU_STATUS_CODES.executed)).toBe(true)
		expect(isEpguFinalStatus(EPGU_STATUS_CODES.refused)).toBe(true)
		expect(isEpguFinalStatus(EPGU_STATUS_CODES.cancelled)).toBe(true)
	})

	test('[F2] in-progress statuses', () => {
		expect(isEpguFinalStatus(EPGU_STATUS_CODES.draft)).toBe(false)
		expect(isEpguFinalStatus(EPGU_STATUS_CODES.registered)).toBe(false)
		expect(isEpguFinalStatus(EPGU_STATUS_CODES.sent_to_authority)).toBe(false)
		expect(isEpguFinalStatus(EPGU_STATUS_CODES.submitted)).toBe(false)
		expect(isEpguFinalStatus(EPGU_STATUS_CODES.acknowledged)).toBe(false)
	})
})

describe('migration-registration — computeNextPollAtMs', () => {
	const t0 = 1_000_000_000_000

	test('[P1] retryCount=0 → +1 min', () => {
		expect(computeNextPollAtMs(t0, 0)).toBe(t0 + 60_000)
	})

	test('[P2] retryCount=9 → +1 min (still в initial window)', () => {
		expect(computeNextPollAtMs(t0, 9)).toBe(t0 + 60_000)
	})

	test('[P3] retryCount=10 → +5 min (transition)', () => {
		expect(computeNextPollAtMs(t0, 10)).toBe(t0 + 5 * 60_000)
	})

	test('[P4] retryCount=19 → +5 min', () => {
		expect(computeNextPollAtMs(t0, 19)).toBe(t0 + 5 * 60_000)
	})

	test('[P5] retryCount=20 → +10 min (exp start: 10 × 2^0)', () => {
		expect(computeNextPollAtMs(t0, 20)).toBe(t0 + 10 * 60_000)
	})

	test('[P6] retryCount=21 → +20 min (10 × 2^1)', () => {
		expect(computeNextPollAtMs(t0, 21)).toBe(t0 + 20 * 60_000)
	})

	test('[P7] retryCount=22 → +40 min', () => {
		expect(computeNextPollAtMs(t0, 22)).toBe(t0 + 40 * 60_000)
	})

	test('[P8] retryCount=30 → cap 24h', () => {
		expect(computeNextPollAtMs(t0, 30)).toBe(t0 + 24 * 60 * 60_000)
	})

	test('[P9] retryCount=100 → still cap 24h (no overflow)', () => {
		expect(computeNextPollAtMs(t0, 100)).toBe(t0 + 24 * 60 * 60_000)
	})
})

describe('migration-registration — checkStayPeriodInvariant', () => {
	test('[S1] exactly 90 days (boundary, безвиз) → null', () => {
		// 2026-04-01 + 90 days = 2026-06-30
		expect(checkStayPeriodInvariant('2026-04-01', '2026-06-30')).toBeNull()
	})

	test('[S2] 91 days → error mentions 90', () => {
		const err = checkStayPeriodInvariant('2026-04-01', '2026-07-01')
		expect(err).not.toBeNull()
		expect(err).toMatch(/90 дней/)
	})

	test('[S3] departure < arrival → error', () => {
		const err = checkStayPeriodInvariant('2026-04-10', '2026-04-01')
		expect(err).not.toBeNull()
		expect(err).toMatch(/раньше/)
	})

	test('[S4] invalid format → error', () => {
		const err = checkStayPeriodInvariant('not-a-date', '2026-04-01')
		expect(err).not.toBeNull()
	})

	test('[S5] visa-extended 180 days → custom limit accepts', () => {
		// 2026-01-01 + 180 days = 2026-06-30
		expect(checkStayPeriodInvariant('2026-01-01', '2026-06-30', 180)).toBeNull()
	})

	test('[S6] visa 181 days → error', () => {
		const err = checkStayPeriodInvariant('2026-01-01', '2026-07-01', 180)
		expect(err).not.toBeNull()
		expect(err).toMatch(/180/)
	})
})

describe('migration-registration — schema validation', () => {
	test('[V1] empty patch → invalid', () => {
		const result = migrationRegistrationPatchSchema.safeParse({})
		expect(result.success).toBe(false)
	})

	test('[V2] patch with retryRequested=true → valid', () => {
		const result = migrationRegistrationPatchSchema.safeParse({ retryRequested: true })
		expect(result.success).toBe(true)
	})

	test('[V3] epguChannel valid + invalid', () => {
		expect(epguChannelSchema.safeParse('gost-tls').success).toBe(true)
		expect(epguChannelSchema.safeParse('svoks').success).toBe(true)
		expect(epguChannelSchema.safeParse('proxy-via-partner').success).toBe(true)
		expect(epguChannelSchema.safeParse('unknown-channel').success).toBe(false)
	})
})
