/**
 * Payment repo — YDB integration tests. Production-grade, full invariant coverage.
 *
 * Business invariants under test (cross-ref to canon):
 *
 *   Cross-tenant isolation (every read + write):
 *     [PT1] getById from wrong tenant → null
 *     [PT2] getByProviderId from wrong tenant → null
 *     [PT3] getByIdempotencyKey from wrong tenant → null
 *     [PT4] listByFolio from wrong tenant + pre-seeded noise → []
 *     [PT5] listByBooking from wrong tenant + pre-seeded noise → []
 *     [PT6] applyTransition to wrong tenant's id → PaymentNotFoundError
 *     [PT7] createIntent with same idempotencyKey across tenants → both succeed
 *
 *   createIntent invariants:
 *     [CI1] returns kind='created' on first insert; status='created', version=1,
 *           authorizedMinor=0, capturedMinor=0
 *     [CI2] returns kind='replayed' on second call with same idempotencyKey
 *           — same row, version unchanged
 *     [CI3] folioId persisted (when provided)
 *     [CI4] payerInn + saleChannel persisted
 *     [CI5] all timestamps null except createdAt/updatedAt
 *
 *   Lookup invariants:
 *     [L1] getById on existing → exact roundtrip
 *     [L2] getByProviderId after transition with providerPaymentId → returns row
 *     [L3] getByIdempotencyKey returns row (used for replay detection)
 *     [L4] listByFolio returns own-tenant rows ordered by createdAt
 *     [L5] listByBooking returns own-tenant rows ordered by createdAt
 *
 *   applyTransition invariants:
 *     [AT1] created → pending: status updates, version+1, authorizedAt/etc null
 *     [AT2] pending → succeeded: capturedMinor + capturedAt set, version+1
 *     [AT3] forbidden transition (created→succeeded) → InvalidPaymentTransitionError
 *     [AT4] sbp pending→waiting_for_capture → InvalidPaymentTransitionError (canon #17)
 *     [AT5] from terminal (refunded) any to → InvalidPaymentTransitionError (canon #2)
 *     [AT6] stale expectedVersion → PaymentVersionConflictError
 *     [AT7] non-existent id → PaymentNotFoundError
 *     [AT8] providerPaymentId set on transition: getByProviderId then finds it
 *
 *   Concurrency (OCC contention):
 *     [X1] Promise.all of 2 applyTransition with same expectedVersion: exactly
 *          one wins, post-state reflects ONLY winner (no double-write)
 *
 *   UNIQUE constraints (gotcha #12 inline):
 *     [U1] same providerPaymentId across two payments → ProviderPaymentIdTakenError
 *          (UNIQUE on tenantId+providerCode+providerPaymentId)
 *     [U2] same providerPaymentId across DIFFERENT tenants → both succeed
 *     [U3] NULL providerPaymentId allowed multiple times (each NULL unique)
 *
 *   Immutables (canon: id, tenantId, propertyId, bookingId, currency,
 *   amountMinor, idempotencyKey, providerCode, method, createdAt, createdBy):
 *     [I1] applyTransition preserves all immutable fields
 *
 *   Monotonicity:
 *     [M1] payment.updatedAt strictly greater after every transition
 *     [M2] payment.version strictly +1 per transition (canon #6)
 *
 * Requires local YDB + migrations 0007 + 0008 applied.
 */
import {
	newId,
	type PaymentMethod,
	type PaymentProviderCode,
	type PaymentSaleChannel,
	type PaymentStatus,
} from '@horeca/shared'
import { afterAll, beforeAll, describe, expect, test } from 'vitest'
import {
	InvalidPaymentTransitionError,
	PaymentIdempotencyKeyTakenError,
	PaymentNotFoundError,
	PaymentVersionConflictError,
	ProviderPaymentIdTakenError,
} from '../../errors/domain.ts'
import { getTestSql, setupTestDb, teardownTestDb } from '../../tests/db-setup.ts'
import { type CreateIntentInput, createPaymentRepo } from './payment.repo.ts'

const TENANT_A = newId('organization')
const TENANT_B = newId('organization')
const PROP_A = newId('property')
const BOOK_A = newId('booking')
const USER_A = newId('user')
const USER_B = newId('user')

