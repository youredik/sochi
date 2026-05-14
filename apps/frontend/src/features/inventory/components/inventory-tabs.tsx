import { Link } from '@tanstack/react-router'
import type * as React from 'react'
import { cn } from '@/lib/utils'

/**
 * Inventory sub-section tab bar — shared across all three inventory pages
 * (`rooms`, `rate-plans`, `prices`). Each tab is a real TanStack `<Link>` so
 * back/forward/bookmark all work + screen-reader navigation through the
 * tablist follows APG tab-pattern semantics (`role="tab"`, `aria-selected`,
 * `aria-controls` paired by the rendered page's `aria-labelledby`).
 *
 * IA per Bnovo «Цены и ограничения» canon (research 2026-05-14):
 *   1. Номера и категории — list of categories + their rooms
 *   2. Тарифы — list of rate plans, parent/derived hierarchy
 *   3. Цены и ограничения — date × roomType × ratePlan editable grid
 */

export type InventoryTabId = 'rooms' | 'rate-plans' | 'prices'

const TABS: ReadonlyArray<{ id: InventoryTabId; labelRu: string; to: string }> = [
	{
		id: 'rooms',
		labelRu: 'Номера и категории',
		to: '/o/$orgSlug/properties/$propertyId/inventory/rooms',
	},
	{
		id: 'rate-plans',
		labelRu: 'Тарифы',
		to: '/o/$orgSlug/properties/$propertyId/inventory/rate-plans',
	},
	{
		id: 'prices',
		labelRu: 'Цены и ограничения',
		to: '/o/$orgSlug/properties/$propertyId/inventory/prices',
	},
] as const

interface Props {
	readonly orgSlug: string
	readonly propertyId: string
	readonly current: InventoryTabId
}

export function InventoryTabs({ orgSlug, propertyId, current }: Props) {
	return (
		<div role="tablist" aria-label="Разделы инвентаря" className="-mb-px flex gap-1 border-b">
			{TABS.map((tab) => {
				const isActive = tab.id === current
				return (
					<Link
						key={tab.id}
						to={tab.to}
						params={{ orgSlug, propertyId }}
						role="tab"
						aria-selected={isActive}
						aria-controls={`inventory-panel-${tab.id}`}
						className={cn(
							'inline-block border-b-2 px-4 py-2 text-sm font-medium transition-colors',
							isActive
								? 'border-primary text-foreground'
								: 'text-muted-foreground hover:text-foreground border-transparent hover:border-muted-foreground/40',
						)}
					>
						{tab.labelRu}
					</Link>
				)
			})}
		</div>
	)
}

/**
 * Tabpanel wrapper paired с {@link InventoryTabs}. Owns the canonical
 * `id` / `aria-labelledby` strings so route files don't hardcode them
 * (Biome `useUniqueElementIds` flags raw static IDs in JSX; coupling
 * lives here once instead of three copies).
 */
export function InventoryPanel({
	current,
	children,
}: {
	readonly current: InventoryTabId
	readonly children: React.ReactNode
}) {
	return (
		<section
			id={`inventory-panel-${current}`}
			role="tabpanel"
			aria-labelledby={`inventory-tab-${current}`}
		>
			{children}
		</section>
	)
}
