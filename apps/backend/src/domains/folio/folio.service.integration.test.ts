/**
 * Folio service — FULL-CHAIN integration tests against real YDB.
 *
 * **Pre-done audit checklist (FROM START — feedback_pre_done_audit.md):**
 *
 *   Cross-tenant on EVERY method (canon mandatory):
 *     [PT1] getById from wrong tenant → null
 *     [PT2] listByBooking from wrong tenant → []
 *     [PT3] listLines from wrong tenant → []
 *     [PT4] postLine on wrong tenant → FolioNotFoundError
 *     [PT5] voidLine on wrong tenant → FolioNotFoundError
 *     [PT6] close on wrong tenant → FolioNotFoundError
 *
 *   Happy path orchestration:
 *     [H1] createForBooking → folio.status='open', balance=0n, version=1
 *     [H2] postLine increments balance + bumps folio.version
 *     [H3] voidLine decrements balance + bumps folio.version
 *     [H4] close transitions open → closed (no draft lines)
 *
 *   Folio kind FULL enum coverage (6 values):
 *     [E1] all FolioKind values roundtrip via createForBooking + getById
 *
 *   Currency mismatch (canon invariant #14):
 *     [CV1] postLine with mismatched expectedFolioCurrency → FolioCurrencyMismatchError
 *
 *   SM gate:
 *     [SM1] close on already-closed folio → InvalidFolioTransitionError
 *     [SM2] postLine on closed folio → InvalidFolioTransitionError
 *
 *   Field correctness:
 *     [F1] line amountMinor preserved
 *     [F2] line category preserved
 *     [F3] line isAccommodationBase preserved
 *     [F4] line taxRateBps preserved
 *
 * Requires local YDB + migrations 0001-0018 applied.
 */
import type { FolioKind } from '@horeca/shared'
import { newId } from '@horeca/shared'
import { afterAll, beforeAll, describe, expect, test } from 'vitest'
import {
	FolioCurrencyMismatchError,
	FolioNotFoundError,
	InvalidFolioTransitionError,
} from '../../errors/domain.ts'
import { setupTestDb, teardownTestDb } from '../../tests/db-setup.ts'
import { createFolioFactory } from './folio.factory.ts'

const TENANT_A = newId('organization')
const TENANT_B = newId('organization')
const PROPERTY_A = newId('property')
const ACTOR = 'usr-test-actor'

let factory: ReturnType<typeof createFolioFactory>

beforeAll(async () => {
	const sql = await setupTestDb()
	factory = createFolioFactory(sql)
})

afterAll(async () => {
	await teardownTestDb()
})

async function freshFolio(tenantId = TENANT_A, kind: FolioKind = 'guest', currency = 'RUB') {
	return await factory.service.createForBooking(
		tenantId,
		{
			propertyId: PROPERTY_A,
			bookingId: newId('booking'),
			kind,
			currency,
			companyId: null,
		},
		ACTOR,
	)
}

