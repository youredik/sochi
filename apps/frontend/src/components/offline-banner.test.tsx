/**
 * OfflineBanner — strict tests (2026-05-22 hotfix).
 *
 * Test matrix:
 *   ─── Online (hidden) ────────────────────────────────────────────────
 *     [O1] online + 0 mutations → returns null (no DOM)
 *     [O2] online + N mutations → returns null (no false-positive banner)
 *
 *   ─── Offline (visible) ──────────────────────────────────────────────
 *     [F1] offline + 0 mutations → banner с текстом «Нет соединения», без счётчика
 *     [F2] offline + N mutations → banner adds « В очереди: N.»
 *     [F3] role=status + aria-live=polite (WCAG 2.2 SC 4.1.3)
 *
 * Why this test set: the v2 banner regressed by зажигая на любую in-flight
 * mutation в online режиме (find-by-inn POST → синяя плашка на каждый клик).
 * Tests pin the contract «sync queue indicator is offline-only».
 */
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, mock } from 'bun:test'

const useOnlineStatusMock = mock(() => true)
const useIsMutatingMock = mock(() => 0)

void mock.module('@/lib/offline/online-status', () => ({
	useOnlineStatus: useOnlineStatusMock,
}))
void mock.module('@tanstack/react-query', () => ({
	useIsMutating: useIsMutatingMock,
}))

import { OfflineBanner } from './offline-banner.tsx'

afterEach(() => {
	cleanup()
	useOnlineStatusMock.mockReset()
	useIsMutatingMock.mockReset()
})

describe('OfflineBanner — online (hidden)', () => {
	it('[O1] online + 0 mutations → no DOM', () => {
		useOnlineStatusMock.mockImplementation(() => true)
		useIsMutatingMock.mockImplementation(() => 0)
		const { container } = render(<OfflineBanner />)
		expect(container.firstChild).toBeNull()
	})

	it('[O2] online + 3 mutations → still hidden (no false positive)', () => {
		useOnlineStatusMock.mockImplementation(() => true)
		useIsMutatingMock.mockImplementation(() => 3)
		const { container } = render(<OfflineBanner />)
		expect(container.firstChild).toBeNull()
	})
})

describe('OfflineBanner — offline (visible)', () => {
	it('[F1] offline + 0 mutations → banner без счётчика очереди', () => {
		useOnlineStatusMock.mockImplementation(() => false)
		useIsMutatingMock.mockImplementation(() => 0)
		render(<OfflineBanner />)
		const banner = screen.getByRole('status')
		expect(banner.textContent).toBe(
			'Нет соединения. Действия будут отправлены при восстановлении сети.',
		)
		expect(banner.getAttribute('data-state')).toBe('offline')
	})

	it('[F2] offline + 2 mutations → adds «В очереди: 2.»', () => {
		useOnlineStatusMock.mockImplementation(() => false)
		useIsMutatingMock.mockImplementation(() => 2)
		render(<OfflineBanner />)
		const banner = screen.getByRole('status')
		expect(banner.textContent).toBe(
			'Нет соединения. Действия будут отправлены при восстановлении сети. В очереди: 2.',
		)
	})

	it('[F3] role=status + aria-live=polite per WCAG 2.2 SC 4.1.3', () => {
		useOnlineStatusMock.mockImplementation(() => false)
		useIsMutatingMock.mockImplementation(() => 0)
		render(<OfflineBanner />)
		const banner = screen.getByRole('status')
		expect(banner.getAttribute('aria-live')).toBe('polite')
	})
})
