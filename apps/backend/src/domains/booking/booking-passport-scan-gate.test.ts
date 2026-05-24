/**
 * Sprint C+ Round 7 Senior P0 fix 2026-05-24 — strict tests на 109-ФЗ ст. 22 +
 * ПП РФ № 9 от 15.01.2007 passport-scan hard-gate в booking.service.checkIn.
 *
 * Mirrors `booking-ksr-gate.test.ts` pattern (isolated unit test против
 * stubbed deps; integration covered via *.db.test.ts slow lane).
 *
 *   [P1] guestDocumentRepo undefined → gate skipped (test-mode legacy)
 *   [P2] RU citizenship гость → gate skipped (МВД-учёт необходим только для ИГ)
 *   [P3] RUS (alpha-3) citizenship гость → gate skipped (isRussianCitizenship)
 *   [P4] foreign citizen + active doc present → check-in succeeds
 *   [P5] foreign citizen + NO active doc → throws PassportScanRequiredError
 *   [P6] booking not found → no error from gate (downstream null repo handles)
 *
 * Critical: gate logic depends on `isRussianCitizenship` shared helper handling
 * BOTH alpha-2 ('RU') и alpha-3 ('RUS') — `BookingGuestSnapshot.citizenship`
 * accepts оба per shared schema.
 */
import { describe, expect, mock, test } from 'bun:test'
import { PassportScanRequiredError } from '../../errors/domain.ts'
import { createBookingService } from './booking.service.ts'

// biome-ignore lint/suspicious/noExplicitAny: structural mocks для isolated service test
const stubRateRepo: any = { listRange: mock(async () => []) }
// biome-ignore lint/suspicious/noExplicitAny: structural mocks для isolated service test
const stubPropertyService: any = { getById: mock(async () => null) }
// biome-ignore lint/suspicious/noExplicitAny: structural mocks для isolated service test
const stubRoomTypeService: any = { getById: mock(async () => null) }
// biome-ignore lint/suspicious/noExplicitAny: structural mocks для isolated service test
const stubRatePlanService: any = { getById: mock(async () => null) }

function makeRepoStub(booking: { citizenship: string } | null) {
	// biome-ignore lint/suspicious/noExplicitAny: structural
	const stub: any = {
		getById: mock(async () => {
			if (!booking) return null
			return {
				id: 'bkg_x',
				tenantId: 'org_test',
				primaryGuestId: 'gst_test',
				status: 'confirmed',
				checkIn: '2026-06-01',
				checkOut: '2026-06-02',
				guestSnapshot: {
					firstName: 'Test',
					lastName: 'Guest',
					citizenship: booking.citizenship,
					documentType: 'Test',
					documentNumber: 'X',
				},
			}
		}),
		checkIn: mock(async () => ({ id: 'bkg_x', status: 'in_house' })),
	}
	return stub
}

function makeActiveDocStub(found: boolean) {
	// biome-ignore lint/suspicious/noExplicitAny: structural
	const stub: any = {
		findActiveForGuest: mock(async () =>
			found
				? {
						id: 'gdoc_x',
						identityMethod: 'passport_zagran',
						documentNumberMaskedTail: '5678',
						citizenshipIso3: 'chn',
						photoConsentLogId: 'cns_x',
						scannedAt: new Date('2026-05-24T10:00:00Z'),
					}
				: null,
		),
	}
	return stub
}

