/**
 * use-media-query — strict tests (M9.1).
 *
 * **Pre-done audit:**
 *   [U1] Initial value reflects matchMedia(query).matches sync
 *   [U2] Listener added on mount, removed on unmount
 *   [U3] State updates когда MediaQueryListEvent fires
 *   [U4] Re-mount with same query — separate listener instance (no leak)
 */
import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from 'bun:test'
import { useMediaQuery } from './use-media-query'

interface MqMock extends MediaQueryList {
	dispatchChange: (matches: boolean) => void
}

function makeMqMock(initialMatches: boolean): MqMock {
	let listener: ((event: MediaQueryListEvent) => void) | null = null
	const mq: Partial<MqMock> = {
		matches: initialMatches,
		media: '',
		onchange: null,
		addEventListener: mock((_event: string, cb: EventListenerOrEventListenerObject) => {
			listener = cb as (event: MediaQueryListEvent) => void
		}),
		removeEventListener: mock(() => {
			listener = null
		}),
		addListener: mock(),
		removeListener: mock(),
		dispatchEvent: mock(),
		dispatchChange(matches: boolean) {
			;(this as unknown as { matches: boolean }).matches = matches
			if (listener) {
				listener({ matches } as MediaQueryListEvent)
			}
		},
	}
	return mq as MqMock
}

let mqMock: MqMock
let matchMediaSpy: ReturnType<typeof spyOn>

beforeEach(() => {
	mqMock = makeMqMock(false)
	matchMediaSpy = spyOn(window, 'matchMedia').mockReturnValue(mqMock)
})

afterEach(() => {
	matchMediaSpy.mockRestore()
})

describe('useMediaQuery', () => {
	it('[U1] initial value matches matchMedia().matches', () => {
		mqMock = makeMqMock(true)
		matchMediaSpy.mockReturnValue(mqMock)
		const { result } = renderHook(() => useMediaQuery('(prefers-color-scheme: dark)'))
		expect(result.current).toBe(true)
	})

	it('[U1.b] initial value=false когда matchMedia returns false', () => {
		mqMock = makeMqMock(false)
		matchMediaSpy.mockReturnValue(mqMock)
		const { result } = renderHook(() => useMediaQuery('(min-width: 768px)'))
		expect(result.current).toBe(false)
	})

	it('[U2] listener added on mount, removed on unmount', () => {
		const { unmount } = renderHook(() => useMediaQuery('(prefers-color-scheme: dark)'))
		expect(mqMock.addEventListener).toHaveBeenCalledWith('change', expect.any(Function))
		unmount()
		expect(mqMock.removeEventListener).toHaveBeenCalledWith('change', expect.any(Function))
	})

	it('[U3] state updates when MediaQueryListEvent fires', () => {
		const { result, rerender } = renderHook(() => useMediaQuery('(prefers-color-scheme: dark)'))
		expect(result.current).toBe(false)

		act(() => {
			mqMock.dispatchChange(true)
		})
		rerender()
		expect(result.current).toBe(true)

		act(() => {
			mqMock.dispatchChange(false)
		})
		rerender()
		expect(result.current).toBe(false)
	})
})
