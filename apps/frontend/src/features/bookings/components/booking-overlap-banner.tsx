import { useAvailabilityCheck } from '../../chessboard/hooks/use-property-blocks'

/**
 * G9 (2026-05-16) — live overlap detection banner for booking-create-sheet.
 *
 * R1+R2 ≥ 2026-05-16 canon decisions:
 *   - 300ms debounce desktop / 500ms pointer:coarse mobile
 *   - inline banner above submit (Sheet body), NOT toast — operator must
 *     see it without losing focus on form fields (Cloudbeds canon)
 *   - `role="status"` (implicit aria-live="polite") — non-blocking screen-
 *     reader announcement (WCAG 2.2 SC 4.1.3)
 *   - submit NOT disabled на conflict — operator may force-book (Bnovo RU
 *     flex canon). Hard refusal lives at server (409 ROOM_OCCUPIED)
 *   - color tokens: amber (warning N=0 due к blocks) / red (no rooms total)
 *
 * Renders nothing when:
 *   - propertyId / roomTypeId / dates incomplete (no query yet)
 *   - query loading on initial mount (no flash)
 *   - availableCount > 0 (operator can proceed — no banner needed)
 */
interface BookingOverlapBannerProps {
	propertyId: string | null
	roomTypeId: string
	checkIn: string
	checkOut: string
}

export function BookingOverlapBanner(props: BookingOverlapBannerProps) {
	const availabilityQ = useAvailabilityCheck(
		props.propertyId,
		props.roomTypeId,
		props.checkIn,
		props.checkOut,
	)
	const data = availabilityQ.data
	if (!data) return null
	if (data.availableCount > 0) {
		// Positive feedback channel — non-noisy «N свободно» chip per Cloudbeds canon
		return (
			<p
				className="text-muted-foreground text-xs"
				role="status"
				aria-live="polite"
				data-slot="overlap-banner-ok"
				data-available-count={data.availableCount}
			>
				Свободных номеров на эти даты: {data.availableCount}
			</p>
		)
	}

	// availableCount === 0 — conflict path. Distinguish causes для operator UX.
	const blockedOnly = data.blockedCount > 0 && data.bookedCount === 0
	const bookedOnly = data.bookedCount > 0 && data.blockedCount === 0
	const both = data.bookedCount > 0 && data.blockedCount > 0

	let title = 'Нет свободных номеров'
	let detail = `Бронирований: ${data.bookedCount}, блокировок: ${data.blockedCount} из ${data.totalRooms}.`
	if (blockedOnly) {
		title = 'Все номера заблокированы для обслуживания'
		detail = `Блокировок: ${data.blockedCount} из ${data.totalRooms}. Снимите блокировку или выберите другие даты.`
	} else if (bookedOnly) {
		title = 'Все номера забронированы'
		detail = `Подтверждённых броней: ${data.bookedCount} из ${data.totalRooms}. Выберите другую категорию или даты.`
	} else if (both) {
		title = 'Нет свободных номеров'
	}

	// Amber (warning) когда blockedOnly — operator can resolve внутри системы.
	// Red (hard-block) когда any booking conflict — guest-facing problem.
	const palette = blockedOnly
		? 'bg-amber-50 border-amber-300 text-amber-900'
		: 'bg-red-50 border-red-300 text-red-900'

	return (
		<div
			className={`rounded-md border p-3 text-sm ${palette}`}
			role="status"
			aria-live="polite"
			data-slot="overlap-banner-conflict"
			data-blocked-count={data.blockedCount}
			data-booked-count={data.bookedCount}
			data-total-rooms={data.totalRooms}
		>
			<p className="font-medium">{title}</p>
			<p className="mt-0.5 text-xs">{detail}</p>
		</div>
	)
}
