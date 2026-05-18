import { computePosition, flip, offset, shift } from '@floating-ui/dom'
import { useId } from 'react'
import { createPortal } from 'react-dom'
import { formatDayOnly } from '@/lib/format-ru'

interface PopoverHandlers {
	popoverId: string
	onMouseEnter: (e: React.MouseEvent<HTMLElement>) => void
	onMouseLeave: () => void
	onFocus: (e: React.FocusEvent<HTMLElement>) => void
	onBlur: () => void
}

interface Props {
	bookingId: string
	statusLabel: string
	roomTypeName: string
	checkIn: string
	checkOut: string
	/** G2.bis: optional channel-origin label (e.g. «Канал: Yandex.Путешествия») —
	 * rendered ниже dates когда не null. Matches the visual channel-dot
	 * indicator на the band, giving screen-reader + hover users equal access. */
	channelLabel?: string | null
	/** G4: full guest name (no mask) — tooltip is operator-only hover, OK to
	 * un-mask here. Per 152-ФЗ default-mask canon: band visible-text uses
	 * `maskGuestNameRu()`, but tooltip on intentional hover/focus exposes full
	 * identity for operator action. */
	guestFullName?: string | null
	/** G4: МВД lifecycle label (e.g. «МУ не подан»). Null for RU citizens или
	 * `notRequired` state (caller omits via `registrationBadgeFor()` returning
	 * null). Surface as actionable urgency cue. */
	mvdLabel?: string | null
	/** G4: tourism tax amount (Сочи 2%, e.g. «120 ₽»). Null когда сумма ноль
	 * или booking cancelled (caller pre-filters). */
	taxRub?: string | null
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
 *   - Click band → opens BookingEditSheet (existing canonical action)
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
	channelLabel,
	guestFullName,
	mvdLabel,
	taxRub,
	children,
}: Props) {
	const popoverId = `band-tooltip-${useId().replace(/:/g, '-')}-${bookingId}`

	// G11 v3.6 (2026-05-18) — Anchor tooltip к trigger via Floating UI.
	// Pre-fix: native `[popover]` без anchor positioning defaults к top-left of
	// viewport (HTML spec). Tooltip appeared в corner regardless of band
	// location. Empirically caught когда user hovered band, saw text floating
	// over sidebar.
	//
	// Floating UI canon 2026 (per @floating-ui/dom 1.7.x docs): computePosition
	// returns x/y relative к offsetParent; combined with `position: fixed` +
	// margin:0 reset, places popover correctly. middleware:
	//   - offset(6): 6px gap from band
	//   - flip(): switch к bottom если top runs out of viewport
	//   - shift({padding:8}): keep within viewport edges
	const showPopover = (trigger: HTMLElement | null) => {
		const el = document.getElementById(popoverId) as HTMLElement | null
		if (!el || typeof el.showPopover !== 'function') return
		// Show synchronously first (popover API needs to be шоw'n к compute
		// dimensions для Floating UI). Position async after Promise resolves.
		try {
			el.showPopover()
		} catch {
			/* already-shown */
		}
		if (!trigger) return
		void computePosition(trigger, el, {
			placement: 'top',
			middleware: [offset(6), flip(), shift({ padding: 8 })],
			strategy: 'fixed',
		}).then(({ x, y }) => {
			el.style.position = 'fixed'
			el.style.margin = '0'
			el.style.left = `${x}px`
			el.style.top = `${y}px`
		})
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
			{guestFullName ? (
				<div className="font-medium" data-slot="tooltip-guest">
					{guestFullName}
				</div>
			) : null}
			<div className={guestFullName ? 'text-muted-foreground mt-1 text-[10px]' : 'font-medium'}>
				{statusLabel}
			</div>
			<div className="text-muted-foreground mt-1">{roomTypeName}</div>
			<div className="text-muted-foreground mt-1">
				<time dateTime={checkIn}>{formatDayOnly(checkIn)}</time>
				{' — '}
				<time dateTime={checkOut}>{formatDayOnly(checkOut)}</time>
			</div>
			{channelLabel ? (
				<div className="text-muted-foreground mt-1 text-[10px]">{channelLabel}</div>
			) : null}
			{mvdLabel ? (
				<div className="text-foreground mt-1 text-[10px]" data-slot="tooltip-mvd">
					{mvdLabel}
				</div>
			) : null}
			{taxRub ? (
				<div className="text-muted-foreground mt-1 text-[10px]" data-slot="tooltip-tax">
					Туристический налог: {taxRub}
				</div>
			) : null}
		</div>
	)

	return (
		<>
			{children({
				popoverId,
				onMouseEnter: (e) => showPopover(e.currentTarget),
				onMouseLeave: hidePopover,
				onFocus: (e) => showPopover(e.currentTarget),
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
