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
import { afterEach, describe, expect, it, mock } from 'bun:test'
import { BookingBandTooltip } from './booking-band-tooltip'

afterEach(() => {
	cleanup()
})

function renderTooltip(overrides?: Partial<React.ComponentProps<typeof BookingBandTooltip>>) {
	const onMouseEnterSpy = mock()
	const onMouseLeaveSpy = mock()
	const onFocusSpy = mock()
	const onBlurSpy = mock()
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
		// formatDayOnly('2026-04-28') = "28.04.2026"; no time component.
		expect(tooltip.textContent).toMatch(/28\.04\.2026/)
		expect(tooltip.textContent).toMatch(/30\.04\.2026/)
		expect(tooltip.textContent).not.toMatch(/\d{1,2}:\d{2}/)
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
		const showSpy = mock()
		HTMLElement.prototype.showPopover = showSpy as unknown as HTMLElement['showPopover']
		const { getByText } = renderTooltip()
		fireEvent.mouseEnter(getByText('Band'))
		expect(showSpy).toHaveBeenCalled()
	})

	it('[S2] hidePopover invoked on mouseleave', () => {
		const hideSpy = mock()
		HTMLElement.prototype.hidePopover = hideSpy as unknown as HTMLElement['hidePopover']
		const { getByText } = renderTooltip()
		fireEvent.mouseLeave(getByText('Band'))
		expect(hideSpy).toHaveBeenCalled()
	})

	it('[S3] showPopover invoked on focus', () => {
		const showSpy = mock()
		HTMLElement.prototype.showPopover = showSpy as unknown as HTMLElement['showPopover']
		const { getByText } = renderTooltip()
		getByText('Band').focus()
		expect(showSpy).toHaveBeenCalled()
	})

	it('[S4] hidePopover invoked on blur', () => {
		const hideSpy = mock()
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

// ---------------------------------------------------------------------------
// G4.bis (2026-05-15) — RU compliance overlay tooltip extension.
// Pre-done audit:
//   [G4-T1] guestFullName когда non-null рендерится в font-medium слот первой
//           линии (152-ФЗ unmask на operator-intentional hover)
//   [G4-T2] statusLabel demoted к secondary line когда guestFullName present
//   [G4-T3] guestFullName == null → statusLabel остаётся в primary (font-
//           medium) — backward-compat когда snapshot отсутствует
//   [G4-T4] mvdLabel non-null → secondary line с data-slot="tooltip-mvd"
//   [G4-T5] taxRub non-null → secondary line «Туристический налог: X ₽»
//   [G4-T6] mvdLabel + taxRub == null → НИ ОДНОЙ tooltip-mvd / tooltip-tax
//           линии (no zero-clutter canon)
//   [G4-T7] visual hierarchy preserved — guest → status → roomType → dates →
//           channel → МВД → налог (exact DOM order)
// ---------------------------------------------------------------------------

describe('BookingBandTooltip — G4.bis RU compliance overlay', () => {
	it('[G4-T1] guestFullName non-null → first font-medium line «Иванов Иван Иванович»', () => {
		renderTooltip({ guestFullName: 'Иванов Иван Иванович' })
		const guest = screen.getByText('Иванов Иван Иванович')
		expect(guest.getAttribute('data-slot')).toBe('tooltip-guest')
		expect(guest.className).toContain('font-medium')
	})

	it('[G4-T2] guestFullName present → statusLabel demoted к secondary', () => {
		renderTooltip({ guestFullName: 'Иванов И. И.' })
		const status = screen.getByText('Подтверждена')
		// muted-foreground + text-[10px] = secondary slot
		expect(status.className).toContain('text-muted-foreground')
		expect(status.className).toContain('text-[10px]')
	})

	it('[G4-T3] guestFullName == null → statusLabel остаётся primary (font-medium)', () => {
		renderTooltip() // no guestFullName
		const status = screen.getByText('Подтверждена')
		expect(status.className).toContain('font-medium')
		expect(status.className).not.toContain('text-muted-foreground')
	})

	it('[G4-T4] mvdLabel non-null → secondary line с data-slot tooltip-mvd', () => {
		renderTooltip({ mvdLabel: 'МУ не подан' })
		const mvd = screen.getByText('МУ не подан')
		expect(mvd.getAttribute('data-slot')).toBe('tooltip-mvd')
	})

	it('[G4-T5] taxRub non-null → secondary line «Туристический налог: X»', () => {
		renderTooltip({ taxRub: `120${' '}₽` })
		// regex matches «Туристический налог: » prefix
		const tax = screen.getByText(/Туристический налог:/)
		expect(tax.getAttribute('data-slot')).toBe('tooltip-tax')
		expect(tax.textContent).toContain(`120${' '}₽`)
	})

	it('[G4-T6] mvdLabel + taxRub == null → no zero-clutter линии в DOM', () => {
		renderTooltip() // no MVD, no tax
		expect(screen.queryByText(/Туристический налог:/)).toBeNull()
		expect(document.querySelector('[data-slot="tooltip-mvd"]')).toBeNull()
		expect(document.querySelector('[data-slot="tooltip-tax"]')).toBeNull()
	})

	it('[G4-T7] DOM order: guest → status → roomType → dates → channel → МВД → налог', () => {
		renderTooltip({
			guestFullName: 'Иванов И. И.',
			channelLabel: 'Канал: Booking.com',
			mvdLabel: 'МУ отправлен',
			taxRub: `200${' '}₽`,
		})
		const tooltip = screen.getByRole('tooltip')
		const text = tooltip.textContent ?? ''
		const idxGuest = text.indexOf('Иванов И. И.')
		const idxStatus = text.indexOf('Подтверждена')
		const idxRoom = text.indexOf('Стандарт')
		const idxDates = text.indexOf('28.04.2026')
		const idxChannel = text.indexOf('Канал: Booking.com')
		const idxMvd = text.indexOf('МУ отправлен')
		const idxTax = text.indexOf('Туристический налог:')
		// Strictly monotonic — каждый next index > prev
		expect(idxGuest).toBeGreaterThanOrEqual(0)
		expect(idxStatus).toBeGreaterThan(idxGuest)
		expect(idxRoom).toBeGreaterThan(idxStatus)
		expect(idxDates).toBeGreaterThan(idxRoom)
		expect(idxChannel).toBeGreaterThan(idxDates)
		expect(idxMvd).toBeGreaterThan(idxChannel)
		expect(idxTax).toBeGreaterThan(idxMvd)
	})

	it('[G4-T8] adversarial — empty string guestFullName treated as no-guest fallback', () => {
		// Edge case: server returned empty string (data corruption). Should NOT
		// render empty tooltip-guest div + should NOT demote status — fall back
		// к status-as-primary. Helper conditional `guestFullName ? ...` evaluates
		// '' as falsy correctly.
		renderTooltip({ guestFullName: '' })
		expect(document.querySelector('[data-slot="tooltip-guest"]')).toBeNull()
		const status = screen.getByText('Подтверждена')
		expect(status.className).toContain('font-medium')
	})
})
