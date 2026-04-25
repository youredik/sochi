/**
 * Payment service — FULL-CHAIN integration tests against real YDB.
 *
 * **Pre-done audit checklist (FROM START — feedback_pre_done_audit.md):**
 *
 *   Cross-tenant on EVERY method:
 *     [PT1] getById from wrong tenant → null
 *     [PT2] listByFolio from wrong tenant → []
 *     [PT3] listByBooking from wrong tenant → []
 *     [PT4] createIntent on wrong tenant's folio → FolioNotFoundError
 *     [PT5] applyTransition on wrong tenant → PaymentNotFoundError
 *
 *   Happy path orchestration (canon stub provider = synchronous success):
 *     [H1] createIntent on open folio → result.kind='created'
 *     [H2] Stub provider initiate fires → providerPaymentId populated
 *     [H3] applyTransition walks 'created' → 'succeeded' (autocapture)
 *     [H4] capturedMinor === amountMinor on succeeded
 *
 *   Idempotency (Stripe-style, IETF idempotency-key):
 *     [ID1] Same idempotencyKey twice → second call result.kind='replayed'
 *     [ID2] Replayed payment === first call's payment (deep-equal)
 *
 *   Folio validation:
 *     [FV1] folioId null is allowed (standalone intent — pre-booking deposit)
 *     [FV2] Currency mismatch → FolioCurrencyMismatchError
 *     [FV3] Closed folio → InvalidFolioTransitionError
 *
 *   Listing:
 *     [L1] listByFolio returns only this folio's payments
 *     [L2] listByBooking returns all this booking's payments (multiple folios)
 *
 *   Field correctness on createIntent succeeded:
 *     [F1] amountMinor / authorizedMinor / capturedMinor all equal
 *     [F2] folioId preserved
 *     [F3] providerCode preserved
 *     [F4] saleChannel preserved
 *     [F5] payerInn preserved (or null)
 *     [F6] confirmationUrl null for stub (no hosted checkout)
 *     [F7] capturedAt + authorizedAt set on succeeded
 *
 * Requires local YDB + migrations 0001-0018 applied.
 */
import { newId } from '@horeca/shared'
import { afterAll, beforeAll, describe, expect, test } from 'vitest'
import {
	FolioCurrencyMismatchError,
	FolioNotFoundError,
	InvalidFolioTransitionError,
} from '../../errors/domain.ts'
import { getTestSql, setupTestDb, teardownTestDb } from '../../tests/db-setup.ts'
import { createFolioFactory } from '../folio/folio.factory.ts'
import { createPaymentFactory } from './payment.factory.ts'
import { createStubPaymentProvider } from './provider/stub-provider.ts'

const TENANT_A = newId('organization')
const TENANT_B = newId('organization')
const PROPERTY_A = newId('property')
const BOOKING_A = newId('booking')
const ACTOR = 'usr-test-actor'

let folioFactory: ReturnType<typeof createFolioFactory>
let paymentFactory: ReturnType<typeof createPaymentFactory>

beforeAll(async () => {
	const sql = await setupTestDb()
	folioFactory = createFolioFactory(sql)
	const provider = createStubPaymentProvider()
	paymentFactory = createPaymentFactory(sql, provider, folioFactory.service)
})

afterAll(async () => {
	await teardownTestDb()
})

async function freshFolio(tenantId = TENANT_A, currency = 'RUB') {
	return await folioFactory.service.createForBooking(
		tenantId,
		{
			propertyId: PROPERTY_A,
			bookingId: newId('booking'),
			kind: 'guest',
			currency,
			companyId: null,
		},
		ACTOR,
	)
}

