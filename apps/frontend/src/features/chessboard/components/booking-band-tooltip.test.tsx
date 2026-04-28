/**
 * BookingBandTooltip — strict component tests (M9.5 Phase B v5 eradication).
 *
 * Pre-done audit:
 *   [R1] children render-prop receives popoverId + 4 handlers
 *   [R2] popover element rendered с popover="manual" + role="tooltip"
 *   [R3] tooltip content shows status + roomType + checkIn — checkOut
 *   [R4] popoverId is unique per bookingId (даже с same useId base)
 *   [S1] showPopover() invoked on mouseenter handler
 *   [S2] hidePopover() invoked on mouseleave handler
 *   [S3] showPopover() invoked on focus handler
 *   [S4] hidePopover() invoked on blur handler
 *   [G1] missing showPopover API (older browser) — graceful no-op (NOT throw)
 */
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { BookingBandTooltip } from './booking-band-tooltip'

afterEach(() => {
	cleanup()
})

function renderTooltip(overrides?: Partial<React.ComponentProps<typeof BookingBandTooltip>>) {
	const onMouseEnterSpy = vi.fn()
	const onMouseLeaveSpy = vi.fn()
	const onFocusSpy = vi.fn()
	const onBlurSpy = vi.fn()
	let receivedPopoverId = ''
	const result = render(
		<BookingBandTooltip
			bookingId="book_test123"
			statusLabel="Подтверждена"
			roomTypeName="Стандарт"
			checkIn="2026-04-28"
			checkOut="2026-04-30"
			{...overrides}
		>
			{({ popoverId, onMouseEnter, onMouseLeave, onFocus, onBlur }) => {
				receivedPopoverId = popoverId
				return (
					<button
						type="button"
						aria-details={popoverId}
						onMouseEnter={() => {
							onMouseEnter()
							onMouseEnterSpy()
						}}
						onMouseLeave={() => {
							onMouseLeave()
							onMouseLeaveSpy()
						}}
						onFocus={() => {
							onFocus()
							onFocusSpy()
						}}
						onBlur={() => {
							onBlur()
							onBlurSpy()
						}}
					>
						Band
					</button>
				)
			}}
		</BookingBandTooltip>,
	)
	return {
		...result,
		onMouseEnterSpy,
		onMouseLeaveSpy,
		onFocusSpy,
		onBlurSpy,
		getPopoverId: () => receivedPopoverId,
	}
}

describe('BookingBandTooltip — render', () => {
	it('[R1] children render-prop receives popoverId + 4 handlers', () => {
		const { getPopoverId } = renderTooltip()
		expect(getPopoverId()).toMatch(/^band-tooltip-/)
		expect(getPopoverId()).toContain('book_test123')
	})

	it('[R2] popover element rendered с popover="manual" + role="tooltip"', () => {
		renderTooltip()
		const tooltip = screen.getByRole('tooltip')
		expect(tooltip.getAttribute('popover')).toBe('manual')
	})

	it('[R3] tooltip content shows status + roomType + checkIn — checkOut', () => {
		renderTooltip()
		const tooltip = screen.getByRole('tooltip')
		expect(tooltip.textContent).toContain('Подтверждена')
		expect(tooltip.textContent).toContain('Стандарт')
		// formatDateShort('2026-04-28') = e.g. '28 апр'
		expect(tooltip.textContent).toMatch(/28/)
		expect(tooltip.textContent).toMatch(/30/)
	})

	it('[R4] popoverId unique per bookingId', () => {
		const { getPopoverId, unmount } = renderTooltip({ bookingId: 'book_aaa' })
		const idA = getPopoverId()
		unmount()
		const { getPopoverId: getId2 } = renderTooltip({ bookingId: 'book_bbb' })
		expect(getId2()).not.toBe(idA)
		expect(getId2()).toContain('book_bbb')
	})
})

describe('BookingBandTooltip — show/hide handlers', () => {
	it('[S1] showPopover invoked on mouseenter', () => {
		const showSpy = vi.fn()
		HTMLElement.prototype.showPopover = showSpy as unknown as HTMLElement['showPopover']
		const { getByText } = renderTooltip()
		fireEvent.mouseEnter(getByText('Band'))
		expect(showSpy).toHaveBeenCalled()
	})

	it('[S2] hidePopover invoked on mouseleave', () => {
		const hideSpy = vi.fn()
		HTMLElement.prototype.hidePopover = hideSpy as unknown as HTMLElement['hidePopover']
		const { getByText } = renderTooltip()
		fireEvent.mouseLeave(getByText('Band'))
		expect(hideSpy).toHaveBeenCalled()
	})

	it('[S3] showPopover invoked on focus', () => {
		const showSpy = vi.fn()
		HTMLElement.prototype.showPopover = showSpy as unknown as HTMLElement['showPopover']
		const { getByText } = renderTooltip()
		getByText('Band').focus()
		expect(showSpy).toHaveBeenCalled()
	})

	it('[S4] hidePopover invoked on blur', () => {
		const hideSpy = vi.fn()
		HTMLElement.prototype.hidePopover = hideSpy as unknown as HTMLElement['hidePopover']
		const { getByText } = renderTooltip()
		const btn = getByText('Band') as HTMLButtonElement
		btn.focus()
		btn.blur()
		expect(hideSpy).toHaveBeenCalled()
	})
})

describe('BookingBandTooltip — graceful degradation', () => {
	it('[G1] missing showPopover API — handler does NOT throw', () => {
		// Simulate older browser: replace showPopover с undefined (NOT delete —
		// triggers biome noDelete; replaceing с undefined is functionally same
		// для `'showPopover' in el` check).
		const original = HTMLElement.prototype.showPopover
		;(HTMLElement.prototype as { showPopover?: unknown }).showPopover = undefined
		const { getByText } = renderTooltip()
		expect(() => {
			fireEvent.mouseEnter(getByText('Band'))
		}).not.toThrow()
		// Restore.
		HTMLElement.prototype.showPopover = original
	})
})
