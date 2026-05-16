import { useState } from 'react'
import { Button } from '@/components/ui/button'
import {
	ResponsiveSheet,
	ResponsiveSheetContent,
	ResponsiveSheetDescription,
	ResponsiveSheetFooter,
	ResponsiveSheetHeader,
	ResponsiveSheetTitle,
} from '@/components/ui/responsive-sheet'
import { useRoomTypes } from '../../bookings/hooks/use-booking-mutations'
import {
	useAutoAssignUnassigned,
	useUnassignedBookings,
} from '../../bookings/hooks/use-booking-transitions'
import { maskGuestNameRu } from '../lib/booking-palette'

/**
 * G8 (2026-05-16) — Unassigned Reservations panel + auto-assign trigger.
 *
 * Per Cloudbeds 2026 canon + R1+R2 ≥ 2026-05-16 research-agent D-G8.1..12:
 *
 *   - **D-G8.1**: top-left position в grid header
 *   - **D-G8.2**: orange-dot 12px + count chip когда N>0; HIDDEN when N=0
 *     с `role="status" aria-live="polite"` per WCAG 2.2 SC 4.1.3
 *   - **D-G8.3**: click → ResponsiveSheet (desktop right-panel / mobile
 *     bottom-drawer) с list sorted by checkIn ASC then createdAt ASC
 *   - **D-G8.9**: «Авто-распределить (N)» button в Sheet header
 *   - **D-G8.10**: polling refetchInterval 5s (handled by useUnassignedBookings)
 *   - **D-G8.11**: keyboard alternative через ActionView amend (operator
 *     clicks list-row «Открыть» → grid-band open в edit sheet с
 *     «Назначить номер» amend dialog visible only когда confirmed)
 *
 * Click flow: panel → list-sheet → operator clicks per-row → grid scrolls
 * к that band + opens existing BookingEditSheet (через onOpenBooking
 * callback wired by chessboard.tsx). Reuses existing amend canon.
 */
interface UnassignedPanelProps {
	propertyId: string | null
	windowFrom: string
	windowTo: string
	onOpenBooking: (bookingId: string) => void
}

export function UnassignedPanel(props: UnassignedPanelProps) {
	const unassignedQ = useUnassignedBookings(props.propertyId)
	const roomTypesQ = useRoomTypes(props.propertyId)
	const autoAssign = useAutoAssignUnassigned({
		propertyId: props.propertyId,
		windowFrom: props.windowFrom,
		windowTo: props.windowTo,
	})
	const [listOpen, setListOpen] = useState(false)

	const items = unassignedQ.data ?? []
	const count = items.length
	// Lookup map для roomType.name display.
	const roomTypeNameById = new Map((roomTypesQ.data ?? []).map((rt) => [rt.id, rt.name]))

	// HIDE entirely when N=0 (Cloudbeds no-zero-clutter canon, D-G8.2).
	if (count === 0) {
		// Still emit aria-live region (with empty body) — screen readers
		// announce «зеро» когда переход с N>0 к N=0 (assignment success).
		return (
			<span
				role="status"
				aria-live="polite"
				aria-label="Нераспределённых броней нет"
				className="sr-only"
				data-slot="unassigned-panel-empty"
			/>
		)
	}

	return (
		<>
			<Button
				type="button"
				variant="outline"
				size="sm"
				onClick={() => setListOpen(true)}
				className="border-status-issue/40 bg-status-issue/10 hover:bg-status-issue/15 relative gap-2"
				aria-label={`Нераспределённых броней: ${count}. Открыть список.`}
				data-slot="unassigned-panel-trigger"
				data-unassigned-count={count}
			>
				{/* Orange-dot indicator per Cloudbeds canon (D-G8.2). 12px circle. */}
				<span aria-hidden="true" className="bg-status-issue inline-block size-3 rounded-full" />
				<span>Нераспределённые</span>
				<span
					role="status"
					aria-live="polite"
					className="bg-status-issue text-status-issue-foreground inline-flex h-5 min-w-5 items-center justify-center rounded-full px-1.5 text-xs font-medium"
					data-slot="unassigned-count-badge"
				>
					{count}
				</span>
			</Button>

			<ResponsiveSheet open={listOpen} onOpenChange={setListOpen}>
				<ResponsiveSheetContent side="right" className="sm:max-w-md overflow-y-auto">
					<ResponsiveSheetHeader>
						<ResponsiveSheetTitle>Нераспределённые брони ({count})</ResponsiveSheetTitle>
						<ResponsiveSheetDescription>
							Назначьте каждой брони конкретный номер, или используйте авто-распределение.
						</ResponsiveSheetDescription>
					</ResponsiveSheetHeader>

					{/* D-G8.9 auto-assign primary button. Disabled mid-mutation. */}
					<div className="mt-3 mb-3" data-slot="unassigned-auto-assign-wrap">
						<Button
							type="button"
							variant="default"
							className="w-full"
							disabled={autoAssign.isPending}
							onClick={() => autoAssign.mutate()}
							data-slot="unassigned-auto-assign-button"
						>
							{autoAssign.isPending ? 'Распределяем…' : `Авто-распределить (${count})`}
						</Button>
					</div>

					<ul
						className="space-y-2"
						data-slot="unassigned-list"
						aria-label="Список нераспределённых броней"
					>
						{items.map((b) => {
							// G4 (2026-05-15) 152-ФЗ default-mask canon — show
							// «Фамилия И.» даже в operator list view. Full name
							// only inside booking-edit-sheet tooltip / dialog.
							const guestMask = b.guestSnapshot ? maskGuestNameRu(b.guestSnapshot) : '—'
							const roomTypeName = roomTypeNameById.get(b.roomTypeId) ?? '—'
							return (
								<li
									key={b.id}
									className="border-border flex items-center justify-between gap-2 rounded-md border p-3"
									data-slot="unassigned-list-item"
									data-booking-id={b.id}
								>
									<div className="min-w-0 flex-1 text-sm">
										<div className="font-medium truncate" data-slot="unassigned-list-guest">
											{guestMask}
										</div>
										<div
											className="text-muted-foreground text-xs truncate"
											data-slot="unassigned-list-meta"
										>
											{roomTypeName} · {b.checkIn} — {b.checkOut}
										</div>
									</div>
									<Button
										type="button"
										variant="outline"
										size="sm"
										onClick={() => {
											setListOpen(false)
											props.onOpenBooking(b.id)
										}}
										data-slot="unassigned-open-button"
										aria-label={`Открыть бронь ${guestMask}, ${roomTypeName}, ${b.checkIn} — ${b.checkOut}`}
									>
										Открыть
									</Button>
								</li>
							)
						})}
					</ul>

					<ResponsiveSheetFooter>
						<Button type="button" variant="outline" onClick={() => setListOpen(false)}>
							Закрыть
						</Button>
					</ResponsiveSheetFooter>
				</ResponsiveSheetContent>
			</ResponsiveSheet>
		</>
	)
}