describe('folio.service — happy path', { tags: ['db'] }, () => {
	test('[H1] createForBooking → status=open, balance=0, version=1', async () => {
		const folio = await freshFolio()
		expect(folio.status).toBe('open')
		expect(folio.balanceMinor).toBe('0')
		expect(folio.version).toBe(1)
		expect(folio.kind).toBe('guest')
		expect(folio.currency).toBe('RUB')
	})

	test('[H2, F1-F4] postLine increments balance + version, fields preserved', async () => {
		const folio = await freshFolio()
		const { folio: updated, line } = await factory.service.postLine(
			TENANT_A,
			folio.id,
			{
				category: 'accommodation',
				description: 'Night 1',
				amountMinor: 5000n,
				isAccommodationBase: true,
				taxRateBps: 0,
				routingRuleId: null,
				expectedFolioCurrency: folio.currency,
				expectedFolioVersion: folio.version,
			},
			ACTOR,
		)
		expect(updated.balanceMinor).toBe('5000')
		expect(updated.version).toBe(2)
		expect(line.amountMinor).toBe('5000') // F1
		expect(line.category).toBe('accommodation') // F2
		expect(line.isAccommodationBase).toBe(true) // F3
		expect(line.taxRateBps).toBe(0) // F4
		expect(line.lineStatus).toBe('posted')
	})

	test('[H3] voidLine decrements balance + bumps version', async () => {
		const folio = await freshFolio()
		const posted = await factory.service.postLine(
			TENANT_A,
			folio.id,
			{
				category: 'minibar',
				description: 'Snickers',
				amountMinor: 200n,
				isAccommodationBase: false,
				taxRateBps: 2200,
				routingRuleId: null,
				expectedFolioCurrency: folio.currency,
				expectedFolioVersion: folio.version,
			},
			ACTOR,
		)
		expect(posted.folio.balanceMinor).toBe('200')

		const voided = await factory.service.voidLine(
			TENANT_A,
			folio.id,
			posted.line.id,
			'Customer denied',
			ACTOR,
		)
		expect(voided.folio.balanceMinor).toBe('0') // back to zero
		expect(voided.folio.version).toBe(3) // 1 (create) + 1 (postLine) + 1 (voidLine)
		expect(voided.line.lineStatus).toBe('void')
		expect(voided.line.voidReason).toBe('Customer denied')
	})

	test('[H4] close transitions open → closed', async () => {
		const folio = await freshFolio()
		const closed = await factory.service.close(TENANT_A, folio.id, ACTOR)
		expect(closed.status).toBe('closed')
		expect(closed.closedAt).not.toBeNull()
		expect(closed.closedBy).toBe(ACTOR)
		expect(closed.version).toBe(2)
	})
})

describe('folio.service — FolioKind enum FULL coverage', { tags: ['db'] }, () => {
	const ALL_KINDS: FolioKind[] = [
		'guest',
		'company',
		'group_master',
		'ota_receivable',
		'ota_payable',
		'transitory',
	]
	test.each(ALL_KINDS)('[E1] %s kind roundtrip via createForBooking + getById', async (kind) => {
		const folio = await freshFolio(TENANT_A, kind)
		const fetched = await factory.service.getById(TENANT_A, folio.id)
		expect(fetched).not.toBeNull()
		expect(fetched?.kind).toBe(kind)
	})
})