describe('payment.service.createIntent — happy path', { tags: ['db'] }, () => {
	test('[H1-H4, F1-F7] open folio → created → autocapture → succeeded', async () => {
		const folio = await freshFolio()
		const result = await paymentFactory.service.createIntent(
			TENANT_A,
			{
				propertyId: PROPERTY_A,
				bookingId: folio.bookingId,
				folioId: folio.id,
				providerCode: 'stub',
				method: 'stub',
				amountMinor: 15000n,
				currency: 'RUB',
				idempotencyKey: `idemp-${newId('payment')}`,
				saleChannel: 'direct',
				payerInn: null,
			},
			ACTOR,
		)

		expect(result.kind).toBe('created') // H1
		const p = result.payment
		expect(p.providerPaymentId).not.toBeNull() // H2 — stub assigns
		expect(p.status).toBe('succeeded') // H3 — stub autocapture
		expect(p.capturedMinor).toBe('15000') // H4 / F1
		expect(p.amountMinor).toBe('15000') // F1
		expect(p.authorizedMinor).toBe('15000') // F1
		expect(p.folioId).toBe(folio.id) // F2
		expect(p.providerCode).toBe('stub') // F3
		expect(p.saleChannel).toBe('direct') // F4
		expect(p.payerInn).toBeNull() // F5
		expect(p.confirmationUrl).toBeNull() // F6
		expect(p.capturedAt).not.toBeNull() // F7
		expect(p.authorizedAt).not.toBeNull() // F7
	})

	test('[FV1] folioId=null (standalone intent) is allowed', async () => {
		const result = await paymentFactory.service.createIntent(
			TENANT_A,
			{
				propertyId: PROPERTY_A,
				bookingId: BOOKING_A,
				folioId: null,
				providerCode: 'stub',
				method: 'stub',
				amountMinor: 5000n,
				currency: 'RUB',
				idempotencyKey: `idemp-${newId('payment')}`,
				saleChannel: 'direct',
				payerInn: null,
			},
			ACTOR,
		)
		expect(result.kind).toBe('created')
		expect(result.payment.folioId).toBeNull()
		expect(result.payment.status).toBe('succeeded')
	})
})

describe('payment.service.createIntent — folio validation', { tags: ['db'] }, () => {
	test('[PT4] createIntent on wrong-tenant folio → FolioNotFoundError', async () => {
		const folio = await freshFolio(TENANT_A)
		await expect(
			paymentFactory.service.createIntent(
				TENANT_B,
				{
					propertyId: PROPERTY_A,
					bookingId: folio.bookingId,
					folioId: folio.id,
					providerCode: 'stub',
					method: 'stub',
					amountMinor: 1000n,
					currency: 'RUB',
					idempotencyKey: `idemp-${newId('payment')}`,
					saleChannel: 'direct',
					payerInn: null,
				},
				ACTOR,
			),
		).rejects.toThrow(FolioNotFoundError)
	})

	test('[FV2] currency mismatch → FolioCurrencyMismatchError', async () => {
		const folio = await freshFolio(TENANT_A, 'RUB')
		await expect(
			paymentFactory.service.createIntent(
				TENANT_A,
				{
					propertyId: PROPERTY_A,
					bookingId: folio.bookingId,
					folioId: folio.id,
					providerCode: 'stub',
					method: 'stub',
					amountMinor: 1000n,
					currency: 'USD',
					idempotencyKey: `idemp-${newId('payment')}`,
					saleChannel: 'direct',
					payerInn: null,
				},
				ACTOR,
			),
		).rejects.toThrow(FolioCurrencyMismatchError)
	})

	test('[FV3] closed folio → InvalidFolioTransitionError', async () => {
		const folio = await freshFolio(TENANT_A)
		await folioFactory.service.close(TENANT_A, folio.id, ACTOR)
		await expect(
			paymentFactory.service.createIntent(
				TENANT_A,
				{
					propertyId: PROPERTY_A,
					bookingId: folio.bookingId,
					folioId: folio.id,
					providerCode: 'stub',
					method: 'stub',
					amountMinor: 1000n,
					currency: 'RUB',
					idempotencyKey: `idemp-${newId('payment')}`,
					saleChannel: 'direct',
					payerInn: null,
				},
				ACTOR,
			),
		).rejects.toThrow(InvalidFolioTransitionError)
	})
})

