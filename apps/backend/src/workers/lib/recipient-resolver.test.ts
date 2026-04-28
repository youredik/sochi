/**
 * Recipient resolver — integration tests against real YDB.
 *
 * **Pre-done audit checklist (`feedback_pre_done_audit.md`):**
 *
 *   Resolution chains:
 *     [B1] booking source + valid guest+email → 'resolved' with guest email
 *     [B2] booking missing → 'not_found'
 *     [B3] guest missing → 'not_found'
 *     [B4] guest.email NULL → 'no_email'
 *     [B5] guest.email empty string → 'no_email'
 *
 *   Payment chain:
 *     [P1] payment → booking → guest → email returns resolved
 *     [P2] payment missing → 'not_found'
 *
 *   Receipt chain:
 *     [R1] receipt → payment → booking → guest → email resolves
 *     [R2] receipt missing → 'not_found'
 *
 *   Cross-tenant isolation:
 *     [CT1] tenantA's bookingId NEVER resolves under tenantB filter
 */
import { newId } from '@horeca/shared'
import { afterAll, beforeAll, describe, expect, test } from 'vitest'
import {
	dateFromIso,
	dateOpt,
	NULL_FLOAT,
	NULL_INT64,
	NULL_TEXT,
	NULL_TIMESTAMP,
	textOpt,
	timestampOpt,
	toJson,
	toTs,
} from '../../db/ydb-helpers.ts'
import { getTestSql, setupTestDb, teardownTestDb } from '../../tests/db-setup.ts'
import { resolveRecipientEmail } from './recipient-resolver.ts'

beforeAll(async () => {
	await setupTestDb()
})
afterAll(async () => {
	await teardownTestDb()
})

interface SeedFullChainOpts {
	tenantId: string
	guestEmail?: string | null // null → set NULL_TEXT, '' → empty string
	skipBooking?: boolean
	skipGuest?: boolean
}