describe('booking.service.checkIn — 109-ФЗ passport-scan hard-gate', () => {
	test('[P1] guestDocumentRepo undefined → gate skipped (test-mode legacy)', async () => {
		const repo = makeRepoStub({ citizenship: 'CHN' })
		const service = createBookingService(
			repo,
			stubRateRepo,
			stubPropertyService,
			stubRoomTypeService,
			stubRatePlanService,
		)
		// Should succeed без gate fire (no guestDocumentRepo provided).
		const result = (await service.checkIn('org_test', 'bkg_x', {}, 'usr_a')) as {
			id: string
			status: string
		}
		expect(result.id).toBe('bkg_x')
		expect(result.status).toBe('in_house')
		expect(repo.checkIn).toHaveBeenCalled()
	})

	test('[P2] RU citizenship → gate skipped (МВД-учёт not required for citizens)', async () => {
		const repo = makeRepoStub({ citizenship: 'RU' })
		const docRepo = makeActiveDocStub(false)
		const service = createBookingService(
			repo,
			stubRateRepo,
			stubPropertyService,
			stubRoomTypeService,
			stubRatePlanService,
			undefined,
			undefined,
			docRepo,
		)
		await service.checkIn('org_test', 'bkg_x', {}, 'usr_a')
		// Doc lookup never called — early-return on isRussianCitizenship.
		expect(docRepo.findActiveForGuest).not.toHaveBeenCalled()
	})

	test('[P3] RUS (alpha-3) citizenship → gate skipped (isRussianCitizenship handles both)', async () => {
		const repo = makeRepoStub({ citizenship: 'RUS' })
		const docRepo = makeActiveDocStub(false)
		const service = createBookingService(
			repo,
			stubRateRepo,
			stubPropertyService,
			stubRoomTypeService,
			stubRatePlanService,
			undefined,
			undefined,
			docRepo,
		)
		await service.checkIn('org_test', 'bkg_x', {}, 'usr_a')
		expect(docRepo.findActiveForGuest).not.toHaveBeenCalled()
	})

	test('[P4] foreign + active doc → check-in succeeds', async () => {
		const repo = makeRepoStub({ citizenship: 'CHN' })
		const docRepo = makeActiveDocStub(true)
		const service = createBookingService(
			repo,
			stubRateRepo,
			stubPropertyService,
			stubRoomTypeService,
			stubRatePlanService,
			undefined,
			undefined,
			docRepo,
		)
		const result = (await service.checkIn('org_test', 'bkg_x', {}, 'usr_a')) as {
			id: string
			status: string
		}
		expect(result.id).toBe('bkg_x')
		expect(result.status).toBe('in_house')
		expect(docRepo.findActiveForGuest).toHaveBeenCalledWith('org_test', 'gst_test')
		expect(repo.checkIn).toHaveBeenCalled()
	})

	test('[P5] foreign + NO active doc → throws PassportScanRequiredError (HTTP 428)', async () => {
		const repo = makeRepoStub({ citizenship: 'KZ' })
		const docRepo = makeActiveDocStub(false)
		const service = createBookingService(
			repo,
			stubRateRepo,
			stubPropertyService,
			stubRoomTypeService,
			stubRatePlanService,
			undefined,
			undefined,
			docRepo,
		)
		await expect(service.checkIn('org_test', 'bkg_x', {}, 'usr_a')).rejects.toThrow(
			PassportScanRequiredError,
		)
		// repo.checkIn never called — gate fired first.
		expect(repo.checkIn).not.toHaveBeenCalled()
	})

	test('[P6] booking not found → no gate error (downstream null handle)', async () => {
		const repo = makeRepoStub(null)
		const docRepo = makeActiveDocStub(false)
		const service = createBookingService(
			repo,
			stubRateRepo,
			stubPropertyService,
			stubRoomTypeService,
			stubRatePlanService,
			undefined,
			undefined,
			docRepo,
		)
		// repo.getById returns null → guard skips gate; repo.checkIn still called.
		// (Real-world: booking-not-found surfaces в route layer как 404.)
		await service.checkIn('org_test', 'bkg_missing', {}, 'usr_a')
		expect(docRepo.findActiveForGuest).not.toHaveBeenCalled()
		expect(repo.checkIn).toHaveBeenCalled()
	})
})

describe('PassportScanRequiredError', () => {
	test('error code is canonical PASSPORT_SCAN_REQUIRED', () => {
		const err = new PassportScanRequiredError('gst_x')
		expect(err.code).toBe('PASSPORT_SCAN_REQUIRED')
		expect(err.name).toBe('PassportScanRequiredError')
		expect(err.guestId).toBe('gst_x')
		expect(err.message).toContain('109-ФЗ')
		expect(err.message).toContain('ПП РФ № 9')
		expect(err.message).toContain('18.9 КоАП')
	})
})
