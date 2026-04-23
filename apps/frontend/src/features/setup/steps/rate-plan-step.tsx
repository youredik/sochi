import { useForm } from '@tanstack/react-form'
import { Button } from '@/components/ui/button'
import { TextField } from '../../forms/text-field'
import { useCreateRatePlan } from '../hooks/use-setup-mutations'
import { useWizardStore } from '../wizard-store'

/**
 * Step 4 — base rate plan. Creates a default BAR-flex plan + seeds 30
 * days of rate + availability so booking creation in the chessboard
 * works immediately after wizard completion.
 *
 * Defaults: code "BAR", name "Базовый тариф" (industry-standard), 24h
 * free-cancellation window, price 5000₽ — all sensible sochi SMB starter
 * values the user can accept with one click if they don't have specific
 * knowledge yet. Overriding happens later in the admin rate-management
 * UI (not in the wizard).
 */
export function RatePlanStep() {
	const propertyId = useWizardStore((s) => s.propertyId)
	const roomTypeId = useWizardStore((s) => s.roomTypeId)
	const setRatePlanId = useWizardStore((s) => s.setRatePlanId)
	const createRatePlan = useCreateRatePlan(propertyId, roomTypeId)

	const form = useForm({
		defaultValues: {
			code: 'BAR',
			name: 'Базовый тариф',
			nightlyRub: 5000,
		},
		// Server Zod is authoritative; HTML5 covers affordance. Same pattern
		// as earlier wizard steps (avoids Zod 4 z.coerce StandardSchemaV1
		// mismatch with TanStack Form validators).
		onSubmit: async ({ value }) => {
			const created = await createRatePlan.mutateAsync(value)
			setRatePlanId(created.id)
		},
	})

	return (
		<form
			onSubmit={(e) => {
				e.preventDefault()
				void form.handleSubmit()
			}}
			className="space-y-4"
			noValidate
		>
			<form.Field name="name">
				{(field) => (
					<TextField field={field} label="Название тарифа" placeholder="Базовый тариф" required />
				)}
			</form.Field>

			<form.Field name="code">
				{(field) => (
					<TextField
						field={field}
						label="Код"
						description="Короткий идентификатор для OTA (BAR, BAR-NR, CORP…)"
						pattern="^[A-Z][A-Z0-9_-]*$"
						maxLength={50}
						required
					/>
				)}
			</form.Field>

			<form.Field name="nightlyRub">
				{(field) => (
					<TextField
						field={field}
						label="Цена за ночь, ₽"
						description="Заполнит цены на 30 дней вперёд. Изменить можно позже в тарифах."
						type="number"
						min={0}
						max={10_000_000}
						step={100}
						required
					/>
				)}
			</form.Field>

			<Button type="submit" size="lg" className="w-full" disabled={createRatePlan.isPending}>
				{createRatePlan.isPending ? 'Создаём тариф + цены…' : 'Завершить настройку'}
			</Button>
		</form>
	)
}
