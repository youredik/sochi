import { zValidator } from '@hono/zod-validator'
import { tourismTaxOrgReportParams } from '@horeca/shared'
import { Hono } from 'hono'
import writeXlsxFile from 'write-excel-file/node'
import type { BookingFactory } from '../../domains/booking/booking.factory.ts'
import type { AppEnv } from '../../factory.ts'
import { authMiddleware } from '../../middleware/auth.ts'
import { requirePermission } from '../../middleware/require-permission.ts'
import { tenantMiddleware } from '../../middleware/tenant.ts'

/**
 * Admin tax routes — operator-facing fiscal reporting under
 * `/api/admin/tax/*`. Permissions: `report:read` (owner + manager only,
 * staff cannot access).
 *
 * Endpoints
 *   GET /api/admin/tax/tourism/report  — org-level aggregate (JSON)
 *   GET /api/admin/tax/tourism/export.xlsx — same data as XLSX
 *
 * Both endpoints accept the same query params (from/to/propertyId?). The
 * service layer aggregates per `project_ru_tax_form_2026q1.md` (monthly
 * buckets + KPI). Льгота columns intentionally absent — see service
 * docstring for `getTourismTaxOrgReport`.
 *
 * XLSX writer uses `write-excel-file` 4.0.2 (canonical, see memory
 * `project_xlsx_library_decision.md`). Row-based API (schema removed in
 * 4.x). Cyrillic round-trips OOXML/UTF-8 natively. Three sheets:
 * Свод (KPI), Помесячно, Построчно.
 */
/**
 * Inner factory — handlers only, NO auth/tenant middleware. Used by tests
 * (stubAuthMiddleware sets `c.var.tenantId` upstream) and composed with
 * the production middleware chain in `createAdminTaxRoutes`.
 */
export function createAdminTaxRoutesInner(service: BookingFactory['service']) {
	const microsToRubles = (m: string): number => Number(BigInt(m) / 1_000_000n)

	return new Hono<AppEnv>()
		.use('*', requirePermission({ report: ['read'] }))
		.get('/tax/tourism/report', zValidator('query', tourismTaxOrgReportParams), async (c) => {
			const params = c.req.valid('query')
			const report = await service.getTourismTaxOrgReport(c.var.tenantId, params)
			return c.json({ data: report }, 200)
		})
		.get('/tax/tourism/export.xlsx', zValidator('query', tourismTaxOrgReportParams), async (c) => {
			const params = c.req.valid('query')
			const report = await service.getTourismTaxOrgReport(c.var.tenantId, params)

			const headerCell = (text: string) => ({
				value: text,
				type: String,
				fontWeight: 'bold' as const,
			})
			const moneyCell = (m: string) => ({
				value: microsToRubles(m),
				type: Number,
				format: '#,##0',
			})
			const dateCell = (iso: string) => ({
				value: new Date(`${iso}T00:00:00Z`),
				type: Date,
				format: 'dd.mm.yyyy',
			})

			// Sheet 1 — Свод (KPI summary)
			const summaryData = [
				[headerCell('Параметр'), headerCell('Значение')],
				[{ value: 'Период с' }, { value: report.period.from }],
				[{ value: 'Период по' }, { value: report.period.to }],
				[{ value: 'Объект' }, { value: report.propertyId ?? 'все объекты организации' }],
				[{ value: 'Бронирований' }, { value: report.kpi.bookingsCount, type: Number }],
				[{ value: 'Ночей' }, { value: report.kpi.totalNights, type: Number }],
				[{ value: 'Налоговая база, ₽' }, moneyCell(report.kpi.accommodationBaseMicros)],
				[{ value: 'Туристический налог, ₽' }, moneyCell(report.kpi.tourismTaxMicros)],
			]

			// Sheet 2 — Помесячно
			const monthlyData = [
				[
					headerCell('Месяц'),
					headerCell('Бронирований'),
					headerCell('Ночей'),
					headerCell('Налоговая база, ₽'),
					headerCell('Налог, ₽'),
				],
				...report.monthly.map((m) => [
					{ value: m.month },
					{ value: m.bookingsCount, type: Number },
					{ value: m.totalNights, type: Number },
					moneyCell(m.accommodationBaseMicros),
					moneyCell(m.tourismTaxMicros),
				]),
			]

			// Sheet 3 — Построчно
			const linesData = [
				[
					headerCell('Дата заезда'),
					headerCell('Дата выезда'),
					headerCell('Ночей'),
					headerCell('Объект'),
					headerCell('Гость'),
					headerCell('Канал'),
					headerCell('Статус'),
					headerCell('Льгота'),
					headerCell('Налоговая база, ₽'),
					headerCell('Налог, ₽'),
				],
				...report.rows.map((r) => [
					dateCell(r.checkIn),
					dateCell(r.checkOut),
					{ value: r.nightsCount, type: Number },
					{ value: r.propertyName },
					{ value: r.guestName },
					{ value: r.channelCode },
					{ value: r.status },
					// Placeholder — schema lands with M8 МВД flow.
					{ value: '—' },
					moneyCell(r.accommodationBaseMicros),
					moneyCell(r.tourismTaxMicros),
				]),
			]

			const buffer = await writeXlsxFile([
				{
					data: summaryData,
					sheet: 'Свод',
					stickyRowsCount: 1,
					columns: [{ width: 32 }, { width: 28 }],
				},
				{
					data: monthlyData,
					sheet: 'Помесячно',
					stickyRowsCount: 1,
					columns: [{ width: 12 }, { width: 14 }, { width: 10 }, { width: 22 }, { width: 16 }],
				},
				{
					data: linesData,
					sheet: 'Построчно',
					stickyRowsCount: 1,
					columns: [
						{ width: 14 },
						{ width: 14 },
						{ width: 8 },
						{ width: 22 },
						{ width: 26 },
						{ width: 14 },
						{ width: 14 },
						{ width: 12 },
						{ width: 18 },
						{ width: 14 },
					],
				},
			]).toBuffer()

			const filename = `тур_налог_${report.period.from}_${report.period.to}.xlsx`
			// Hono `c.body` expects `Uint8Array<ArrayBuffer>` (TS-5 generic).
			// Node `Buffer.buffer` may be SharedArrayBuffer or pooled, so copy
			// into a fresh ArrayBuffer-backed Uint8Array to satisfy the type.
			const body = new Uint8Array(buffer.byteLength)
			body.set(buffer)
			c.header('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
			c.header(
				'Content-Disposition',
				`attachment; filename*=UTF-8''${encodeURIComponent(filename)}`,
			)
			c.header('Content-Length', String(body.byteLength))
			return c.body(body, 200)
		})
}

/**
 * Production wrapper — applies the real auth + tenant middleware chain
 * before delegating to the inner handlers.
 */
export function createAdminTaxRoutes(bookingFactory: BookingFactory) {
	return new Hono<AppEnv>()
		.use('*', authMiddleware(), tenantMiddleware())
		.route('/', createAdminTaxRoutesInner(bookingFactory.service))
}
