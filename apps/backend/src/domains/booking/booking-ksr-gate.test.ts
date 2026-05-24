/**
 * Sprint C+ Round 6 Legal P0 fix 2026-05-24 — strict tests на ПП-1951 КСР
 * registry hard-gate в booking.service.create.
 *
 *   [K1] complianceRepo undefined → gate skipped (test-mode legacy)
 *   [K2] complianceRepo.assertKsrRegistryNumberPresent throws → error propagates
 *        BEFORE property lookup (gate fires first)
 *   [K3] complianceRepo passes → service.create proceeds normally к property lookup
 *
 * Behaviour critical: hard-gate must fire BEFORE any other lookup. Otherwise
 * tenant получает PropertyNotFoundError вместо корректного KsrRegistryNumber
 * MissingError → confusing UX + legal exposure (booking-create looks healthy
 * пока property exists).
 */
import { describe, expect, mock, test } from 'bun:test'
import { KsrRegistryNumberMissingError } from '../../errors/domain.ts'
import { createBookingService } from './booking.service.ts'

// biome-ignore lint/suspicious/noExplicitAny: structural mocks для isolated service test
const stubRepo: any = {
	getById: mock(async () => null),
	listByProperty: mock(async () => []),
	create: mock(async () => ({ id: 'bkg_x' })),
}
// biome-ignore lint/suspicious/noExplicitAny: structural mocks для isolated service test
const stubRateRepo: any = { listRange: mock(async () => []) }
// biome-ignore lint/suspicious/noExplicitAny: structural mocks для isolated service test
const stubPropertyService: any = { getById: mock(async () => null) }
// biome-ignore lint/suspicious/noExplicitAny: structural mocks для isolated service test
const stubRoomTypeService: any = { getById: mock(async () => null) }
// biome-ignore lint/suspicious/noExplicitAny: structural mocks для isolated service test
const stubRatePlanService: any = { getById: mock(async () => null) }

const baseInput = {
	roomTypeId: 'rmt_x',
	ratePlanId: 'rtp_x',
	checkIn: '2026-06-01',
	checkOut: '2026-06-03',
	// biome-ignore lint/suspicious/noExplicitAny: tests structural shape only
} as any

describe('booking.service.create — ПП-1951 КСР hard-gate', () => {
	test('[K1] complianceRepo undefined → gate skipped (test-mode legacy)', async () => {
		const service = createBookingService(
			stubRepo,
			stubRateRepo,
			stubPropertyService,
			stubRoomTypeService,
			stubRatePlanService,
		)
		// PropertyNotFoundError expected (stub returns null property), NOT
		// KsrRegistryNumberMissingError — proves gate is bypassed.
		await expect(service.create('org_t1', 'prop_x', baseInput, 'usr_a')).rejects.toThrow(
			/Property not found/,
		)
	})

	test('[K2] complianceRepo throws KsrRegistryNumberMissingError → propagates BEFORE property lookup', async () => {
		// biome-ignore lint/suspicious/noExplicitAny: structural mock
		const complianceRepo: any = {
			assertKsrRegistryNumberPresent: mock(async (tenantId: string) => {
				throw new KsrRegistryNumberMissingError(tenantId)
			}),
		}
		const service = createBookingService(
			stubRepo,
			stubRateRepo,
			stubPropertyService,
			stubRoomTypeService,
			stubRatePlanService,
			undefined,
			complianceRepo,
		)
		await expect(service.create('org_t2', 'prop_x', baseInput, 'usr_a')).rejects.toThrow(
			KsrRegistryNumberMissingError,
		)
		// Property service.getById should NOT have been called — gate fired first.
		// (Last call from K1 test counted; this fresh service call adds zero new
		// invocations to stubPropertyService.getById.)
	})

	test('[K3] complianceRepo passes → service proceeds к property lookup', async () => {
		// biome-ignore lint/suspicious/noExplicitAny: structural mock
		const complianceRepo: any = {
			assertKsrRegistryNumberPresent: mock(async () => {
				/* no-op = ksrRegistryId valid */
			}),
		}
		const service = createBookingService(
			stubRepo,
			stubRateRepo,
			stubPropertyService,
			stubRoomTypeService,
			stubRatePlanService,
			undefined,
			complianceRepo,
		)
		// Stub property returns null → expect PropertyNotFoundError (gate passed,
		// property check failed) — proves we got PAST gate.
		await expect(service.create('org_t3', 'prop_x', baseInput, 'usr_a')).rejects.toThrow(
			/Property not found/,
		)
		expect(complianceRepo.assertKsrRegistryNumberPresent).toHaveBeenCalledWith('org_t3')
	})
})

describe('KsrRegistryNumberMissingError', () => {
	test('error code is canonical KSR_REGISTRY_NUMBER_MISSING', () => {
		const err = new KsrRegistryNumberMissingError('org_x')
		expect(err.code).toBe('KSR_REGISTRY_NUMBER_MISSING')
		expect(err.name).toBe('KsrRegistryNumberMissingError')
		expect(err.message).toContain('ПП-1951')
	})
})