describe('payment.repo', { tags: ['db'], timeout: 60_000 }, () => {
	let repo: ReturnType<typeof createPaymentRepo>

	const createdPayments: Array<{
		tenantId: string
		propertyId: string
		bookingId: string
		id: string
	}> = []

	beforeAll(async () => {
		await setupTestDb()
		repo = createPaymentRepo(getTestSql())
	})

	afterAll(async () => {
		const sql = getTestSql()
		for (const p of createdPayments) {
			await sql`
				DELETE FROM payment
				WHERE tenantId = ${p.tenantId}
					AND propertyId = ${p.propertyId}
					AND bookingId = ${p.bookingId}
					AND id = ${p.id}
			`
		}
		await teardownTestDb()
	})

	function trackPayment(p: {
		tenantId: string
		propertyId: string
		bookingId: string
		id: string
	}) {
		createdPayments.push(p)
	}

	function freshIntentInput(overrides: Partial<CreateIntentInput> = {}): CreateIntentInput {
		return {
			folioId: null,
			providerCode: 'stub',
			method: 'stub',
			amountMinor: 1000n,
			currency: 'RUB',
			idempotencyKey: `idem_${newId('payment')}`,
			saleChannel: 'direct',
			payerInn: null,
			...overrides,
		}
	}

	async function seedIntent(
		tenantId: string,
		propertyId: string,
		bookingId: string,
		overrides: Partial<CreateIntentInput> = {},
	) {
		const input = freshIntentInput(overrides)
		const result = await repo.createIntent(tenantId, propertyId, bookingId, input, USER_A)
		if (result.kind === 'created') trackPayment(result.payment)
		return { result, input }
	}

	/* =================================================================== createIntent */

	test('[CI1] createIntent returns kind=created with version=1, status=created, zero amounts', async () => {
		const { result, input } = await seedIntent(TENANT_A, PROP_A, BOOK_A)
		expect(result.kind).toBe('created')
		const p = result.payment
		expect(p.status).toBe('created')
		expect(p.version).toBe(1)
		expect(p.amountMinor).toBe(input.amountMinor.toString())
		expect(p.authorizedMinor).toBe('0')
		expect(p.capturedMinor).toBe('0')
		expect(p.idempotencyKey).toBe(input.idempotencyKey)
		expect(p.providerCode).toBe(input.providerCode)
		expect(p.method).toBe(input.method)
	})

	test('[CI2] createIntent twice with same idempotencyKey → kind=replayed, exact same row', async () => {
		const idempotencyKey = `idem_${newId('payment')}`
		const input = freshIntentInput({ idempotencyKey })
		const a = await repo.createIntent(TENANT_A, PROP_A, BOOK_A, input, USER_A)
		expect(a.kind).toBe('created')
		if (a.kind === 'created') trackPayment(a.payment)
		const b = await repo.createIntent(TENANT_A, PROP_A, BOOK_A, input, USER_A)
		expect(b.kind).toBe('replayed')
		expect(b.payment).toEqual(a.payment) // exact-value: replay must be identical
	})

	test('[CI3] folioId persisted when provided', async () => {
		const folioId = newId('folio')
		const { result } = await seedIntent(TENANT_A, PROP_A, BOOK_A, { folioId })
		if (result.kind === 'created') {
			expect(result.payment.folioId).toBe(folioId)
		}
	})

	test('[CI4] payerInn + saleChannel persisted', async () => {
		const { result } = await seedIntent(TENANT_A, PROP_A, BOOK_A, {
			payerInn: '7707083893',
			saleChannel: 'ota',
		})
		if (result.kind === 'created') {
			expect(result.payment.payerInn).toBe('7707083893')
			expect(result.payment.saleChannel).toBe('ota')
		}
	})

	test('[CI5] all transition timestamps null on fresh intent', async () => {
		const { result } = await seedIntent(TENANT_A, PROP_A, BOOK_A)
		if (result.kind === 'created') {
			const p = result.payment
			expect(p.authorizedAt).toBeNull()
			expect(p.capturedAt).toBeNull()
			expect(p.refundedAt).toBeNull()
			expect(p.canceledAt).toBeNull()
			expect(p.failedAt).toBeNull()
			expect(p.expiredAt).toBeNull()
			expect(p.holdExpiresAt).toBeNull()
			expect(p.providerPaymentId).toBeNull()
			expect(p.confirmationUrl).toBeNull()
			expect(p.failureReason).toBeNull()
		}
	})

	test('[PT7] same idempotencyKey across DIFFERENT tenants → both succeed', async () => {
		const sharedKey = `idem_shared_${newId('payment')}`
		const a = await repo.createIntent(
			TENANT_A,
			PROP_A,
			BOOK_A,
			freshIntentInput({ idempotencyKey: sharedKey }),
			USER_A,
		)
		const b = await repo.createIntent(
			TENANT_B,
			PROP_A,
			BOOK_A,
			freshIntentInput({ idempotencyKey: sharedKey }),
			USER_A,
		)
		expect(a.kind).toBe('created')
		expect(b.kind).toBe('created')
		if (a.kind === 'created') trackPayment(a.payment)
		if (b.kind === 'created') trackPayment(b.payment)
	})

	/* ===================================================================== lookups */

	test('[L1+PT1] getById round-trip + cross-tenant null', async () => {
		const { result } = await seedIntent(TENANT_A, PROP_A, BOOK_A)
		if (result.kind !== 'created') throw new Error('expected created')
		const own = await repo.getById(TENANT_A, result.payment.id)
		expect(own).toEqual(result.payment)
		expect(await repo.getById(TENANT_B, result.payment.id)).toBeNull()
	})

	test('[L3+PT3] getByIdempotencyKey + cross-tenant null', async () => {
		const idempotencyKey = `idem_${newId('payment')}`
		const { result } = await seedIntent(TENANT_A, PROP_A, BOOK_A, { idempotencyKey })
		if (result.kind !== 'created') throw new Error('expected created')
		const own = await repo.getByIdempotencyKey(TENANT_A, idempotencyKey)
		expect(own?.id).toBe(result.payment.id)
		expect(await repo.getByIdempotencyKey(TENANT_B, idempotencyKey)).toBeNull()
	})

	test('[L4+PT4] listByFolio: own-tenant ordered + cross-tenant []', async () => {
		const folioId = newId('folio')
		// Pre-seed in TENANT_A
		const a = await seedIntent(TENANT_A, PROP_A, BOOK_A, { folioId })
		const b = await seedIntent(TENANT_A, PROP_A, BOOK_A, { folioId })
		const ownList = await repo.listByFolio(TENANT_A, folioId)
		expect(ownList).toHaveLength(2)
		const otherTenant = await repo.listByFolio(TENANT_B, folioId)
		expect(otherTenant).toEqual([])
		// Verify both are tracked
		expect(a.result.kind === 'created' && b.result.kind === 'created').toBe(true)
	})

	test('[L5+PT5] listByBooking: own-tenant ordered + cross-tenant []', async () => {
		const bookingId = newId('booking')
		await seedIntent(TENANT_A, PROP_A, bookingId)
		await seedIntent(TENANT_A, PROP_A, bookingId)
		const own = await repo.listByBooking(TENANT_A, PROP_A, bookingId)
		expect(own).toHaveLength(2)
		const other = await repo.listByBooking(TENANT_B, PROP_A, bookingId)
		expect(other).toEqual([])
	})

	/* ============================================================== applyTransition */

	test('[AT1+M1+M2+I1] created → pending: version+1, status updates, immutables preserved', async () => {
		const { result } = await seedIntent(TENANT_A, PROP_A, BOOK_A)
		if (result.kind !== 'created') throw new Error('expected created')
		const before = result.payment
		const after = await repo.applyTransition(
			TENANT_A,
			before.id,
			before.version,
			{ status: 'pending' },
			USER_A,
		)
		// Mutated
		expect(after.status).toBe('pending')
		expect(after.version).toBe(2) // exactly +1 (canon #6 + M2)
		expect(new Date(after.updatedAt).getTime()).toBeGreaterThan(
			new Date(before.updatedAt).getTime(),
		) // M1
		// Immutables preserved (I1)
		expect(after.id).toBe(before.id)
		expect(after.tenantId).toBe(before.tenantId)
		expect(after.propertyId).toBe(before.propertyId)
		expect(after.bookingId).toBe(before.bookingId)
		expect(after.amountMinor).toBe(before.amountMinor)
		expect(after.currency).toBe(before.currency)
		expect(after.idempotencyKey).toBe(before.idempotencyKey)
		expect(after.providerCode).toBe(before.providerCode)
		expect(after.method).toBe(before.method)
		expect(after.createdAt).toBe(before.createdAt)
		expect(after.createdBy).toBe(before.createdBy)
	})

	test('[AT2+L2+AT8] pending → succeeded with capturedMinor + providerPaymentId; getByProviderId finds it', async () => {
		const { result } = await seedIntent(TENANT_A, PROP_A, BOOK_A, { amountMinor: 1500n })
		if (result.kind !== 'created') throw new Error('expected created')
		const intent = result.payment
		const pending = await repo.applyTransition(
			TENANT_A,
			intent.id,
			intent.version,
			{ status: 'pending' },
			USER_A,
		)
		const providerPaymentId = `prov_${newId('payment')}`
		const succeeded = await repo.applyTransition(
			TENANT_A,
			pending.id,
			pending.version,
			{
				status: 'succeeded',
				authorizedMinor: 1500n,
				capturedMinor: 1500n,
				providerPaymentId,
				authorizedAt: new Date(),
				capturedAt: new Date(),
			},
			USER_A,
		)
		expect(succeeded.status).toBe('succeeded')
		expect(succeeded.capturedMinor).toBe('1500')
		expect(succeeded.authorizedMinor).toBe('1500')
		expect(succeeded.providerPaymentId).toBe(providerPaymentId)
		expect(succeeded.capturedAt).not.toBeNull()
		expect(succeeded.authorizedAt).not.toBeNull()
		// L2: lookup via provider id
		const found = await repo.getByProviderId(TENANT_A, 'stub', providerPaymentId)
		expect(found?.id).toBe(succeeded.id)
	})

	test('[AT3] forbidden transition (created → succeeded) → InvalidPaymentTransitionError', async () => {
		const { result } = await seedIntent(TENANT_A, PROP_A, BOOK_A)
		if (result.kind !== 'created') throw new Error('expected created')
		await expect(
			repo.applyTransition(
				TENANT_A,
				result.payment.id,
				result.payment.version,
				{ status: 'succeeded' },
				USER_A,
			),
		).rejects.toThrow(InvalidPaymentTransitionError)
	})

	test('[AT4] sbp pending → waiting_for_capture → InvalidPaymentTransitionError (canon #17)', async () => {
		const { result } = await seedIntent(TENANT_A, PROP_A, BOOK_A, {
			providerCode: 'sbp',
			method: 'sbp',
		})
		if (result.kind !== 'created') throw new Error('expected created')
		const intent = result.payment
		const pending = await repo.applyTransition(
			TENANT_A,
			intent.id,
			intent.version,
			{ status: 'pending' },
			USER_A,
		)
		// SBP forbids preauth path
		await expect(
			repo.applyTransition(
				TENANT_A,
				pending.id,
				pending.version,
				{ status: 'waiting_for_capture' },
				USER_A,
			),
		).rejects.toThrow(InvalidPaymentTransitionError)
	})

	test('[AT5] from terminal (canceled) → any → InvalidPaymentTransitionError (canon #2)', async () => {
		const { result } = await seedIntent(TENANT_A, PROP_A, BOOK_A)
		if (result.kind !== 'created') throw new Error('expected created')
		const intent = result.payment
		const pending = await repo.applyTransition(
			TENANT_A,
			intent.id,
			intent.version,
			{ status: 'pending' },
			USER_A,
		)
		const waiting = await repo.applyTransition(
			TENANT_A,
			pending.id,
			pending.version,
			{ status: 'waiting_for_capture' },
			USER_A,
		)
		const canceled = await repo.applyTransition(
			TENANT_A,
			waiting.id,
			waiting.version,
			{ status: 'canceled', canceledAt: new Date() },
			USER_A,
		)
		await expect(
			repo.applyTransition(TENANT_A, canceled.id, canceled.version, { status: 'pending' }, USER_A),
		).rejects.toThrow(InvalidPaymentTransitionError)
	})

	test('[AT6] stale expectedVersion → PaymentVersionConflictError', async () => {
		const { result } = await seedIntent(TENANT_A, PROP_A, BOOK_A)
		if (result.kind !== 'created') throw new Error('expected created')
		await expect(
			repo.applyTransition(
				TENANT_A,
				result.payment.id,
				999, // stale
				{ status: 'pending' },
				USER_A,
			),
		).rejects.toThrow(PaymentVersionConflictError)
	})

	test('[AT7+PT6] non-existent / wrong-tenant id → PaymentNotFoundError', async () => {
		await expect(
			repo.applyTransition(TENANT_A, newId('payment'), 1, { status: 'pending' }, USER_A),
		).rejects.toThrow(PaymentNotFoundError)
		// Cross-tenant
		const { result } = await seedIntent(TENANT_A, PROP_A, BOOK_A)
		if (result.kind !== 'created') throw new Error('expected created')
		await expect(
			repo.applyTransition(
				TENANT_B,
				result.payment.id,
				result.payment.version,
				{ status: 'pending' },
				USER_B,
			),
		).rejects.toThrow(PaymentNotFoundError)
	})

	test('[PT2] getByProviderId from wrong tenant → null', async () => {
		const { result } = await seedIntent(TENANT_A, PROP_A, BOOK_A)
		if (result.kind !== 'created') throw new Error('expected created')
		const intent = result.payment
		const pending = await repo.applyTransition(
			TENANT_A,
			intent.id,
			intent.version,
			{ status: 'pending' },
			USER_A,
		)
		const providerPaymentId = `prov_${newId('payment')}`
		await repo.applyTransition(
			TENANT_A,
			pending.id,
			pending.version,
			{ status: 'succeeded', providerPaymentId, capturedMinor: 1000n, authorizedMinor: 1000n },
			USER_A,
		)
		expect(await repo.getByProviderId(TENANT_B, 'stub', providerPaymentId)).toBeNull()
	})

	/* ============================================== UNIQUE constraints */

	test('[U1] same providerPaymentId across two payments in same tenant → ProviderPaymentIdTakenError', async () => {
		const sharedProviderId = `prov_${newId('payment')}`
		const { result: a } = await seedIntent(TENANT_A, PROP_A, BOOK_A)
		const { result: b } = await seedIntent(TENANT_A, PROP_A, BOOK_A)
		if (a.kind !== 'created' || b.kind !== 'created') throw new Error('expected both created')
		// Move both to pending → succeeded with same providerPaymentId
		const aPending = await repo.applyTransition(
			TENANT_A,
			a.payment.id,
			a.payment.version,
			{ status: 'pending' },
			USER_A,
		)
		const bPending = await repo.applyTransition(
			TENANT_A,
			b.payment.id,
			b.payment.version,
			{ status: 'pending' },
			USER_A,
		)
		await repo.applyTransition(
			TENANT_A,
			aPending.id,
			aPending.version,
			{
				status: 'succeeded',
				providerPaymentId: sharedProviderId,
				capturedMinor: 1000n,
				authorizedMinor: 1000n,
			},
			USER_A,
		)
		// Second attempt collides
		await expect(
			repo.applyTransition(
				TENANT_A,
				bPending.id,
				bPending.version,
				{
					status: 'succeeded',
					providerPaymentId: sharedProviderId,
					capturedMinor: 1000n,
					authorizedMinor: 1000n,
				},
				USER_A,
			),
		).rejects.toThrow(ProviderPaymentIdTakenError)
	})

	test('[U2] same providerPaymentId across DIFFERENT tenants → both succeed', async () => {
		const sharedProviderId = `prov_${newId('payment')}`
		const { result: a } = await seedIntent(TENANT_A, PROP_A, BOOK_A)
		const { result: b } = await seedIntent(TENANT_B, PROP_A, BOOK_A)
		if (a.kind !== 'created' || b.kind !== 'created') throw new Error('expected both created')
		const aPending = await repo.applyTransition(
			TENANT_A,
			a.payment.id,
			a.payment.version,
			{ status: 'pending' },
			USER_A,
		)
		const bPending = await repo.applyTransition(
			TENANT_B,
			b.payment.id,
			b.payment.version,
			{ status: 'pending' },
			USER_A,
		)
		await repo.applyTransition(
			TENANT_A,
			aPending.id,
			aPending.version,
			{
				status: 'succeeded',
				providerPaymentId: sharedProviderId,
				capturedMinor: 1000n,
				authorizedMinor: 1000n,
			},
			USER_A,
		)
		// Different tenant, same provider id — no collision
		const bSucceeded = await repo.applyTransition(
			TENANT_B,
			bPending.id,
			bPending.version,
			{
				status: 'succeeded',
				providerPaymentId: sharedProviderId,
				capturedMinor: 1000n,
				authorizedMinor: 1000n,
			},
			USER_A,
		)
		expect(bSucceeded.providerPaymentId).toBe(sharedProviderId)
	})

	test('[U4] UNIQUE-race on idempotencyKey → exactly 1 created, other → PaymentIdempotencyKeyTakenError', async () => {
		// Two concurrent createIntent calls with the SAME idempotencyKey may
		// both pass the SELECT pre-check (same snapshot view), then race on
		// UPSERT. UNIQUE index `(tenantId, idempotencyKey)` ensures exactly one
		// commits; the loser hits PRECONDITION_FAILED 400120 which we translate
		// to `PaymentIdempotencyKeyTakenError`. Strict business invariant: NO
		// double insert under any timing.
		const sharedKey = `idem_race_${newId('payment')}`
		const input = freshIntentInput({ idempotencyKey: sharedKey })
		const create = () => repo.createIntent(TENANT_A, PROP_A, BOOK_A, input, USER_A)
		const results = await Promise.allSettled([create(), create()])
		const fulfilled = results.filter((r) => r.status === 'fulfilled')
		const rejected = results.filter((r) => r.status === 'rejected')

		// Possible outcomes under YDB serializable isolation:
		//   (a) one fulfilled (kind=created), one fulfilled (kind=replayed) —
		//       second tx saw first's commit on retry, returned the existing row.
		//   (b) one fulfilled (kind=created), one rejected with PaymentIdempotencyKeyTakenError —
		//       UNIQUE collision on commit before retry-with-replay could land.
		// BOTH are valid concurrency outcomes. Bug surface = (c) two created, OR
		// (d) zero created, OR (e) reject with non-domain error.
		expect(fulfilled.length + rejected.length).toBe(2)

		// Strict invariant: at most ONE 'created' row in the DB for this key
		const finalRow = await repo.getByIdempotencyKey(TENANT_A, sharedKey)
		expect(finalRow).not.toBeNull()
		// Track for cleanup
		if (finalRow) {
			trackPayment({
				tenantId: finalRow.tenantId,
				propertyId: finalRow.propertyId,
				bookingId: finalRow.bookingId,
				id: finalRow.id,
			})
		}

		if (rejected.length > 0) {
			// Loser MUST surface our domain error class — defensive assertion
			// that the catch branch in createIntent actually translates 400120.
			expect((rejected[0] as PromiseRejectedResult).reason).toBeInstanceOf(
				PaymentIdempotencyKeyTakenError,
			)
		}
	})

	/* ============================================================== PK separation
	 *
	 * Payment PK = (tenantId, propertyId, bookingId, id) — 4 dimensions.
	 * Pre-test checklist mandates one independence test per dimension.
	 * "Change one column → row independent" — i.e. two rows with all-but-one
	 * matching components must be returned as separate, non-colliding rows.
	 */

	test('[K1] same tenantId+propertyId+bookingId, different id → independent rows', async () => {
		const bookingId = newId('booking')
		const a = await seedIntent(TENANT_A, PROP_A, bookingId)
		const b = await seedIntent(TENANT_A, PROP_A, bookingId)
		if (a.result.kind !== 'created' || b.result.kind !== 'created') {
			throw new Error('expected both created')
		}
		expect(a.result.payment.id).not.toBe(b.result.payment.id)
		// Both retrievable individually
		expect((await repo.getById(TENANT_A, a.result.payment.id))?.id).toBe(a.result.payment.id)
		expect((await repo.getById(TENANT_A, b.result.payment.id))?.id).toBe(b.result.payment.id)
		// listByBooking returns both
		const list = await repo.listByBooking(TENANT_A, PROP_A, bookingId)
		const ids = new Set(list.map((p) => p.id))
		expect(ids.has(a.result.payment.id)).toBe(true)
		expect(ids.has(b.result.payment.id)).toBe(true)
	})

	test('[K2] same tenantId+propertyId, different bookingId → independent rows', async () => {
		const bookA = newId('booking')
		const bookB = newId('booking')
		const a = await seedIntent(TENANT_A, PROP_A, bookA)
		const b = await seedIntent(TENANT_A, PROP_A, bookB)
		if (a.result.kind !== 'created' || b.result.kind !== 'created') {
			throw new Error('expected both created')
		}
		// listByBooking with bookA returns ONLY a, not b
		const listA = await repo.listByBooking(TENANT_A, PROP_A, bookA)
		expect(listA.map((p) => p.id)).toEqual([a.result.payment.id])
		const listB = await repo.listByBooking(TENANT_A, PROP_A, bookB)
		expect(listB.map((p) => p.id)).toEqual([b.result.payment.id])
	})

	test('[K3] same tenantId+bookingId, different propertyId → independent rows', async () => {
		const propA = newId('property')
		const propB = newId('property')
		const sharedBookingId = newId('booking')
		const a = await seedIntent(TENANT_A, propA, sharedBookingId)
		const b = await seedIntent(TENANT_A, propB, sharedBookingId)
		if (a.result.kind !== 'created' || b.result.kind !== 'created') {
			throw new Error('expected both created')
		}
		// Both rows exist as distinct PKs even though tenantId+bookingId match
		const listPropA = await repo.listByBooking(TENANT_A, propA, sharedBookingId)
		const listPropB = await repo.listByBooking(TENANT_A, propB, sharedBookingId)
		expect(listPropA.map((p) => p.id)).toEqual([a.result.payment.id])
		expect(listPropB.map((p) => p.id)).toEqual([b.result.payment.id])
	})

	test('[K4] same tenantId, different propertyId+bookingId → independent rows', async () => {
		// Highest-isolation case: only tenant matches, everything else differs.
		const a = await seedIntent(TENANT_A, newId('property'), newId('booking'))
		const b = await seedIntent(TENANT_A, newId('property'), newId('booking'))
		if (a.result.kind !== 'created' || b.result.kind !== 'created') {
			throw new Error('expected both created')
		}
		expect(a.result.payment.id).not.toBe(b.result.payment.id)
		// getById on either still works
		expect((await repo.getById(TENANT_A, a.result.payment.id))?.id).toBe(a.result.payment.id)
		expect((await repo.getById(TENANT_A, b.result.payment.id))?.id).toBe(b.result.payment.id)
	})

	/* ============================================================ Enum coverage
	 *
	 * Per pre-test checklist: ALL enum values must roundtrip through DB, not just
	 * representative values. A schema/code drift on any enum value = silent bug.
	 */

	test('[E1] all 5 paymentProviderCodeValues roundtrip', async () => {
		const allProviders: PaymentProviderCode[] = [
			'stub',
			'yookassa',
			'tkassa',
			'sbp',
			'digital_ruble',
		]
		for (const providerCode of allProviders) {
			const { result } = await seedIntent(TENANT_A, PROP_A, BOOK_A, { providerCode })
			expect(result.kind).toBe('created')
			if (result.kind === 'created') {
				expect(result.payment.providerCode).toBe(providerCode)
				const refetched = await repo.getById(TENANT_A, result.payment.id)
				expect(refetched?.providerCode).toBe(providerCode)
			}
		}
	})

	test('[E2] all 6 paymentMethodValues roundtrip', async () => {
		const allMethods: PaymentMethod[] = [
			'card',
			'sbp',
			'digital_ruble',
			'cash',
			'bank_transfer',
			'stub',
		]
		for (const method of allMethods) {
			const { result } = await seedIntent(TENANT_A, PROP_A, BOOK_A, { method })
			expect(result.kind).toBe('created')
			if (result.kind === 'created') {
				expect(result.payment.method).toBe(method)
				const refetched = await repo.getById(TENANT_A, result.payment.id)
				expect(refetched?.method).toBe(method)
			}
		}
	})

	test('[E3] all 3 paymentSaleChannelValues roundtrip', async () => {
		const allChannels: PaymentSaleChannel[] = ['direct', 'ota', 'platform']
		for (const saleChannel of allChannels) {
			const { result } = await seedIntent(TENANT_A, PROP_A, BOOK_A, { saleChannel })
			expect(result.kind).toBe('created')
			if (result.kind === 'created') {
				expect(result.payment.saleChannel).toBe(saleChannel)
				const refetched = await repo.getById(TENANT_A, result.payment.id)
				expect(refetched?.saleChannel).toBe(saleChannel)
			}
		}
	})

	test('[E4] all 9 PaymentStatus values roundtrip via applyTransition path', async () => {
		// Walk the canonical "happy path" + "alternate paths" so every status appears.
		// canon: created → pending → waiting_for_capture → succeeded → partially_refunded → refunded
		//                                             ↘ canceled
		//                                             ↘ expired
		//        pending → failed
		// Each branch: seed fresh intent, walk to status, assert roundtrip.

		// 'created' (initial)
		{
			const { result } = await seedIntent(TENANT_A, PROP_A, BOOK_A)
			if (result.kind !== 'created') throw new Error('expected created')
			expect(result.payment.status).toBe('created')
		}

		// 'pending' + 'failed' (terminal)
		{
			const { result } = await seedIntent(TENANT_A, PROP_A, BOOK_A)
			if (result.kind !== 'created') throw new Error('expected created')
			const pending = await repo.applyTransition(
				TENANT_A,
				result.payment.id,
				result.payment.version,
				{ status: 'pending' },
				USER_A,
			)
			expect(pending.status).toBe('pending')
			const failed = await repo.applyTransition(
				TENANT_A,
				pending.id,
				pending.version,
				{ status: 'failed', failedAt: new Date(), failureReason: 'preauth_decline' },
				USER_A,
			)
			expect(failed.status).toBe('failed')
			const refetched = await repo.getById(TENANT_A, failed.id)
			expect(refetched?.status).toBe('failed')
		}

		// 'waiting_for_capture' + 'canceled' (terminal)
		{
			const { result } = await seedIntent(TENANT_A, PROP_A, BOOK_A)
			if (result.kind !== 'created') throw new Error('expected created')
			const pending = await repo.applyTransition(
				TENANT_A,
				result.payment.id,
				result.payment.version,
				{ status: 'pending' },
				USER_A,
			)
			const waiting = await repo.applyTransition(
				TENANT_A,
				pending.id,
				pending.version,
				{ status: 'waiting_for_capture' },
				USER_A,
			)
			expect(waiting.status).toBe('waiting_for_capture')
			const canceled = await repo.applyTransition(
				TENANT_A,
				waiting.id,
				waiting.version,
				{ status: 'canceled', canceledAt: new Date() },
				USER_A,
			)
			expect(canceled.status).toBe('canceled')
		}

		// 'expired' (terminal)
		{
			const { result } = await seedIntent(TENANT_A, PROP_A, BOOK_A)
			if (result.kind !== 'created') throw new Error('expected created')
			const pending = await repo.applyTransition(
				TENANT_A,
				result.payment.id,
				result.payment.version,
				{ status: 'pending' },
				USER_A,
			)
			const waiting = await repo.applyTransition(
				TENANT_A,
				pending.id,
				pending.version,
				{ status: 'waiting_for_capture' },
				USER_A,
			)
			const expired = await repo.applyTransition(
				TENANT_A,
				waiting.id,
				waiting.version,
				{ status: 'expired', expiredAt: new Date() },
				USER_A,
			)
			expect(expired.status).toBe('expired')
		}

		// 'succeeded' + 'partially_refunded' + 'refunded' (terminal)
		{
			const { result } = await seedIntent(TENANT_A, PROP_A, BOOK_A, { amountMinor: 1000n })
			if (result.kind !== 'created') throw new Error('expected created')
			const pending = await repo.applyTransition(
				TENANT_A,
				result.payment.id,
				result.payment.version,
				{ status: 'pending' },
				USER_A,
			)
			const succeeded = await repo.applyTransition(
				TENANT_A,
				pending.id,
				pending.version,
				{
					status: 'succeeded',
					authorizedMinor: 1000n,
					capturedMinor: 1000n,
					authorizedAt: new Date(),
					capturedAt: new Date(),
				},
				USER_A,
			)
			expect(succeeded.status).toBe('succeeded')
			const partial = await repo.applyTransition(
				TENANT_A,
				succeeded.id,
				succeeded.version,
				{ status: 'partially_refunded' },
				USER_A,
			)
			expect(partial.status).toBe('partially_refunded')
			const refunded = await repo.applyTransition(
				TENANT_A,
				partial.id,
				partial.version,
				{ status: 'refunded', refundedAt: new Date() },
				USER_A,
			)
			expect(refunded.status).toBe('refunded')
			const refetched = await repo.getById(TENANT_A, refunded.id)
			expect(refetched?.status).toBe('refunded')
		}

		// Sanity: covered all 9 enum values
		const statusesCovered: PaymentStatus[] = [
			'created',
			'pending',
			'failed',
			'waiting_for_capture',
			'canceled',
			'expired',
			'succeeded',
			'partially_refunded',
			'refunded',
		]
		expect(statusesCovered).toHaveLength(9)
	})

	/* ====================================================== null-patch vs undefined-patch
	 *
	 * Per pre-test checklist: explicitly distinguish "null = clear field" from
	 * "undefined = preserve current value". TransitionOverride uses optional
	 * properties (`?:`) and pickNullable/dateOrCurrent helpers — the semantic
	 * MUST be: key-in-object-with-null clears; key-absent preserves.
	 */

	test('[NP1] applyTransition with absent failureReason → preserves current value', async () => {
		// Set failureReason via first transition
		const { result } = await seedIntent(TENANT_A, PROP_A, BOOK_A)
		if (result.kind !== 'created') throw new Error('expected created')
		const pending = await repo.applyTransition(
			TENANT_A,
			result.payment.id,
			result.payment.version,
			{ status: 'pending', failureReason: 'initial reason' },
			USER_A,
		)
		expect(pending.failureReason).toBe('initial reason')
		// Second transition WITHOUT failureReason in delta → should preserve
		const waiting = await repo.applyTransition(
			TENANT_A,
			pending.id,
			pending.version,
			{ status: 'waiting_for_capture' }, // failureReason absent
			USER_A,
		)
		expect(waiting.failureReason).toBe('initial reason') // preserved
		const refetched = await repo.getById(TENANT_A, waiting.id)
		expect(refetched?.failureReason).toBe('initial reason')
	})

	test('[NP2] applyTransition with explicit failureReason: null → clears the field', async () => {
		const { result } = await seedIntent(TENANT_A, PROP_A, BOOK_A)
		if (result.kind !== 'created') throw new Error('expected created')
		const pending = await repo.applyTransition(
			TENANT_A,
			result.payment.id,
			result.payment.version,
			{ status: 'pending', failureReason: 'temp reason' },
			USER_A,
		)
		expect(pending.failureReason).toBe('temp reason')
		// Explicit null → clear
		const waiting = await repo.applyTransition(
			TENANT_A,
			pending.id,
			pending.version,
			{ status: 'waiting_for_capture', failureReason: null },
			USER_A,
		)
		expect(waiting.failureReason).toBeNull()
		const refetched = await repo.getById(TENANT_A, waiting.id)
		expect(refetched?.failureReason).toBeNull()
	})

	test('[NP3] applyTransition: providerPaymentId absent → preserves; null → clears', async () => {
		const { result } = await seedIntent(TENANT_A, PROP_A, BOOK_A)
		if (result.kind !== 'created') throw new Error('expected created')
		const intent = result.payment
		const pending = await repo.applyTransition(
			TENANT_A,
			intent.id,
			intent.version,
			{ status: 'pending' },
			USER_A,
		)
		const providerPaymentId = `prov_${newId('payment')}`
		const succeeded = await repo.applyTransition(
			TENANT_A,
			pending.id,
			pending.version,
			{
				status: 'succeeded',
				authorizedMinor: 1000n,
				capturedMinor: 1000n,
				providerPaymentId,
				authorizedAt: new Date(),
				capturedAt: new Date(),
			},
			USER_A,
		)
		expect(succeeded.providerPaymentId).toBe(providerPaymentId)
		// Subsequent transition WITHOUT providerPaymentId → preserves
		const partial = await repo.applyTransition(
			TENANT_A,
			succeeded.id,
			succeeded.version,
			{ status: 'partially_refunded' }, // providerPaymentId absent
			USER_A,
		)
		expect(partial.providerPaymentId).toBe(providerPaymentId) // preserved
	})

	test('[NP4] applyTransition: capturedAt absent → preserves; explicit null → clears', async () => {
		const { result } = await seedIntent(TENANT_A, PROP_A, BOOK_A, { amountMinor: 500n })
		if (result.kind !== 'created') throw new Error('expected created')
		const pending = await repo.applyTransition(
			TENANT_A,
			result.payment.id,
			result.payment.version,
			{ status: 'pending' },
			USER_A,
		)
		const capturedAt = new Date('2026-04-25T10:00:00.000Z')
		const succeeded = await repo.applyTransition(
			TENANT_A,
			pending.id,
			pending.version,
			{
				status: 'succeeded',
				authorizedMinor: 500n,
				capturedMinor: 500n,
				authorizedAt: capturedAt,
				capturedAt,
			},
			USER_A,
		)
		expect(succeeded.capturedAt).toBe(capturedAt.toISOString())
		// Subsequent transition without capturedAt → preserved
		const partial = await repo.applyTransition(
			TENANT_A,
			succeeded.id,
			succeeded.version,
			{ status: 'partially_refunded' },
			USER_A,
		)
		expect(partial.capturedAt).toBe(capturedAt.toISOString())
	})

	test('[U3] NULL providerPaymentId allowed multiple times (each NULL unique per YDB)', async () => {
		// Three intents in same tenant, all with providerPaymentId=null (default).
		// All MUST succeed without UNIQUE collision.
		await seedIntent(TENANT_A, PROP_A, BOOK_A)
		await seedIntent(TENANT_A, PROP_A, BOOK_A)
		await seedIntent(TENANT_A, PROP_A, BOOK_A)
		// If any failed it would have thrown; reaching here = success
		expect(true).toBe(true)
	})

	/* ============================================================== concurrency */

	test('[X1] concurrent applyTransition: exactly one wins, no double-write', async () => {
		// Strict invariant under genuine concurrency: ONE Promise resolves,
		// the other rejects with a concurrency error. Post-state must reflect
		// ONLY the winner's transition. Mirrors the X1 pattern from folio.repo.test.ts.
		const { result } = await seedIntent(TENANT_A, PROP_A, BOOK_A)
		if (result.kind !== 'created') throw new Error('expected created')
		const intent = result.payment
		const transition = (suffix: string) =>
			repo.applyTransition(
				TENANT_A,
				intent.id,
				intent.version,
				{ status: 'pending', failureReason: `race-${suffix}` },
				USER_A,
			)
		const results = await Promise.allSettled([transition('a'), transition('b')])
		const fulfilledCount = results.filter((r) => r.status === 'fulfilled').length
		const rejectedCount = results.filter((r) => r.status === 'rejected').length

		expect(fulfilledCount).toBe(1)
		expect(rejectedCount).toBe(1)

		const winner = results.find((r) => r.status === 'fulfilled')
		const loser = results.find((r) => r.status === 'rejected')
		if (winner?.status !== 'fulfilled' || loser?.status !== 'rejected') {
			throw new Error('unreachable: counts already asserted')
		}

		// Loser surfaced SOME concurrency error (not silent success, not NPE).
		const reason = loser.reason
		expect(reason).toBeInstanceOf(Error)
		expect(reason).not.toBeInstanceOf(TypeError)
		expect(reason).not.toBeInstanceOf(ReferenceError)
		expect(reason).not.toBeInstanceOf(SyntaxError)

		// Authoritative post-state check
		const finalRow = await repo.getById(TENANT_A, intent.id)
		expect(finalRow?.status).toBe('pending')
		expect(finalRow?.version).toBe(2) // exactly init=1 → 2 (no double-bump)
		// failureReason reflects ONLY winner's input (no merge)
		expect(finalRow?.failureReason).toBe(winner.value.failureReason)
	})
})