async function seedBookingPaymentReceipt(opts: SeedFullChainOpts): Promise<{
	guestId: string
	bookingId: string
	paymentId: string
	receiptId: string
}> {
	const sql = getTestSql()
	const { tenantId } = opts
	const propertyId = newId('property')
	const guestId = newId('guest')
	const bookingId = newId('booking')
	const paymentId = newId('payment')
	const receiptId = newId('receipt')
	const now = new Date()
	const nowTs = toTs(now)

	if (!opts.skipGuest) {
		const emailRaw = opts.guestEmail === undefined ? 'guest@test.local' : opts.guestEmail
		const emailValue = textOpt(emailRaw)
		await sql`
			UPSERT INTO guest (
				\`tenantId\`, \`id\`, \`lastName\`, \`firstName\`, \`middleName\`,
				\`birthDate\`, \`citizenship\`, \`documentType\`, \`documentSeries\`, \`documentNumber\`,
				\`documentIssuedBy\`, \`documentIssuedDate\`, \`registrationAddress\`,
				\`phone\`, \`email\`, \`notes\`,
				\`createdAt\`, \`updatedAt\`
			) VALUES (
				${tenantId}, ${guestId}, ${'Тестов'}, ${'Иван'}, ${NULL_TEXT},
				${dateOpt(null)}, ${'RU'}, ${'passport'}, ${NULL_TEXT}, ${'1234567'},
				${NULL_TEXT}, ${dateOpt(null)}, ${NULL_TEXT},
				${NULL_TEXT}, ${emailValue}, ${NULL_TEXT},
				${nowTs}, ${nowTs}
			)
		`
	}

	if (!opts.skipBooking) {
		await sql`
			UPSERT INTO booking (
				\`tenantId\`, \`propertyId\`, \`checkIn\`, \`id\`,
				\`checkOut\`, \`roomTypeId\`, \`ratePlanId\`, \`assignedRoomId\`,
				\`guestsCount\`, \`nightsCount\`, \`primaryGuestId\`, \`guestSnapshot\`,
				\`status\`, \`confirmedAt\`, \`checkedInAt\`, \`checkedOutAt\`, \`cancelledAt\`, \`noShowAt\`, \`cancelReason\`,
				\`channelCode\`, \`externalId\`, \`externalReferences\`,
				\`totalMicros\`, \`paidMicros\`, \`currency\`, \`timeSlices\`,
				\`cancellationFee\`, \`noShowFee\`,
				\`registrationStatus\`, \`registrationMvdId\`, \`registrationSubmittedAt\`,
				\`rklCheckResult\`, \`rklCheckedAt\`,
				\`tourismTaxBaseMicros\`, \`tourismTaxMicros\`,
				\`notes\`,
				\`createdAt\`, \`updatedAt\`, \`createdBy\`, \`updatedBy\`
			) VALUES (
				${tenantId}, ${propertyId}, ${dateFromIso('2026-04-25')}, ${bookingId},
				${dateFromIso('2026-04-26')}, ${newId('roomType')}, ${newId('ratePlan')}, ${NULL_TEXT},
				${1}, ${1}, ${guestId},
				${toJson({ firstName: 'Иван', lastName: 'Тестов', citizenship: 'RU', documentType: 'passport', documentNumber: '1234567' })},
				${'confirmed'}, ${nowTs}, ${NULL_TIMESTAMP}, ${NULL_TIMESTAMP}, ${NULL_TIMESTAMP}, ${NULL_TIMESTAMP}, ${NULL_TEXT},
				${'walkIn'}, ${NULL_TEXT}, ${toJson(null)},
				${5_000_000_000n}, ${0n}, ${'RUB'},
				${toJson([{ date: '2026-04-25', grossMicros: '5000000000', ratePlanId: 'rp', ratePlanVersion: 'v1', currency: 'RUB' }])},
				${toJson(null)}, ${toJson(null)},
				${'pending'}, ${NULL_TEXT}, ${NULL_TIMESTAMP},
				${'pending'}, ${NULL_TIMESTAMP},
				${0n}, ${0n},
				${NULL_TEXT},
				${nowTs}, ${nowTs}, ${'test-actor'}, ${'test-actor'}
			)
		`

		// Payment row.
		await sql`
			UPSERT INTO payment (
				\`tenantId\`, \`propertyId\`, \`bookingId\`, \`id\`,
				\`folioId\`, \`providerCode\`, \`providerPaymentId\`, \`confirmationUrl\`,
				\`method\`, \`status\`,
				\`amountMinor\`, \`authorizedMinor\`, \`capturedMinor\`, \`currency\`,
				\`idempotencyKey\`, \`version\`,
				\`payerInn\`, \`saleChannel\`, \`anomalyScore\`,
				\`holdExpiresAt\`,
				\`createdAt\`, \`updatedAt\`,
				\`authorizedAt\`, \`capturedAt\`, \`refundedAt\`,
				\`canceledAt\`, \`failedAt\`, \`expiredAt\`,
				\`failureReason\`, \`createdBy\`, \`updatedBy\`
			) VALUES (
				${tenantId}, ${propertyId}, ${bookingId}, ${paymentId},
				${NULL_TEXT}, ${'stub'}, ${NULL_TEXT}, ${NULL_TEXT},
				${'cash'}, ${'succeeded'},
				${500_000n}, ${500_000n}, ${500_000n}, ${'RUB'},
				${`idem_${paymentId}`}, ${1},
				${NULL_TEXT}, ${'direct'}, ${NULL_FLOAT},
				${NULL_TIMESTAMP},
				${nowTs}, ${nowTs},
				${timestampOpt(now)}, ${timestampOpt(now)}, ${NULL_TIMESTAMP},
				${NULL_TIMESTAMP}, ${NULL_TIMESTAMP}, ${NULL_TIMESTAMP},
				${NULL_TEXT}, ${'test-actor'}, ${'test-actor'}
			)
		`

		// Receipt row.
		await sql`
			UPSERT INTO receipt (
				\`tenantId\`, \`paymentId\`, \`id\`, \`refundId\`, \`kind\`, \`correctsReceiptId\`,
				\`status\`, \`provider\`,
				\`tag1054\`, \`tag1212\`, \`tag1214\`, \`tag1199\`, \`tag1008\`,
				\`linesJson\`, \`totalMinor\`, \`currency\`,
				\`fnsRegId\`, \`fdNumber\`, \`fp\`, \`qrPayload\`,
				\`idempotencyKey\`, \`version\`,
				\`createdAt\`, \`updatedAt\`,
				\`sentAt\`, \`confirmedAt\`, \`failedAt\`, \`correctedAt\`,
				\`failureReason\`, \`createdBy\`, \`updatedBy\`
			) VALUES (
				${tenantId}, ${paymentId}, ${receiptId}, ${NULL_TEXT}, ${'final'}, ${NULL_TEXT},
				${'confirmed'}, ${'stub'},
				${1}, ${4}, ${4}, ${5}, ${'guest@test.local'},
				${toJson([])}, ${500_000n}, ${'RUB'},
				${NULL_TEXT}, ${NULL_INT64}, ${NULL_TEXT}, ${NULL_TEXT},
				${`idem_${receiptId}`}, ${1},
				${nowTs}, ${nowTs},
				${NULL_TIMESTAMP}, ${timestampOpt(now)}, ${NULL_TIMESTAMP}, ${NULL_TIMESTAMP},
				${NULL_TEXT}, ${'test-actor'}, ${'test-actor'}
			)
		`
	}

	return { guestId, bookingId, paymentId, receiptId }
}

