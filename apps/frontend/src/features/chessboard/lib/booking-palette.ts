import type {
	BookingChannelCode,
	BookingGuestSnapshot,
	BookingRegistrationStatus,
	BookingStatus,
} from '@horeca/shared'
// G4.bis (2026-05-15) — `isRussianCitizenship` extracted to shared (canonical
// home: domain concept, not chessboard-specific). Re-exported here for
// existing test import-sites + co-located callers.
import { isRussianCitizenship } from '@horeca/shared'
export { isRussianCitizenship }

/**
 * Booking-status → cell display classes (M9.5 Phase B Bnovo-parity + G2
 * TravelLine 8-color canon extension 2026-05-15).
 *
 * Token-based palette via index.css `--status-*` tokens × `--color-status-*`
 * @theme inline binding. Tailwind v4 utility classes (`bg-status-confirmed`
 * etc.) resolve через CSS-каскад → :root / .dark / @media prefers-contrast,
 * НЕ hardcoded Tailwind neutral palette.
 *
 * **Mapping** (5 domain statuses + 2 UI-derived):
 *   - confirmed   → status-confirmed (green) — pre-arrival booked
 *   - in_house    → status-occupied (Sochi-blue) — guest currently in-house
 *   - checked_out → status-past (grey) — completed stays
 *   - cancelled   → status-past (grey + line-through) — financial trail kept
 *   - no_show     → status-issue (red) — exception requiring action
 *
 * **UI-derived states (computed in `paletteFor()`, NOT domain enum)**:
 *   - overdue     → status-issue (red) + label «Просрочена» — `checkIn <
 *                   today AND status='confirmed'`. Operator must check-in
 *                   ASAP OR mark no-show.
 *   - unassigned  → status-unassigned (turquoise/teal) — `assignedRoomId
 *                   === null AND status='confirmed'`. Operator must assign
 *                   a specific room ДО check-in.
 *
 * **TravelLine 8-color canon** (research май 2026 — RU staff trained on
 * this palette): Green direct / Yellow OTA / Purple in-house / Orange
 * checked-out / Red overdue / Turquoise unassigned / Grey OOO / Light-grey
 * filtered. Our mapping condenses domain semantically:
 *   - Direct + manual + OTA: same `confirmed` until check-in (channel-color
 *     differentiation deferred к G2.bis — separate visual layer, не bg)
 *   - Purple in-house = our occupied (blue) — Сочи-brand variant of in-house
 *   - Orange checked-out = our past — RU operators tolerate grey
 *   - Grey OOO maintenance = separate domain (G9 deferred — needs backend)
 *   - Light-grey filtered = UI filter state (separate concern)
 *
 * **Precedence rule (UI-derived ↓ domain)**: terminal statuses (cancelled /
 * checked_out / no_show) ALWAYS win — historical correctness over urgency
 * cues. For `confirmed`, overdue takes priority over unassigned (operator
 * action: check-in first, then assign room). For `in_house`, no derived
 * overrides — guest already in-house.
 *
 * **Theme-aware contrast** verified ≥4.5:1 WCAG 2.2 AA empirically via
 * @axe-core/playwright (light + dark + contrast-more — 12 combinations).
 * status-unassigned token added 2026-05-15 with same canon (4.5:1 AA
 * normal-text per `index.css` L=0.45 light / L=0.7 dark / L=0.4 + L=0.78
 * для contrast-more).
 *
 * Pure data structure (NOT JSX) — unit-testable + reusable + memoization-safe.
 */

interface CellStyle {
	readonly bg: string
	readonly text: string
	readonly label: string
}

export const BOOKING_CELL_STYLES: Readonly<Record<BookingStatus, CellStyle>> = {
	confirmed: {
		bg: 'bg-status-confirmed hover:brightness-95',
		text: 'text-status-confirmed-foreground',
		label: 'Подтверждена',
	},
	in_house: {
		bg: 'bg-status-occupied hover:brightness-95',
		text: 'text-status-occupied-foreground',
		label: 'В проживании',
	},
	checked_out: {
		bg: 'bg-status-past hover:brightness-95',
		text: 'text-status-past-foreground',
		label: 'Выехал',
	},
	cancelled: {
		bg: 'bg-status-past line-through hover:brightness-95',
		text: 'text-status-past-foreground',
		label: 'Отменена',
	},
	no_show: {
		bg: 'bg-status-issue hover:brightness-95',
		text: 'text-status-issue-foreground',
		label: 'Не заехал',
	},
}

