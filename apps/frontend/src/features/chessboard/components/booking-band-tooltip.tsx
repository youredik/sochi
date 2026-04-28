import { useId } from 'react'
import { createPortal } from 'react-dom'
import { formatDateShort } from '@/lib/format-ru'

interface PopoverHandlers {
	popoverId: string
	onMouseEnter: () => void
	onMouseLeave: () => void
	onFocus: () => void
	onBlur: () => void
}

interface Props {
	bookingId: string
	statusLabel: string
	roomTypeName: string
	checkIn: string
	checkOut: string
	children: (handlers: PopoverHandlers) => React.ReactNode
}

/**
 * BookingBandTooltip — native HTML `[popover]` API tooltip над booking band.
 *
 * **2026 Baseline canonical (Chrome 114+, Firefox 125+, Safari 17+):**
 *   - `popover="manual"` — programmatic show/hide (no click-toggle conflict
 *     с canonical click-to-edit на band button)
 *   - role="tooltip" + aria-details on trigger — screen-reader announce
 *   - Trigger через mouseenter/focus, hide через mouseleave/blur
 *
 * **UX canon** (eradicates prior «click-conflict» reasoning that deferred):
 *   - Click band → opens BookingEditDialog (existing canonical action)
 *   - Hover/focus band → shows tooltip с guest details (NEW Phase B)
 *   - Two interaction modes don't overlap; native popover preserves
 *     screen-reader announcement
 *
 * **Render-prop pattern** — child receives handlers + popoverId, applies
 * directly к interactive element (button) — biome a11y rules satisfied.
 *
 * **Why native vs Radix Tooltip:**
 *   - Plan §M9.3 explicit canon: native popover для booking-tooltip
 *   - Native popover на top-layer (above sticky col headers без z-index)
 *   - Lighter bundle, modern HTML-first 2026 stack
 */
export function BookingBandTooltip({
	bookingId,
	statusLabel,
	roomTypeName,
	checkIn,
	checkOut,
	children,
}: Props) {
	const popoverId = `band-tooltip-${useId().replace(/:/g, '-')}-${bookingId}`

	const showPopover = () => {
		const el = document.getElementById(popoverId) as HTMLElement | null
		if (el && typeof el.showPopover === 'function') {
			try {
				el.showPopover()
			} catch {
				/* already-shown OR popover API unsupported */
			}
		}
	}
	const hidePopover = () => {
		const el = document.getElementById(popoverId) as HTMLElement | null
		if (el && typeof el.hidePopover === 'function') {
			try {
				el.hidePopover()
			} catch {
				/* already-hidden */
			}
		}
	}

	const tooltip = (
		<div
			id={popoverId}
			popover="manual"
			role="tooltip"
			className="bg-popover text-popover-foreground border-border rounded-md border p-3 text-xs shadow-popover"
		>
			<div className="font-medium">{statusLabel}</div>
			<div className="text-muted-foreground mt-1">{roomTypeName}</div>
			<div className="text-muted-foreground mt-1">
				<time dateTime={checkIn}>{formatDateShort(checkIn)}</time>
				{' — '}
				<time dateTime={checkOut}>{formatDateShort(checkOut)}</time>
			</div>
		</div>
	)

	return (
		<>
			{children({
				popoverId,
				onMouseEnter: showPopover,
				onMouseLeave: hidePopover,
				onFocus: showPopover,
				onBlur: hidePopover,
			})}
			{/* Portal к document.body — escapes role="row" parent so axe
			 * `aria-required-children` is satisfied (rows only allow gridcell/
			 * rowheader/columnheader children). Native popover API already
			 * elevates render-layer к top-layer, but ARIA tree placement
			 * matters; portal aligns с screen-reader tree expectations. */}
			{typeof document !== 'undefined' ? createPortal(tooltip, document.body) : null}
		</>
	)
}
