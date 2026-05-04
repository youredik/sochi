/**
 * Guest portal routes (M9.widget.5 / A3.3).
 *
 * POST /api/public/booking/guest-portal/:bookingId/cancel — cancel booking
 *   с cookie-auth (guestSessionMiddleware) + ПП-1912 boundary enforcement.
 *
 * GET /api/public/booking/guest-portal/:bookingId — view booking details
 *   с cookie-auth.
 *
 * Per `plans/m9_widget_5_canonical.md` §D12 (ПП РФ № 1912 от 27.11.2025 п. 16):
 *   - Cancel-pre-checkin (`now < endOfDay(checkIn, Europe/Moscow)`) → 100% refund
 *   - Cancel/no-show day-of+later → max 1-night charge canon
 *   - «Невозвратный тариф» eliminated — UI element NEVER appears
 *
 * Cookie scope canon (§D2):
 *   - GET (view) accepts BOTH 'view' и 'mutate' scope cookies
 *   - POST cancel REQUIRES 'mutate' scope (15min TTL strict-single-use)
 *
 * Per architecture canon (depcruise `no-routes-to-db`):
 *   - Routes consume через DI: bookingService + guest-portal.repo
 */

import { zValidator } from '@hono/zod-validator'
import { Hono } from 'hono'
import { z } from 'zod'
import type { AppEnv } from '../../factory.ts'
import { guestSessionMiddleware } from '../../middleware/guest-session.ts'
import type { BookingService } from './booking.service.ts'
import type { GuestPortalRepo, GuestPortalView } from './guest-portal.repo.ts'

/**
 * Compute ПП-1912 cancel boundary status. `now` < endOfDay(checkInDate,
 * Europe/Moscow) → 'pre_checkin' (100% refund); else → 'day_of_or_later'
 * (max 1-night charge per ПП РФ № 1912 п. 16).
 *
 * Sochi timezone = Europe/Moscow (UTC+3, no DST since 2014). Computed inline:
 * checkIn date interpreted as wall-clock в Europe/Moscow → endOfDay(checkIn) =
 * `<checkIn calendar date> 23:59:59.999 UTC+3` = `<checkIn> + 1 day 00:00 UTC -3h
 * = (checkIn calendar date 21:00:00.000Z next day)`.
 */
export function computeCancelBoundary(
	checkInDate: Date,
	now: Date,
): 'pre_checkin' | 'day_of_or_later' {
	// checkIn is interpreted as Europe/Moscow wall-time. boundary = end-of-day
	// в Europe/Moscow = next-day 00:00 UTC+3 = same-day 21:00 UTC (next day in
	// Moscow time = checkIn calendar date в Moscow + 24h - 3h в UTC).
	//
	// Simpler computation: extract checkIn calendar date components as if в
	// Europe/Moscow, then construct boundary = (checkIn в Moscow) + 24h.
	const moscowOffsetMs = 3 * 60 * 60 * 1000
	const checkInUtcMs = checkInDate.getTime()
	// checkIn в Moscow time
	const checkInMoscowMs = checkInUtcMs + moscowOffsetMs
	const checkInDateOnly = new Date(checkInMoscowMs)
	checkInDateOnly.setUTCHours(0, 0, 0, 0)
	// endOfDay в Moscow = next-day 00:00 Moscow time = +24h
	const boundaryMoscowMs = checkInDateOnly.getTime() + 24 * 60 * 60 * 1000
	// Convert back to UTC ms for comparison
	const boundaryUtcMs = boundaryMoscowMs - moscowOffsetMs
	return now.getTime() < boundaryUtcMs ? 'pre_checkin' : 'day_of_or_later'
}

const cancelInputSchema = z.object({
	reason: z.string().min(1).max(500).default('Отменено гостем через guest portal'),
})

const GUEST_CANCEL_ACTOR = 'system:guest_portal'

export interface GuestPortalRoutesDeps {
	readonly repo: GuestPortalRepo
	readonly bookingService: BookingService
	readonly resolveCookieSecret: (tenantId: string) => Promise<string>
	readonly sessionCookieMaxAge?: number
	/**
	 * Test override — fixed `now` for deterministic ПП-1912 boundary computation.
	 */
	readonly nowFn?: () => Date
}