describe('folio.service — cross-tenant isolation', { tags: ['db'] }, () => {
	test('[PT1] getById from wrong tenant → null', async () => {
		const folio = await freshFolio(TENANT_A)
		expect(await factory.service.getById(TENANT_A, folio.id)).not.toBeNull()
		expect(await factory.service.getById(TENANT_B, folio.id)).toBeNull()
	})

	test('[PT2] listByBooking from wrong tenant → []', async () => {
		const folio = await freshFolio(TENANT_A)
		const own = await factory.service.listByBooking(TENANT_A, folio.bookingId)
		expect(own.length).toBeGreaterThanOrEqual(1)
		const other = await factory.service.listByBooking(TENANT_B, folio.bookingId)
		expect(other).toHaveLength(0)
	})

	test('[PT2b] listReceivables (M6.7.4) cross-tenant: wrong tenant → []', async () => {
		const folio = await freshFolio(TENANT_A)
		// Pump balance > 0 so receivables view sees it
		await factory.service.postLine(
			TENANT_A,
			folio.id,
			{
				category: 'accommodation',
				description: 'fixture',
				amountMinor: 100_000n,
				isAccommodationBase: true,
				taxRateBps: 0,
				routingRuleId: null,
				expectedFolioCurrency: folio.currency,
				expectedFolioVersion: folio.version,
			},
			ACTOR,
		)
		const own = await factory.service.listReceivables(TENANT_A, folio.propertyId)
		expect(own.length).toBeGreaterThanOrEqual(1)
		expect(own.some((f) => f.id === folio.id)).toBe(true)
		const other = await factory.service.listReceivables(TENANT_B, folio.propertyId)
		expect(other).toEqual([])
	})

	test('[PT3] listLines from wrong tenant → []', async () => {
		const folio = await freshFolio(TENANT_A)
		await factory.service.postLine(
			TENANT_A,
			folio.id,
			{
				category: 'misc',
				description: 'Test',
				amountMinor: 100n,
				isAccommodationBase: false,
				taxRateBps: 0,
				routingRuleId: null,
				expectedFolioCurrency: folio.currency,
				expectedFolioVersion: folio.version,
			},
			ACTOR,
		)
		expect(await factory.service.listLines(TENANT_A, folio.id)).toHaveLength(1)
		expect(await factory.service.listLines(TENANT_B, folio.id)).toHaveLength(0)
	})

	test('[PT4] postLine on wrong tenant → FolioNotFoundError', async () => {
		const folio = await freshFolio(TENANT_A)
		await expect(
			factory.service.postLine(
				TENANT_B,
				folio.id,
				{
					category: 'misc',
					description: 'Test',
					amountMinor: 100n,
					isAccommodationBase: false,
					taxRateBps: 0,
					routingRuleId: null,
					expectedFolioCurrency: folio.currency,
					expectedFolioVersion: folio.version,
				},
				ACTOR,
			),
		).rejects.toThrow(FolioNotFoundError)
	})

	test('[PT5] voidLine on wrong tenant → FolioNotFoundError', async () => {
		const folio = await freshFolio(TENANT_A)
		const { line } = await factory.service.postLine(
			TENANT_A,
			folio.id,
			{
				category: 'misc',
				description: 'Test',
				amountMinor: 100n,
				isAccommodationBase: false,
				taxRateBps: 0,
				routingRuleId: null,
				expectedFolioCurrency: folio.currency,
				expectedFolioVersion: folio.version,
			},
			ACTOR,
		)
		await expect(factory.service.voidLine(TENANT_B, folio.id, line.id, 'r', ACTOR)).rejects.toThrow(
			FolioNotFoundError,
		)
	})

	test('[PT6] close on wrong tenant → FolioNotFoundError', async () => {
		const folio = await freshFolio(TENANT_A)
		await expect(factory.service.close(TENANT_B, folio.id, ACTOR)).rejects.toThrow(
			FolioNotFoundError,
		)
	})
})

describe('folio.service — currency / SM gates', { tags: ['db'] }, () => {
	test('[CV1] postLine with mismatched expectedFolioCurrency → FolioCurrencyMismatchError', async () => {
		const folio = await freshFolio(TENANT_A, 'guest', 'RUB')
		await expect(
			factory.service.postLine(
				TENANT_A,
				folio.id,
				{
					category: 'misc',
					description: 'Test',
					amountMinor: 100n,
					isAccommodationBase: false,
					taxRateBps: 0,
					routingRuleId: null,
					expectedFolioCurrency: 'USD', // mismatch
					expectedFolioVersion: folio.version,
				},
				ACTOR,
			),
		).rejects.toThrow(FolioCurrencyMismatchError)
	})

	test('[SM1] close on already-closed folio → InvalidFolioTransitionError', async () => {
		const folio = await freshFolio(TENANT_A)
		await factory.service.close(TENANT_A, folio.id, ACTOR)
		await expect(factory.service.close(TENANT_A, folio.id, ACTOR)).rejects.toThrow(
			InvalidFolioTransitionError,
		)
	})

	test('[SM2] postLine on closed folio → InvalidFolioTransitionError', async () => {
		const folio = await freshFolio(TENANT_A)
		const closed = await factory.service.close(TENANT_A, folio.id, ACTOR)
		await expect(
			factory.service.postLine(
				TENANT_A,
				folio.id,
				{
					category: 'misc',
					description: 'Test',
					amountMinor: 100n,
					isAccommodationBase: false,
					taxRateBps: 0,
					routingRuleId: null,
					expectedFolioCurrency: closed.currency,
					expectedFolioVersion: closed.version,
				},
				ACTOR,
			),
		).rejects.toThrow(InvalidFolioTransitionError)
	})
})
