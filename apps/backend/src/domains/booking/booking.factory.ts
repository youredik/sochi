import type { sql as SQL } from '../../db/index.ts'
import type { TimeProvider } from '../../lib/time-provider.ts'
import type { GuestDocumentRepo } from '../guest/guest-document.repo.ts'
import type { PropertyService } from '../property/property.service.ts'
import type { RateRepo } from '../rate/rate.repo.ts'
import type { RatePlanService } from '../ratePlan/ratePlan.service.ts'
import type { RoomService } from '../room/room.service.ts'
import type { RoomTypeService } from '../roomType/roomType.service.ts'
import type { TenantComplianceRepo } from '../tenant/compliance.repo.ts'
import { createBookingRepo } from './booking.repo.ts'
import { createBookingService } from './booking.service.ts'

type SqlInstance = typeof SQL

export function createBookingFactory(
	sql: SqlInstance,
	rateRepo: RateRepo,
	propertyService: PropertyService,
	roomTypeService: RoomTypeService,
	ratePlanService: RatePlanService,
	// G8 (2026-05-16) — roomService added для assign-room + auto-assign
	// operations. Optional с default undefined for backward-compat wiring
	// в old call-sites; new endpoints check at runtime and throw if missing.
	roomService?: RoomService,
	// Clock 2026-05-18 — service-boundary TimeProvider for state-transition
	// timestamps. Default = `realTimeProvider` (wall clock). Seed scripts +
	// integration tests pass `frozenTimeProvider(date)` for determinism.
	// Per Stripe Test Clocks canon — clock-at-boundary, not global mock.
	clock?: TimeProvider,
	// Sprint C+ Round 6 Legal P0 fix 2026-05-24 — ПП-1951 КСР hard-gate.
	// Optional с default undefined for backward-compat tests; production
	// app.ts wires it. Когда unset, service.create skips gate (test mode).
	complianceRepo?: TenantComplianceRepo,
	// Sprint C+ Round 7 Senior P0 fix 2026-05-24 — 109-ФЗ ст. 22 passport-scan
	// hard-gate. Optional default undefined for tests; production app.ts wires.
	// Когда unset, service.checkIn skips gate (test mode only).
	guestDocumentRepo?: GuestDocumentRepo,
) {
	const repo = createBookingRepo(sql, clock)
	const service = createBookingService(
		repo,
		rateRepo,
		propertyService,
		roomTypeService,
		ratePlanService,
		roomService,
		complianceRepo,
		guestDocumentRepo,
	)
	return { repo, service }
}

export type BookingFactory = ReturnType<typeof createBookingFactory>
