import { useForm } from '@tanstack/react-form'
import { Button } from '@/components/ui/button'
import { Label } from '@/components/ui/label'
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from '@/components/ui/select'
import { TextField } from '../../forms/text-field'
import { useCreateProperty } from '../hooks/use-setup-mutations'
import { useWizardStore } from '../wizard-store'

/**
 * Step 1 — create the hotel record. Minimal required fields aligned with
 * `propertyCreateInput` Zod schema from `@horeca/shared`. Tourism tax rate
 * defaults to 200 bps (2% — Sochi 2026 rate per НК РФ ст.418.5). Timezone
 * defaults to Europe/Moscow which matches Сочи / Сириус / Красная Поляна.
 *
 * Zod schema runs on submit (not per-keystroke) — spares the user red
 * underlines while they're typing their hotel name.
 */
export function PropertyStep() {
	const createProperty = useCreateProperty()
	const setPropertyId = useWizardStore((s) => s.setPropertyId)

	const form = useForm({
		defaultValues: {
			name: '',
			address: '',
			city: 'Sochi' as 'Sochi' | 'Adler' | 'Sirius' | 'KrasnayaPolyana' | 'Other',
			timezone: 'Europe/Moscow',
			tourismTaxRateBps: 200,
		},
		// Validation lives on the server (Zod via @hono/zod-validator) — 422
		// surfaces back via mutation.onError → toast. Client-side Zod adds
		// brittle schema-duplication and trips StandardSchemaV1 interop with
		// Zod 4's z.coerce.* input=`unknown` quirk. HTML5 `required`/`min`/
		// `max` gives users immediate affordance for obviously-wrong fields.
		onSubmit: async ({ value }) => {
			const created = await createProperty.mutateAsync(value)
			setPropertyId(created.id)
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
					<TextField
						field={field}
						label="Название гостиницы"
						autoComplete="organization"
						placeholder="Гостиница Ромашка"
					/>
				)}
			</form.Field>

			<form.Field name="address">
				{(field) => (
					<TextField
						field={field}
						label="Адрес"
						autoComplete="street-address"
						placeholder="Имеретинская низменность, Сириус"
					/>
				)}
			</form.Field>

			<form.Field name="city">
				{(field) => (
					<div className="space-y-1.5">
						<Label htmlFor={field.name}>Город</Label>
						<Select
							value={field.state.value}
							onValueChange={(v) => field.handleChange(v as typeof field.state.value)}
						>
							<SelectTrigger id={field.name}>
								<SelectValue />
							</SelectTrigger>
							<SelectContent>
								<SelectItem value="Sochi">Сочи</SelectItem>
								<SelectItem value="Adler">Адлер</SelectItem>
								<SelectItem value="Sirius">Сириус</SelectItem>
								<SelectItem value="KrasnayaPolyana">Красная Поляна</SelectItem>
								<SelectItem value="Other">Другой</SelectItem>
							</SelectContent>
						</Select>
					</div>
				)}
			</form.Field>

			<form.Field name="tourismTaxRateBps">
				{(field) => (
					<TextField
						field={field}
						label="Туристический налог, б.п."
						description="200 = 2% (ставка Сочи 2026). Диапазон 0–500."
						type="number"
						min={0}
						max={500}
						step={10}
					/>
				)}
			</form.Field>

			<Button type="submit" size="lg" className="w-full" disabled={createProperty.isPending}>
				{createProperty.isPending ? 'Создаём…' : 'Далее — тип номеров'}
			</Button>
		</form>
	)
}