/**
 * UI-derived styles (NOT in domain BookingStatus enum). Same shape as
 * BOOKING_CELL_STYLES so `paletteFor()` returns a uniform CellStyle.
 *   - overdue reuses status-issue red token (semantically «action required»
 *     overlaps с no_show) — label distinguishes domain context.
 *   - unassigned uses new status-unassigned turquoise token (G2 addition).
 */
export const DERIVED_BOOKING_CELL_STYLES: Readonly<Record<'overdue' | 'unassigned', CellStyle>> = {
	overdue: {
		bg: 'bg-status-issue hover:brightness-95',
		text: 'text-status-issue-foreground',
		label: 'Просрочена',
	},
	unassigned: {
		bg: 'bg-status-unassigned hover:brightness-95',
		text: 'text-status-unassigned-foreground',
		label: 'Не распределена',
	},
}

export function styleFor(status: BookingStatus): CellStyle {
	return BOOKING_CELL_STYLES[status]
}

/**
 * `paletteFor` — derived palette computation. Combines domain status с
 * UI-derived overlays (overdue / unassigned) per TravelLine 8-color canon.
 *
 * Precedence (top-down — first match wins):
 *   1. Terminal status (cancelled / checked_out / no_show) → domain palette.
 *      Historical correctness over urgency cues.
 *   2. confirmed + checkIn < today → overdue (red) — operator urgency #1.
 *   3. confirmed + assignedRoomId == null → unassigned (turquoise) —
 *      operator urgency #2.
 *   4. confirmed (assigned, on-time) → domain palette (green).
 *   5. in_house → domain palette (blue). No derived overlay — guest already
 *      checked in, both checks irrelevant.
 *
 * Pure function — caller passes `todayIso` для testable date-comparison.
 */
/**
 * G2.bis (2026-05-15) — channel-color indicator differentiator per TravelLine
 * 8-color canon. RU staff already trained: yandexTravel red-orange dot
 * (Сочи market leader, distinct from generic OTA) vs other-channels yellow
 * dot (Booking.com / Ostrovok / Expedia / Airbnb / Bnovo / TravelLine CM).
 *
 * Direct + walkIn channels: no indicator (operator-originated bookings
 * are the «default» context).
 *
 * Returns `null` для no-indicator channels (decorative absence is
 * meaningful — no clutter on the majority of bookings).
 */
export interface ChannelIndicator {
	readonly dotClass: string
	readonly label: string
}

export function channelIndicator(channelCode: BookingChannelCode): ChannelIndicator | null {
	switch (channelCode) {
		case 'direct':
		case 'walkIn':
			return null
		case 'yandexTravel':
			return {
				dotClass: 'bg-channel-yandex',
				label: 'Канал: Yandex.Путешествия',
			}
		// Generic OTA bucket — TravelLine + Bnovo channel managers + Booking.com
		// + Expedia + Ostrovok + Airbnb. All yellow per TravelLine canon. Future
		// differentiator differentiation possible if SMB operators demand.
		case 'bnovo':
		case 'travelLine':
		case 'bookingCom':
		case 'expedia':
		case 'ostrovok':
		case 'airbnb':
			return {
				dotClass: 'bg-channel-ota',
				label: `Канал: ${labelForChannelCode(channelCode)}`,
			}
	}
}

/**
 * G4 (2026-05-15) — 152-ФЗ default mask helper. Шахматка band shows guest
 * identification mask «Фамилия И.» (last name + first-name initial + dot)
 * BY DEFAULT, full name only inside side-Sheet edit panel. Per `[[ru-legal-
 * canonical]]` 152-ФЗ Статья 7 + canonical industry (Mews / Cloudbeds /
 * Apaleo) — screen-share / open-area front-desk monitor accidentally
 * leaks PII without this canon.
 *
 * **Pure** (no Intl / locale dep): RU lastName + firstName always Cyrillic
 * per `bookingGuestSnapshotSchema` (no validation on alphabet, but data
 * arrives Cyrillic from operator entry + ОФД канон).
 *
 * Returns the full mask string. Caller decides whether to render `mask`
 * (default visible) или `${lastName} ${firstName}` (operator action — full
 * name reveal). Edge case: if firstName is empty (allowed by domain since
 * .min(1) — but defensive — defensive code keeps mask robust for migration
 * legacy rows): return lastName alone.
 */
export function maskGuestNameRu(
	snapshot: Pick<BookingGuestSnapshot, 'firstName' | 'lastName'>,
): string {
	const last = snapshot.lastName.trim()
	const first = snapshot.firstName.trim()
	if (first.length === 0) return last
	return `${last} ${first.charAt(0).toUpperCase()}.`
}

