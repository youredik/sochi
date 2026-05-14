/**
 * InventoryTabs — strict tests.
 *
 * Pre-done audit:
 *   [T1] renders exactly 3 tabs with канонические RU labels
 *   [T2] tab matching `current` carries aria-selected="true"; others "false"
 *   [T3] container has role="tablist" + aria-label="Разделы инвентаря"
 *   [T4] each tab has aria-controls referencing the corresponding panel id
 *   [T5] each tab renders an anchor с the canonical TanStack route href
 *
 * Mocking strategy:
 *   - `@tanstack/react-router` `Link` is replaced with a plain `<a>` that
 *     reconstructs the href by substituting `$param` placeholders с the
 *     supplied `params` prop. Keeps the test isolated от full Router setup
 *     (Router init requires routeTree which would re-import the entire
 *     app's routes — too heavy for a component test).
 */
import { cleanup, render, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it, mock } from 'bun:test'

mock.module('@tanstack/react-router', () => ({
	Link: (props: {
		to: string
		params?: Record<string, string>
		children: React.ReactNode
		[k: string]: unknown
	}) => {
		const { to, params, children, ...rest } = props
		const href = Object.entries(params ?? {}).reduce((acc, [k, v]) => acc.replace(`$${k}`, v), to)
		return (
			<a href={href} {...rest}>
				{children}
			</a>
		)
	},
}))

const { InventoryTabs } = await import('./inventory-tabs.tsx')

afterEach(cleanup)

describe('InventoryTabs — render + a11y', () => {
	it('[T1] renders exactly 3 tabs с canonical RU labels', () => {
		render(<InventoryTabs orgSlug="test-org" propertyId="prop-1" current="rooms" />)
		const tablist = screen.getByRole('tablist')
		const tabs = within(tablist).getAllByRole('tab')
		expect(tabs.length).toBe(3)
		const labels = tabs.map((t) => t.textContent?.trim() ?? '')
		expect(labels).toEqual(['Номера и категории', 'Тарифы', 'Цены и ограничения'])
	})

	it('[T2] tab matching `current` is aria-selected="true"; others "false"', () => {
		render(<InventoryTabs orgSlug="test-org" propertyId="prop-1" current="rate-plans" />)
		const tabs = screen.getAllByRole('tab')
		const selected = tabs.filter((t) => t.getAttribute('aria-selected') === 'true')
		expect(selected.length).toBe(1)
		expect(selected[0]?.textContent?.trim()).toBe('Тарифы')

		const unselected = tabs.filter((t) => t.getAttribute('aria-selected') === 'false')
		expect(unselected.length).toBe(2)
	})

	it('[T3] container has role="tablist" + RU aria-label', () => {
		render(<InventoryTabs orgSlug="test-org" propertyId="prop-1" current="prices" />)
		const tablist = screen.getByRole('tablist')
		expect(tablist.getAttribute('aria-label')).toBe('Разделы инвентаря')
	})

	it('[T4] each tab has aria-controls referencing the matching panel id', () => {
		render(<InventoryTabs orgSlug="test-org" propertyId="prop-1" current="rooms" />)
		const tabs = screen.getAllByRole('tab')
		const ids = tabs.map((t) => t.getAttribute('aria-controls'))
		expect(ids).toEqual([
			'inventory-panel-rooms',
			'inventory-panel-rate-plans',
			'inventory-panel-prices',
		])
	})

	it('[T5] each tab renders <a> с the canonical TanStack route href', () => {
		render(<InventoryTabs orgSlug="test-org" propertyId="prop-1" current="rooms" />)
		const links = screen.getAllByRole('tab') as HTMLAnchorElement[]
		expect(links[0]?.getAttribute('href')).toBe('/o/test-org/properties/prop-1/inventory/rooms')
		expect(links[1]?.getAttribute('href')).toBe(
			'/o/test-org/properties/prop-1/inventory/rate-plans',
		)
		expect(links[2]?.getAttribute('href')).toBe('/o/test-org/properties/prop-1/inventory/prices')
	})
})
