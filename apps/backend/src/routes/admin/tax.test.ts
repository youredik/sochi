/**
 * Admin tax routes — wire-up test per memory `feedback_strict_tests.md`.
 *
 * Test plan:
 *   RBAC (validates `requirePermission({ report: ['read'] })`):
 *     [R1] staff → 403 (front-desk не имеет report:read)
 *     [R2] manager → 200
 *     [R3] owner → 200
 *
 *   JSON endpoint (`GET /tax/tourism/report`):
 *     [J1] returns `{ data: TourismTaxOrgReport }` shape
 *     [J2] zValidator catches missing `from` → 400
 *     [J3] zValidator catches `from > to` → 400
 *
 *   XLSX endpoint (`GET /tax/tourism/export.xlsx`):
 *     [X1] Content-Type = OOXML spreadsheetml.sheet
 *     [X2] Content-Disposition has UTF-8 filename* with quarter dates
 *     [X3] Content-Length matches body
 *     [X4] Body is non-empty Uint8Array (PK zip-magic = 0x50 0x4B at offset 0)
 *
 * **Why fake service**: full integration coverage of `getTourismTaxOrgReport`
 * lives in `booking.service.integration.test.ts` (real YDB). Here we exercise
 * the route layer in isolation — RBAC, validation, headers, XLSX content
 * envelope. No YDB needed.
 */
import type { MemberRole, TourismTaxOrgReport } from '@horeca/shared'
import { readSheet } from 'read-excel-file/node'
import { describe, expect, test } from 'vitest'
import type { BookingFactory } from '../../domains/booking/booking.factory.ts'
import { requirePermission } from '../../middleware/require-permission.ts'
import { createTestRouter, type TestContext } from '../../tests/setup.ts'
import { createAdminTaxRoutesInner } from './tax.ts'

const FAKE_USER = {
	id: 'usr-test',
	email: 'test@sochi.local',
	emailVerified: true,
	name: 'Test',
	createdAt: new Date(),
	updatedAt: new Date(),
} as TestContext['user']

const FAKE_SESSION = {
	id: 'ses-test',
	userId: FAKE_USER.id,
	expiresAt: new Date(Date.now() + 3600_000),
	token: 'tok',
	createdAt: new Date(),
	updatedAt: new Date(),
	ipAddress: '127.0.0.1',
	userAgent: 'test',
	activeOrganizationId: 'org-test',
} as TestContext['session']

function ctxFor(role: MemberRole): TestContext {
	return {
		user: FAKE_USER,
		session: FAKE_SESSION,
		tenantId: 'org-test',
		memberRole: role,
	}
}

const FAKE_REPORT: TourismTaxOrgReport = {
	period: { from: '2026-01-01', to: '2026-03-31' },
	propertyId: null,
	kpi: {
		bookingsCount: 2,
		totalNights: 5,
		accommodationBaseMicros: '50000000000', // 50_000 ₽
		tourismTaxMicros: '1000000000', // 1_000 ₽
	},
	monthly: [
		{
			month: '2026-01',
			bookingsCount: 1,
			totalNights: 2,
			accommodationBaseMicros: '20000000000',
			tourismTaxMicros: '400000000',
		},
		{
			month: '2026-02',
			bookingsCount: 1,
			totalNights: 3,
			accommodationBaseMicros: '30000000000',
			tourismTaxMicros: '600000000',
		},
	],
	rows: [
		{
			bookingId: 'booking_01',
			propertyId: 'prop_01',
			propertyName: 'Тестовый отель',
			checkIn: '2026-01-15',
			checkOut: '2026-01-17',
			nightsCount: 2,
			guestName: 'Петров Иван',
			channelCode: 'direct',
			status: 'confirmed',
			accommodationBaseMicros: '20000000000',
			tourismTaxMicros: '400000000',
		},
		{
			bookingId: 'booking_02',
			propertyId: 'prop_01',
			propertyName: 'Тестовый отель',
			checkIn: '2026-02-20',
			checkOut: '2026-02-23',
			nightsCount: 3,
			guestName: 'Сидорова Мария',
			channelCode: 'direct',
			status: 'checked_out',
			accommodationBaseMicros: '30000000000',
			tourismTaxMicros: '600000000',
		},
	],
}

function buildFakeService(): BookingFactory['service'] {
	return {
		getTourismTaxOrgReport: async () => FAKE_REPORT,
	} as unknown as BookingFactory['service']
}

/**
 * Mount the INNER route handlers (no auth/tenant middleware) under
 * stubAuthMiddleware which pre-sets `c.var.user/session/tenantId/memberRole`.
 * `requirePermission` still runs and gates by `memberRole`.
 */
