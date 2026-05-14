import { createFileRoute } from '@tanstack/react-router'
import { InventoryPricesPage } from '@/features/inventory/components/inventory-prices-page'
import { InventoryPanel, InventoryTabs } from '@/features/inventory/components/inventory-tabs'

export const Route = createFileRoute('/_app/o/$orgSlug/properties/$propertyId/inventory/prices')({
	component: PricesRouteComponent,
})

function PricesRouteComponent() {
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
				<InventoryPricesPage propertyId={propertyId} />
			</InventoryPanel>
		</div>
	)
}
