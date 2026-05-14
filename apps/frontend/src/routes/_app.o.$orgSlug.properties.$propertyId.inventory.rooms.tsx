import { createFileRoute } from '@tanstack/react-router'
import { InventoryRoomsPage } from '@/features/inventory/components/inventory-rooms-page'
import { InventoryPanel, InventoryTabs } from '@/features/inventory/components/inventory-tabs'

export const Route = createFileRoute('/_app/o/$orgSlug/properties/$propertyId/inventory/rooms')({
	component: RoomsRouteComponent,
})

function RoomsRouteComponent() {
	const { orgSlug, propertyId } = Route.useParams()
	return (
		<div className="mx-auto max-w-6xl px-6 py-8 space-y-6">
			<header>
				<h1 className="text-2xl font-semibold tracking-tight">Инвентарь</h1>
				<p className="text-sm text-muted-foreground">
					Категории номеров и отдельные комнаты — добавление и распределение по этажам.
				</p>
			</header>
			<InventoryTabs orgSlug={orgSlug} propertyId={propertyId} current="rooms" />
			<InventoryPanel current="rooms">
				<InventoryRoomsPage propertyId={propertyId} />
			</InventoryPanel>
		</div>
	)
}