export function createGuestPortalRoutes(deps: GuestPortalRoutesDeps) {
	const now = deps.nowFn ?? (() => new Date())
	const sessionMw = guestSessionMiddleware({
		resolveCookieSecret: deps.resolveCookieSecret,
		...(deps.sessionCookieMaxAge !== undefined && {
			sessionCookieMaxAge: deps.sessionCookieMaxAge,
		}),
	})

	return new Hono<AppEnv>()
		.use('/booking/guest-portal/*', sessionMw)
		.get('/booking/guest-portal/:bookingId', async (c) => {
			const session = c.var.guestSession
			const requestedBookingId = c.req.param('bookingId')

			if (session.bookingId !== requestedBookingId) {
				return c.json(
					{
						error: {
							code: 'GUEST_SESSION_BOOKING_MISMATCH',
							message: 'Сессия привязана к другому бронированию.',
						},
					},
					403,
				)
			}

			const view: GuestPortalView | null = await deps.repo.viewBooking(
				session.tenantId,
				session.bookingId,
			)
			if (!view) {
				return c.json(
					{
						error: {
							code: 'BOOKING_NOT_FOUND',
							message: 'Бронирование не найдено.',
						},
					},
					404,
				)
			}

			c.header('Cache-Control', 'no-store')
			const boundary = computeCancelBoundary(view.checkIn, now())
			return c.json(
				{
					booking: view,
					cancelPolicy: {
						boundary,
						refundPercent: boundary === 'pre_checkin' ? 100 : 0,
						maxChargeNights: boundary === 'pre_checkin' ? 0 : 1,
						disclosure:
							boundary === 'pre_checkin'
								? 'Отмена до дня заезда — возврат 100% оплаты (ПП РФ 1912 п. 16).'
								: 'Отмена в день заезда или позже — удержание не более стоимости одних суток (ПП РФ 1912 п. 16).',
					},
					scope: session.scope,
				},
				200,
			)
		})
		.post(
			'/booking/guest-portal/:bookingId/cancel',
			zValidator('json', cancelInputSchema),
			async (c) => {
				const session = c.var.guestSession
				const requestedBookingId = c.req.param('bookingId')
				const input = c.req.valid('json')

				if (session.bookingId !== requestedBookingId) {
					return c.json(
						{
							error: {
								code: 'GUEST_SESSION_BOOKING_MISMATCH',
								message: 'Сессия привязана к другому бронированию.',
							},
						},
						403,
					)
				}

				if (session.scope !== 'mutate') {
					return c.json(
						{
							error: {
								code: 'GUEST_SESSION_SCOPE_INSUFFICIENT',
								message:
									'Для отмены требуется свежая ссылка с правом изменения. Запросите новую ссылку.',
							},
						},
						403,
					)
				}

				const view = await deps.repo.viewBooking(session.tenantId, session.bookingId)
				if (!view) {
					return c.json(
						{ error: { code: 'BOOKING_NOT_FOUND', message: 'Бронирование не найдено.' } },
						404,
					)
				}

				const boundary = computeCancelBoundary(view.checkIn, now())
				try {
					const cancelled = await deps.bookingService.cancel(
						session.tenantId,
						session.bookingId,
						{ reason: input.reason },
						GUEST_CANCEL_ACTOR,
					)
					if (!cancelled) {
						return c.json(
							{
								error: {
									code: 'BOOKING_CANCEL_FAILED',
									message: 'Бронирование не найдено или уже завершено.',
								},
							},
							404,
						)
					}
					c.header('Cache-Control', 'no-store')
					return c.json(
						{
							bookingId: cancelled.id,
							status: cancelled.status,
							cancelPolicy: {
								boundary,
								refundPercent: boundary === 'pre_checkin' ? 100 : 0,
								maxChargeNights: boundary === 'pre_checkin' ? 0 : 1,
							},
						},
						200,
					)
				} catch (err) {
					if (err instanceof Error) {
						return c.json(
							{
								error: {
									code: 'BOOKING_CANCEL_FAILED',
									message: err.message,
								},
							},
							409,
						)
					}
					throw err
				}
			},
		)
}