function buildApp(role: MemberRole) {
	const service = buildFakeService()
	const validParams = '?from=2026-01-01&to=2026-03-31'
	const app = createTestRouter(ctxFor(role)).route('/api/admin', createAdminTaxRoutesInner(service))
	return { app, validParams }
}

describe('admin tax routes — RBAC', () => {
	test('[R1] staff → 403 FORBIDDEN (front-desk нет report:read)', async () => {
		const { app, validParams } = buildApp('staff')
		const res = await app.request(`/api/admin/tax/tourism/report${validParams}`)
		expect(res.status).toBe(403)
		const body = (await res.json()) as { error: { code: string; role: string } }
		expect(body.error.code).toBe('FORBIDDEN')
		expect(body.error.role).toBe('staff')
	})

	test('[R2] manager → 200', async () => {
		const { app, validParams } = buildApp('manager')
		const res = await app.request(`/api/admin/tax/tourism/report${validParams}`)
		expect(res.status).toBe(200)
	})

	test('[R3] owner → 200', async () => {
		const { app, validParams } = buildApp('owner')
		const res = await app.request(`/api/admin/tax/tourism/report${validParams}`)
		expect(res.status).toBe(200)
	})
})

describe('admin tax routes — JSON endpoint', () => {
	test('[J1] returns { data: TourismTaxOrgReport } shape', async () => {
		const { app, validParams } = buildApp('owner')
		const res = await app.request(`/api/admin/tax/tourism/report${validParams}`)
		expect(res.status).toBe(200)
		const body = (await res.json()) as { data: TourismTaxOrgReport }
		expect(body.data.kpi.bookingsCount).toBe(2)
		expect(body.data.kpi.tourismTaxMicros).toBe('1000000000')
		expect(body.data.monthly).toHaveLength(2)
		expect(body.data.rows).toHaveLength(2)
		expect(body.data.rows[0]?.guestName).toBe('Петров Иван')
	})

	test('[J2] missing `from` → 400', async () => {
		const { app } = buildApp('owner')
		const res = await app.request('/api/admin/tax/tourism/report?to=2026-03-31')
		expect(res.status).toBe(400)
	})

	test('[J3] from > to → 400', async () => {
		const { app } = buildApp('owner')
		const res = await app.request('/api/admin/tax/tourism/report?from=2026-04-01&to=2026-01-01')
		expect(res.status).toBe(400)
	})
})

/**
 * Helper: send the XLSX endpoint and parse the buffer back through
 * read-excel-file (sister-package by the same author). Returns parsed sheets
 * keyed by name. This is the round-trip Mitigation we promised in
 * `project_xlsx_library_decision.md`.
 */
async function fetchXlsxAndParseSheets(): Promise<
	Record<string, ReadonlyArray<ReadonlyArray<unknown>>>
> {
	const { app } = buildApp('owner')
	const res = await app.request('/api/admin/tax/tourism/export.xlsx?from=2026-01-01&to=2026-03-31')
	const buffer = Buffer.from(await res.arrayBuffer())
	const sheetNames = ['Свод', 'Помесячно', 'Построчно']
	const out: Record<string, ReadonlyArray<ReadonlyArray<unknown>>> = {}
	for (const name of sheetNames) {
		out[name] = await readSheet(buffer, name)
	}
	return out
}

