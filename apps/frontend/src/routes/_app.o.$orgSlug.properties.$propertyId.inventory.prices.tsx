import { createFileRoute } from '@tanstack/react-router'
import { InventoryPanel, InventoryTabs } from '@/features/inventory/components/inventory-tabs'

export const Route = createFileRoute('/_app/o/$orgSlug/properties/$propertyId/inventory/prices')({
	component: PricesPage,
})

function PricesPage() {
	const { orgSlug, propertyId } = Route.useParams()
	return (
		<div className="mx-auto max-w-6xl px-6 py-8 space-y-6">
			<header>
				<h1 className="text-2xl font-semibold tracking-tight">Инвентарь</h1>
				<p className="text-sm text-muted-foreground">
					Цены и ограничения по дате × категории × тарифу. Bnovo-style bulk-edit.
				</p>
			</header>
			<InventoryTabs orgSlug={orgSlug} propertyId={propertyId} current="prices" />
			<InventoryPanel current="prices">
				<div className="rounded-lg border border-dashed p-8 text-center text-sm text-muted-foreground">
					Страница «Цены и ограничения» — в работе. Финальная фаза с react-data-grid.
				</div>
			</InventoryPanel>
		</div>
	)
}
