import { createFileRoute } from '@tanstack/react-router'
import { InventoryPanel, InventoryTabs } from '@/features/inventory/components/inventory-tabs'

export const Route = createFileRoute(
	'/_app/o/$orgSlug/properties/$propertyId/inventory/rate-plans',
)({
	component: RatePlansPage,
})

function RatePlansPage() {
	const { orgSlug, propertyId } = Route.useParams()
	return (
		<div className="mx-auto max-w-6xl px-6 py-8 space-y-6">
			<header>
				<h1 className="text-2xl font-semibold tracking-tight">Инвентарь</h1>
				<p className="text-sm text-muted-foreground">
					Тарифные планы: «Базовый», «Невозвратный -10%», «Завтрак включён» и др.
				</p>
			</header>
			<InventoryTabs orgSlug={orgSlug} propertyId={propertyId} current="rate-plans" />
			<InventoryPanel current="rate-plans">
				<div className="rounded-lg border border-dashed p-8 text-center text-sm text-muted-foreground">
					Страница «Тарифы» — в работе. Следующая фаза.
				</div>
			</InventoryPanel>
		</div>
	)
}
