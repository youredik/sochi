import { createFileRoute } from '@tanstack/react-router'
import { InventoryPanel, InventoryTabs } from '@/features/inventory/components/inventory-tabs'

export const Route = createFileRoute('/_app/o/$orgSlug/properties/$propertyId/inventory/rooms')({
	component: RoomsPage,
})

function RoomsPage() {
	const { orgSlug, propertyId } = Route.useParams()
	return (
		<div className="mx-auto max-w-6xl px-6 py-8 space-y-6">
			<header>
				<h1 className="text-2xl font-semibold tracking-tight">Инвентарь</h1>
				<p className="text-sm text-muted-foreground">
					Категории номеров и отдельные комнаты — добавление, переименование, выключение.
				</p>
			</header>
			<InventoryTabs orgSlug={orgSlug} propertyId={propertyId} current="rooms" />
			<InventoryPanel current="rooms">
				<div className="rounded-lg border border-dashed p-8 text-center text-sm text-muted-foreground">
					Страница «Номера и категории» — в работе. Следующая фаза.
				</div>
			</InventoryPanel>
		</div>
	)
}