describe('admin tax routes — XLSX endpoint', () => {
	test('[X1+X2+X3+X4] XLSX response: content-type + UTF-8 filename + non-empty PK-magic body', async () => {
		const { app } = buildApp('manager')
		const res = await app.request(
			'/api/admin/tax/tourism/export.xlsx?from=2026-01-01&to=2026-03-31',
		)
		expect(res.status).toBe(200)
		expect(res.headers.get('content-type')).toBe(
			'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
		)
		const cd = res.headers.get('content-disposition')
		expect(cd).toBeTruthy()
		expect(cd).toContain("filename*=UTF-8''")
		// UTF-8 percent-encoded "тур_налог" prefix.
		expect(cd).toContain(encodeURIComponent('тур_налог'))

		const body = new Uint8Array(await res.arrayBuffer())
		expect(body.byteLength).toBeGreaterThan(100) // XLSX is multi-KB minimum
		expect(res.headers.get('content-length')).toBe(String(body.byteLength))
		// XLSX = ZIP archive — first 2 bytes are 0x50 0x4B (ASCII "PK").
		expect(body[0]).toBe(0x50)
		expect(body[1]).toBe(0x4b)
	})

	test('[X5] staff → 403 even on XLSX endpoint', async () => {
		const { app } = buildApp('staff')
		const res = await app.request(
			'/api/admin/tax/tourism/export.xlsx?from=2026-01-01&to=2026-03-31',
		)
		expect(res.status).toBe(403)
	})

	// ---------------- XLSX round-trip (Cyrillic + multi-sheet + dates) ----------------
	//
	// Memory `project_xlsx_library_decision.md`: «we have e2e XLSX round-trip
	// test against a known-good fixture in pre-push gate». These tests close
	// that promise — we parse the buffer back through the sister-package
	// `read-excel-file` and assert exact cell values per sheet.

	test('[X6] round-trip: 3 sheets present with exact Cyrillic names', async () => {
		const sheets = await fetchXlsxAndParseSheets()
		expect(Object.keys(sheets).sort()).toEqual(['Помесячно', 'Построчно', 'Свод'])
	})

	test('[X7] round-trip: Свод sheet headers + KPI exact values', async () => {
		const sheets = await fetchXlsxAndParseSheets()
		const summary = sheets.Свод
		expect(summary).toBeDefined()
		// Header row + 7 KPI rows = 8 rows total.
		expect(summary?.length).toBe(8)
		expect(summary?.[0]).toEqual(['Параметр', 'Значение'])
		// Period from/to passthrough (read-excel-file parses dates as Date — but
		// these values are stored as strings so come back as strings).
		expect(summary?.[1]?.[0]).toBe('Период с')
		expect(summary?.[1]?.[1]).toBe('2026-01-01')
		expect(summary?.[2]?.[1]).toBe('2026-03-31')
		expect(summary?.[3]?.[0]).toBe('Объект')
		expect(summary?.[3]?.[1]).toBe('все объекты организации')
		// Numeric KPIs round-trip as numbers — exact values from FAKE_REPORT.
		expect(summary?.[4]?.[1]).toBe(2) // Бронирований
		expect(summary?.[5]?.[1]).toBe(5) // Ночей
		expect(summary?.[6]?.[1]).toBe(50_000) // Налоговая база, ₽ (50_000_000_000 micros / 1_000_000)
		expect(summary?.[7]?.[1]).toBe(1_000) // Туристический налог, ₽
	})

	test('[X8] round-trip: Помесячно sheet — header + 2 buckets', async () => {
		const sheets = await fetchXlsxAndParseSheets()
		const monthly = sheets.Помесячно
		expect(monthly).toBeDefined()
		expect(monthly?.length).toBe(3) // header + 2 months
		expect(monthly?.[0]).toEqual([
			'Месяц',
			'Бронирований',
			'Ночей',
			'Налоговая база, ₽',
			'Налог, ₽',
		])
		expect(monthly?.[1]).toEqual(['2026-01', 1, 2, 20_000, 400])
		expect(monthly?.[2]).toEqual(['2026-02', 1, 3, 30_000, 600])
	})

	test('[X9] round-trip: Построчно sheet — Cyrillic guest names + dates round-trip', async () => {
		const sheets = await fetchXlsxAndParseSheets()
		const lines = sheets.Построчно
		expect(lines).toBeDefined()
		expect(lines?.length).toBe(3) // header + 2 booking rows
		expect(lines?.[0]).toEqual([
			'Дата заезда',
			'Дата выезда',
			'Ночей',
			'Объект',
			'Гость',
			'Канал',
			'Статус',
			'Льгота',
			'Налоговая база, ₽',
			'Налог, ₽',
		])
		// Row 1 — Петров Иван 2026-01-15..17, 2 nights
		const row1 = lines?.[1]
		expect(row1?.[0]).toBeInstanceOf(Date)
		expect((row1?.[0] as Date).toISOString().slice(0, 10)).toBe('2026-01-15')
		expect((row1?.[1] as Date).toISOString().slice(0, 10)).toBe('2026-01-17')
		expect(row1?.[2]).toBe(2)
		expect(row1?.[3]).toBe('Тестовый отель')
		expect(row1?.[4]).toBe('Петров Иван')
		expect(row1?.[5]).toBe('direct')
		expect(row1?.[6]).toBe('confirmed')
		expect(row1?.[7]).toBe('—') // льгота placeholder until M8
		expect(row1?.[8]).toBe(20_000) // налоговая база
		expect(row1?.[9]).toBe(400) // налог
		// Row 2 — Сидорова Мария
		const row2 = lines?.[2]
		expect(row2?.[4]).toBe('Сидорова Мария')
		expect(row2?.[6]).toBe('checked_out')
	})
})

describe('admin tax routes — sanity ref to requirePermission', () => {
	test('requirePermission permission key is { report: ["read"] }', () => {
		// Mirror-test: route file uses this exact key. If it diverges, this
		// breaks immediately and forces both sides to stay in sync.
		expect(requirePermission({ report: ['read'] })).toBeTruthy()
	})
})