/**
 * G4 (2026-05-15) — Туристический налог chip formatter. Server stores tax
 * в `tourismTaxMicros` (micros = ₽ × 10^6 per `[[m6-folio-money-canon]]`).
 * Convert к whole rubles for compact band chip. Skip rendering chip if
 * micros === 0n (e.g. cancelled bookings where tax was reversed).
 *
 * **Pure**, accepts bigint OR string (BigInt#toJSON patch на backend
 * serializes как строка); pre-coerces к bigint for safe div.
 *
 * Returns null for zero amounts (callers omit chip when null per Cloudbeds
 * «no zero-clutter» canon).
 */
export function formatTourismTaxRub(micros: bigint | string | number): string | null {
	const asBig =
		typeof micros === 'bigint'
			? micros
			: typeof micros === 'number'
				? BigInt(micros)
				: BigInt(micros)
	if (asBig === 0n) return null
	// Round to nearest whole rub (half-up): (micros + 5*10^5) / 10^6
	const rounded = (asBig + 500_000n) / 1_000_000n
	return `${rounded.toString()} ₽`
}

/**
 * G4 (2026-05-15) — МВД registration lifecycle badge. Renders ONLY для
 * non-RU guests (citizenship !== 'RU') per Боль 1.1 canon — RU citizens
 * не требуют МВД registration в this domain.
 *
 * Color semantics (each token already axe-verified ≥3:1 non-text per WCAG
 * 2.2 SC 1.4.11):
 *   - notRequired: null (caller omits — RU guest fallback handled by callsite)
 *   - pending:     status-issue (red) — operator must submit ДО deadline
 *   - submitted:   status-confirmed (green) — awaiting МВД ack
 *   - registered:  status-occupied (blue) — terminal success
 *   - failed:      status-issue (red) — re-submit required, blocks check-in
 *
 * **Pure**. Returns `null` when no badge required (RU citizen ИЛИ
 * `notRequired` enum). Caller does final render decision.
 */
export interface RegistrationBadge {
	readonly dotClass: string
	readonly label: string
	readonly urgent: boolean
}

export function registrationBadgeFor(
	status: BookingRegistrationStatus,
	citizenship: string,
): RegistrationBadge | null {
	if (isRussianCitizenship(citizenship)) return null
	switch (status) {
		case 'notRequired':
			return null
		case 'pending':
			return { dotClass: 'bg-status-issue', label: 'МУ не подан', urgent: true }
		case 'submitted':
			return { dotClass: 'bg-status-confirmed', label: 'МУ отправлен', urgent: false }
		case 'registered':
			return { dotClass: 'bg-status-occupied', label: 'МУ принят МВД', urgent: false }
		case 'failed':
			return { dotClass: 'bg-status-issue', label: 'МУ отклонён — повторите', urgent: true }
	}
}

function labelForChannelCode(channelCode: BookingChannelCode): string {
	switch (channelCode) {
		case 'direct':
			return 'Прямое бронирование'
		case 'walkIn':
			return 'Front desk'
		case 'yandexTravel':
			return 'Yandex.Путешествия'
		case 'ostrovok':
			return 'Ostrovok'
		case 'travelLine':
			return 'TravelLine'
		case 'bnovo':
			return 'Bnovo'
		case 'bookingCom':
			return 'Booking.com'
		case 'expedia':
			return 'Expedia'
		case 'airbnb':
			return 'Airbnb'
	}
}

export function paletteFor(ctx: {
	booking: {
		status: BookingStatus
		checkIn: string
		assignedRoomId?: string | null
	}
	todayIso: string
}): CellStyle {
	const { booking, todayIso } = ctx

	// Terminal statuses always win — domain correctness over UI urgency.
	if (
		booking.status === 'cancelled' ||
		booking.status === 'checked_out' ||
		booking.status === 'no_show'
	) {
		return BOOKING_CELL_STYLES[booking.status]
	}

	// In-house has no derived overlays (guest already checked in).
	if (booking.status === 'in_house') {
		return BOOKING_CELL_STYLES.in_house
	}

	// `confirmed` — apply UI-derived overlays (overdue > unassigned).
	if (booking.checkIn < todayIso) {
		return DERIVED_BOOKING_CELL_STYLES.overdue
	}
	if (booking.assignedRoomId == null) {
		return DERIVED_BOOKING_CELL_STYLES.unassigned
	}
	return BOOKING_CELL_STYLES.confirmed
}
