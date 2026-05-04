/**
 * ChannelStatusOverlay — strict tests CHAN-UI1-CHAN-UI5 (M10 / A7.5).
 *
 * DOM-direct asserts (no jest-dom). Verifies plan §4 п.29:
 *   - 3 channels visible (TL/YT/ETG)
 *   - Status badges (idle / syncing / error / auto_disabled)
 *   - Last-sync timestamp display
 *   - Connection error display
 *   - Mode badge mock | sandbox | live
 */

import { cleanup, render } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { type ChannelOverlayRow, ChannelStatusOverlay } from './channel-status-overlay.tsx'

afterEach(cleanup)

const NOW_MS = new Date('2026-05-04T12:00:00.000Z').getTime()

function buildConnection(overrides: Partial<ChannelOverlayRow> = {}): ChannelOverlayRow {
	return {
		channelId: 'TL',
		displayName: 'TravelLine',
		mode: 'mock',
		syncStatus: 'idle',
		lastSyncAt: '2026-05-04T11:55:00.000Z',
		errorMessage: null,
		isEnabled: true,
		...overrides,
	}
}

describe('ChannelStatusOverlay — visibility + badges (CHAN-UI1-CHAN-UI5)', () => {
	it('[CHAN-UI1] 3 channel rows (TL/YT/ETG) rendered with displayName', () => {
		const { container } = render(
			<ChannelStatusOverlay
				nowMs={() => NOW_MS}
				connections={[
					buildConnection({ channelId: 'TL', displayName: 'TravelLine' }),
					buildConnection({ channelId: 'YT', displayName: 'Яндекс.Путешествия' }),
					buildConnection({ channelId: 'ETG', displayName: 'Ostrovok ETG' }),
				]}
			/>,
		)
		const rows = container.querySelectorAll('[data-testid^="channel-row-"]')
		expect(rows.length).toBe(3)
		const tl = container.querySelector('[data-testid="channel-name-TL"]')
		const yt = container.querySelector('[data-testid="channel-name-YT"]')
		const etg = container.querySelector('[data-testid="channel-name-ETG"]')
		expect(tl?.textContent).toBe('TravelLine')
		expect(yt?.textContent).toBe('Яндекс.Путешествия')
		expect(etg?.textContent).toBe('Ostrovok ETG')
	})

	it('[CHAN-UI2] sync status badges render with canonical labels', () => {
		const { container } = render(
			<ChannelStatusOverlay
				nowMs={() => NOW_MS}
				connections={[
					buildConnection({ channelId: 'TL', syncStatus: 'idle' }),
					buildConnection({ channelId: 'YT', syncStatus: 'syncing' }),
					buildConnection({ channelId: 'ETG', syncStatus: 'auto_disabled' }),
				]}
			/>,
		)
		const idleBadge = container.querySelector('[data-testid="channel-status-badge-idle"]')
		const syncingBadge = container.querySelector('[data-testid="channel-status-badge-syncing"]')
		const autoDisBadge = container.querySelector(
			'[data-testid="channel-status-badge-auto_disabled"]',
		)
		expect(idleBadge?.textContent).toBe('В ожидании')
		expect(syncingBadge?.textContent).toBe('Синхронизация')
		expect(autoDisBadge?.textContent).toBe('Авто-отключено')
		expect(idleBadge?.getAttribute('role')).toBe('status')
	})

	it('[CHAN-UI3] last-sync timestamp formatted ("5мин назад")', () => {
		const fiveMinAgo = new Date(NOW_MS - 5 * 60_000).toISOString()
		const { container } = render(
			<ChannelStatusOverlay
				nowMs={() => NOW_MS}
				connections={[buildConnection({ channelId: 'TL', lastSyncAt: fiveMinAgo })]}
			/>,
		)
		const ts = container.querySelector('[data-testid="channel-last-sync-TL"]')
		expect(ts?.textContent).toBe('5мин назад')
	})

	it('[CHAN-UI3.b] last-sync null → em-dash placeholder', () => {
		const { container } = render(
			<ChannelStatusOverlay
				nowMs={() => NOW_MS}
				connections={[buildConnection({ channelId: 'TL', lastSyncAt: null })]}
			/>,
		)
		const ts = container.querySelector('[data-testid="channel-last-sync-TL"]')
		expect(ts?.textContent).toBe('—')
	})

	it('[CHAN-UI4] connection error rendered with role=alert when errorMessage non-null', () => {
		const { container } = render(
			<ChannelStatusOverlay
				nowMs={() => NOW_MS}
				connections={[
					buildConnection({
						channelId: 'TL',
						syncStatus: 'error',
						errorMessage: 'TL OAuth token rejected (401)',
					}),
				]}
			/>,
		)
		const err = container.querySelector('[data-testid="channel-error-TL"]')
		expect(err?.textContent).toBe('TL OAuth token rejected (401)')
		expect(err?.getAttribute('role')).toBe('alert')
	})

	it('[CHAN-UI5] mode badge renders for mock | sandbox | live', () => {
		const { container } = render(
			<ChannelStatusOverlay
				nowMs={() => NOW_MS}
				connections={[
					buildConnection({ channelId: 'TL', mode: 'mock' }),
					buildConnection({ channelId: 'YT', mode: 'sandbox' }),
					buildConnection({ channelId: 'ETG', mode: 'live' }),
				]}
			/>,
		)
		const mockBadge = container.querySelector('[data-testid="channel-mode-badge-mock"]')
		const sandboxBadge = container.querySelector('[data-testid="channel-mode-badge-sandbox"]')
		const liveBadge = container.querySelector('[data-testid="channel-mode-badge-live"]')
		expect(mockBadge?.textContent).toBe('Demo')
		expect(sandboxBadge?.textContent).toBe('Sandbox')
		expect(liveBadge?.textContent).toBe('Live')
	})
})