/* ============================================================ booking source */

describe('resolveRecipientEmail — booking source', { tags: ['db'] }, () => {
	test('[B1] valid chain → resolved with guest email', async () => {
		const tenantId = newId('organization')
		const { bookingId } = await seedBookingPaymentReceipt({ tenantId, guestEmail: 'ivan@test.ru' })

		const result = await resolveRecipientEmail(getTestSql(), 'booking', tenantId, bookingId)
		expect(result).toEqual({ kind: 'resolved', email: 'ivan@test.ru' })
	})

	test('[B2] booking missing → not_found', async () => {
		const tenantId = newId('organization')
		const result = await resolveRecipientEmail(
			getTestSql(),
			'booking',
			tenantId,
			'book_nonexistent',
		)
		expect(result.kind).toBe('not_found')
	})

	test('[B4] guest.email NULL → no_email', async () => {
		const tenantId = newId('organization')
		const { bookingId } = await seedBookingPaymentReceipt({ tenantId, guestEmail: null })

		const result = await resolveRecipientEmail(getTestSql(), 'booking', tenantId, bookingId)
		expect(result.kind).toBe('no_email')
	})

	test('[B5] guest.email empty string → no_email', async () => {
		const tenantId = newId('organization')
		const { bookingId } = await seedBookingPaymentReceipt({ tenantId, guestEmail: '' })

		const result = await resolveRecipientEmail(getTestSql(), 'booking', tenantId, bookingId)
		expect(result.kind).toBe('no_email')
	})
})

/* ============================================================ payment source */

describe('resolveRecipientEmail — payment source', { tags: ['db'] }, () => {
	test('[P1] payment → booking → guest → email', async () => {
		const tenantId = newId('organization')
		const { paymentId } = await seedBookingPaymentReceipt({
			tenantId,
			guestEmail: 'pay@test.ru',
		})

		const result = await resolveRecipientEmail(getTestSql(), 'payment', tenantId, paymentId)
		expect(result).toEqual({ kind: 'resolved', email: 'pay@test.ru' })
	})

	test('[P2] payment missing → not_found', async () => {
		const tenantId = newId('organization')
		const result = await resolveRecipientEmail(getTestSql(), 'payment', tenantId, 'pmt_nonexistent')
		expect(result.kind).toBe('not_found')
	})
})

/* ============================================================ receipt source */

describe('resolveRecipientEmail — receipt source', { tags: ['db'] }, () => {
	test('[R1] receipt → payment → booking → guest → email', async () => {
		const tenantId = newId('organization')
		const { receiptId } = await seedBookingPaymentReceipt({
			tenantId,
			guestEmail: 'receipt@test.ru',
		})

		const result = await resolveRecipientEmail(getTestSql(), 'receipt', tenantId, receiptId)
		expect(result).toEqual({ kind: 'resolved', email: 'receipt@test.ru' })
	})

	test('[R2] receipt missing → not_found', async () => {
		const tenantId = newId('organization')
		const result = await resolveRecipientEmail(getTestSql(), 'receipt', tenantId, 'rcp_nonexistent')
		expect(result.kind).toBe('not_found')
	})
})

/* ============================================================ cross-tenant isolation */

describe('resolveRecipientEmail — cross-tenant', { tags: ['db'] }, () => {
	test('[CT1] tenantB query on tenantA bookingId → not_found', async () => {
		const tenantA = newId('organization')
		const tenantB = newId('organization')
		const { bookingId } = await seedBookingPaymentReceipt({
			tenantId: tenantA,
			guestEmail: 'a@test.ru',
		})

		// tenantA query → resolved.
		const resultA = await resolveRecipientEmail(getTestSql(), 'booking', tenantA, bookingId)
		expect(resultA.kind).toBe('resolved')

		// tenantB query on the SAME bookingId → not_found.
		const resultB = await resolveRecipientEmail(getTestSql(), 'booking', tenantB, bookingId)
		expect(resultB.kind).toBe('not_found')
	})
})
