/**
 * Widget booking-create factory — wires existing service composition for
 * public widget Screen 3 commit.
 *
 * Per `plans/m9_widget_4_canonical.md` §3 — reuses existing factories:
 *   - widgetService (from createWidgetFactory)
 *   - guestService (from createGuestFactory)
 *   - bookingService (from createBookingFactory)
 *   - paymentService (from createPaymentFactory)
 *
 * No new repos, no schema changes. Pure composition.
 */
import type { sql as SQL } from '../../db/index.ts'
import type { BookingService } from '../booking/booking.service.ts'
import type { GuestService } from '../guest/guest.service.ts'
import type { PaymentService } from '../payment/payment.service.ts'
import { createWidgetBookingCreateService } from './booking-create.service.ts'
import type { WidgetService } from './widget.service.ts'

type SqlInstance = typeof SQL

export function createWidgetBookingCreateFactory(deps: {
	sql: SqlInstance
	widgetService: WidgetService
	guestService: GuestService
	bookingService: BookingService
	paymentService: PaymentService
}) {
	const service = createWidgetBookingCreateService({
		widgetService: deps.widgetService,
		guestService: deps.guestService,
		bookingService: deps.bookingService,
		paymentService: deps.paymentService,
		sql: deps.sql,
	})
	return { service }
}