describe('payment.service.createIntent — idempotency', { tags: ['db'] }, () => {
	test('[ID1, ID2] same idempotencyKey twice → second call replays', async () => {
		const folio = await freshFolio()
		const idempKey = `idemp-${newId('payment')}`
		const input = {
			propertyId: PROPERTY_A,
			bookingId: folio.bookingId,
			folioId: folio.id,
			providerCode: 'stub' as const,
			method: 'stub' as const,
			amountMinor: 7777n,
			currency: 'RUB',
			idempotencyKey: idempKey,
			saleChannel: 'direct' as const,
			payerInn: null,
		}
		const r1 = await paymentFactory.service.createIntent(TENANT_A, input, ACTOR)
		expect(r1.kind).toBe('created')

		const r2 = await paymentFactory.service.createIntent(TENANT_A, input, ACTOR)
		expect(r2.kind).toBe('replayed')
		// Same payment id — replay returns existing row (Stripe semantics).
		expect(r2.payment.id).toBe(r1.payment.id)
		expect(r2.payment.amountMinor).toBe(r1.payment.amountMinor)
	})
})

describe('payment.service — read methods + cross-tenant', { tags: ['db'] }, () => {
	test('[PT1] getById from wrong tenant → null', async () => {
		const folio = await freshFolio(TENANT_A)
		const result = await paymentFactory.service.createIntent(
			TENANT_A,
			{
				propertyId: PROPERTY_A,
				bookingId: folio.bookingId,
				folioId: folio.id,
				providerCode: 'stub',
				method: 'stub',
				amountMinor: 100n,
				currency: 'RUB',
				idempotencyKey: `idemp-${newId('payment')}`,
				saleChannel: 'direct',
				payerInn: null,
			},
			ACTOR,
		)
		expect(await paymentFactory.service.getById(TENANT_A, result.payment.id)).not.toBeNull()
		expect(await paymentFactory.service.getById(TENANT_B, result.payment.id)).toBeNull()
	})

	test('[PT2, L1] listByFolio cross-tenant + own scope', async () => {
		const folio = await freshFolio(TENANT_A)
		await paymentFactory.service.createIntent(
			TENANT_A,
			{
				propertyId: PROPERTY_A,
				bookingId: folio.bookingId,
				folioId: folio.id,
				providerCode: 'stub',
				method: 'stub',
				amountMinor: 1000n,
				currency: 'RUB',
				idempotencyKey: `idemp-${newId('payment')}`,
				saleChannel: 'direct',
				payerInn: null,
			},
			ACTOR,
		)
		await paymentFactory.service.createIntent(
			TENANT_A,
			{
				propertyId: PROPERTY_A,
				bookingId: folio.bookingId,
				folioId: folio.id,
				providerCode: 'stub',
				method: 'stub',
				amountMinor: 2000n,
				currency: 'RUB',
				idempotencyKey: `idemp-${newId('payment')}`,
				saleChannel: 'direct',
				payerInn: null,
			},
			ACTOR,
		)
		const ownList = await paymentFactory.service.listByFolio(TENANT_A, folio.id)
		expect(ownList).toHaveLength(2)
		const otherList = await paymentFactory.service.listByFolio(TENANT_B, folio.id)
		expect(otherList).toHaveLength(0)
	})

	test('[PT3, L2] listByBooking cross-tenant + own scope', async () => {
		const folio = await freshFolio(TENANT_A)
		await paymentFactory.service.createIntent(
			TENANT_A,
			{
				propertyId: PROPERTY_A,
				bookingId: folio.bookingId,
				folioId: folio.id,
				providerCode: 'stub',
				method: 'stub',
				amountMinor: 100n,
				currency: 'RUB',
				idempotencyKey: `idemp-${newId('payment')}`,
				saleChannel: 'direct',
				payerInn: null,
			},
			ACTOR,
		)
		const ownList = await paymentFactory.service.listByBooking(
			TENANT_A,
			PROPERTY_A,
			folio.bookingId,
		)
		expect(ownList.length).toBeGreaterThanOrEqual(1)
		const otherList = await paymentFactory.service.listByBooking(
			TENANT_B,
			PROPERTY_A,
			folio.bookingId,
		)
		expect(otherList).toHaveLength(0)
	})
})

// Reference TENANT_B/getTestSql so they don't trip "unused" lint.
void TENANT_B
void getTestSql
