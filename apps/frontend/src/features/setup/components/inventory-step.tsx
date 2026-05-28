import type { City } from '@horeca/shared'
import { type FormEvent, useEffect, useId, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { intRangeFieldSchema } from '../../../lib/forms/int-range-field-schema.ts'
import { useBulkInventory } from '../hooks/use-bulk-inventory.ts'
import { useWizardStore } from '../wizard-store.ts'

/**
 * Screen 2 — inventory. Two numeric inputs (rooms count + nightly price) and
 * an optional name/address/city block that renders ONLY when the user opted
 * for manual entry (DaData skipped or returned null). DaData users see the
 * preview as read-only context above the inputs — no second-typing.
 *
 * On submit fires `POST /api/v1/onboarding/inventory` (commit 4 endpoint).
 * The bulk-tx response lands a property + roomType + N rooms + ratePlan in
 * one round-trip; `useBulkInventory.onSuccess` invalidates the `properties`
 * query so the dashboard's beforeLoad-guard at `/o/$orgSlug/` no longer
 * redirects back into the wizard. The shell handles navigation to Шахматка
 * once the wizard step transitions to `done`.
 */

interface ManualPropertyForm {
	name: string
	address: string
	city: City
}

/**
 * Map RU city literals coming from DaData / manual entry into the
 * canonical sochi `City` enum. DaData returns city as a free-form string
 * (`Сочи`, `Адлер`, `Красная Поляна`, `Москва`, …); we only accept the
 * Сочи-region variants natively and bucket everything else into `'Other'`.
 */
function inferCity(raw: string): City {
	const lower = raw.toLowerCase()
	if (lower.includes('сочи')) return 'Sochi'
	if (lower.includes('адлер')) return 'Adler'
	if (lower.includes('сириус')) return 'Sirius'
	if (lower.includes('красная поляна') || lower.includes('красной поляны')) return 'KrasnayaPolyana'
	return 'Other'
}

export function InventoryStep() {
	const roomsId = useId()
	const priceId = useId()
	const nameId = useId()
	const addressId = useId()
	const cityId = useId()
	const party = useWizardStore((s) => s.party)
	const manualOverride = useWizardStore((s) => s.manualOverride)
	const rooms = useWizardStore((s) => s.rooms)
	const setRooms = useWizardStore((s) => s.setRooms)
	const avgPriceRub = useWizardStore((s) => s.avgPriceRub)
	const setAvgPriceRub = useWizardStore((s) => s.setAvgPriceRub)
	const setStep = useWizardStore((s) => s.setStep)
	const bulk = useBulkInventory()

	const [manualForm, setManualForm] = useState<ManualPropertyForm>(() => ({
		name: '',
		address: '',
		city: 'Sochi',
	}))

	// Caught real-bug-hunt 2026-05-15: previous `Math.max(1, Math.min(200,
	// Number(...) || 0))` silently clamped — operator typing 250 saw 200 без
	// signal. AND `min={0}` permitted avgPriceRub=0, seeding 90 days × 0₽
	// rate (sellable free). Inline-bounds canon via intRangeFieldSchema:
	// raw string state + Zod refine → inline error → store updated только
	// при valid input.
	const ROOMS_MIN = 1
	const ROOMS_MAX = 200
	const PRICE_MIN = 1
	const PRICE_MAX = 1_000_000
	const roomsSchema = intRangeFieldSchema({ min: ROOMS_MIN, max: ROOMS_MAX })
	const priceSchema = intRangeFieldSchema({ min: PRICE_MIN, max: PRICE_MAX })
	const [roomsRaw, setRoomsRaw] = useState(String(rooms))
	const [priceRaw, setPriceRaw] = useState(String(avgPriceRub))
	const roomsParse = roomsSchema.safeParse(roomsRaw)
	const priceParse = priceSchema.safeParse(priceRaw)
	const roomsError = roomsParse.success ? null : (roomsParse.error.issues[0]?.message ?? null)
	const priceError = priceParse.success ? null : (priceParse.error.issues[0]?.message ?? null)
	// Sync store ONLY when input is valid — keeps last-valid value for the
	// «Номера 101–…» preview, but blocks submit via canSubmit.
	useEffect(() => {
		if (roomsParse.success) setRooms(Number(roomsRaw))
	}, [roomsParse.success, roomsRaw, setRooms])
	useEffect(() => {
		if (priceParse.success) setAvgPriceRub(Number(priceRaw))
	}, [priceParse.success, priceRaw, setAvgPriceRub])

	const usingManual = manualOverride || party === null

	function handleSubmit(e: FormEvent) {
		e.preventDefault()
		const propertyInput = usingManual
			? {
					name: manualForm.name.trim(),
					address: manualForm.address.trim(),
					city: manualForm.city,
				}
			: {
					// `party` is non-null here because !usingManual ⇔ party !== null.
					// biome-ignore lint/style/noNonNullAssertion: branch guards null.
					name: party!.name,
					// biome-ignore lint/style/noNonNullAssertion: branch guards null.
					address: party!.address,
					// biome-ignore lint/style/noNonNullAssertion: branch guards null.
					city: inferCity(party!.city),
				}

		bulk.mutate(
			{ property: propertyInput, rooms, avgPriceRub },
			{
				onSuccess: () => {
					setStep('done')
				},
			},
		)
	}

	const canSubmit =
		!bulk.isPending &&
		roomsError === null &&
		priceError === null &&
		(!usingManual || (manualForm.name.trim().length > 0 && manualForm.address.trim().length > 0))

	return (
		<form onSubmit={handleSubmit} className="space-y-5" noValidate aria-label="Номера и цена">
			{!usingManual && party ? (
				<div className="rounded-md border border-muted bg-muted/30 px-3 py-2 text-sm">
					<p className="font-medium">{party.name}</p>
					<p className="text-xs text-muted-foreground">{party.address}</p>
				</div>
			) : null}

			{usingManual ? (
				<fieldset className="space-y-3">
					<legend className="text-sm font-medium">Данные гостиницы</legend>
					<div className="space-y-1.5">
						<Label htmlFor={nameId}>Название</Label>
						<Input
							id={nameId}
							type="text"
							autoComplete="organization"
							required
							maxLength={200}
							value={manualForm.name}
							onChange={(e) => setManualForm((f) => ({ ...f, name: e.target.value }))}
							placeholder="Гостиница Ромашка"
						/>
					</div>
					<div className="space-y-1.5">
						<Label htmlFor={addressId}>Адрес</Label>
						<Input
							id={addressId}
							type="text"
							autoComplete="street-address"
							required
							maxLength={500}
							value={manualForm.address}
							onChange={(e) => setManualForm((f) => ({ ...f, address: e.target.value }))}
							placeholder="354340, г. Сочи, ул. ..."
						/>
					</div>
					<div className="space-y-1.5">
						<Label htmlFor={cityId}>Город</Label>
						<select
							id={cityId}
							className="border-input bg-transparent focus-visible:border-ring focus-visible:ring-ring/50 h-9 w-full rounded-lg border px-2.5 py-1 text-sm outline-none focus-visible:ring-3"
							value={manualForm.city}
							onChange={(e) => setManualForm((f) => ({ ...f, city: e.target.value as City }))}
						>
							<option value="Sochi">Сочи</option>
							<option value="Adler">Адлер</option>
							<option value="Sirius">Сириус</option>
							<option value="KrasnayaPolyana">Красная Поляна</option>
							<option value="Other">Другой</option>
						</select>
					</div>
				</fieldset>
			) : null}

			<div className="grid gap-4 sm:grid-cols-2">
				<div className="space-y-1.5">
					<Label htmlFor={roomsId}>Сколько номеров?</Label>
					<Input
						id={roomsId}
						type="number"
						inputMode="numeric"
						min={ROOMS_MIN}
						max={ROOMS_MAX}
						step={1}
						required
						aria-invalid={roomsError !== null}
						aria-describedby={roomsError !== null ? `${roomsId}-err` : undefined}
						value={roomsRaw}
						onChange={(e) => setRoomsRaw(e.target.value)}
					/>
					{roomsError !== null ? (
						<p id={`${roomsId}-err`} className="text-xs text-destructive" role="alert">
							{roomsError}
						</p>
					) : (
						<p className="text-xs text-muted-foreground">
							Номера 101–{(100 + rooms).toString()} на 1 этаже. Перенумеровать можно позже.
						</p>
					)}
				</div>
				<div className="space-y-1.5">
					<Label htmlFor={priceId}>Цена за ночь, ₽</Label>
					<Input
						id={priceId}
						type="number"
						inputMode="numeric"
						min={PRICE_MIN}
						max={PRICE_MAX}
						step={100}
						required
						aria-invalid={priceError !== null}
						aria-describedby={priceError !== null ? `${priceId}-err` : undefined}
						value={priceRaw}
						onChange={(e) => setPriceRaw(e.target.value)}
					/>
					{priceError !== null ? (
						<p id={`${priceId}-err`} className="text-xs text-destructive" role="alert">
							{priceError}
						</p>
					) : (
						<p className="text-xs text-muted-foreground">
							Это значение по умолчанию для всех дат. Уточните в шахматке.
						</p>
					)}
				</div>
			</div>

			{bulk.isError ? (
				<div
					role="alert"
					aria-live="polite"
					className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive"
				>
					<p className="font-medium">Не удалось создать инвентарь</p>
					<p className="mt-1 opacity-80">{bulk.error.message}</p>
				</div>
			) : null}

			<div className="flex gap-2">
				<Button
					type="button"
					variant="ghost"
					size="lg"
					onClick={() => setStep('identify')}
					disabled={bulk.isPending}
				>
					← Назад
				</Button>
				<Button type="submit" size="lg" disabled={!canSubmit}>
					{bulk.isPending ? 'Создаём…' : 'Готово → Демо OTA'}
				</Button>
			</div>

			{/*
			 * «You can change this later» canon hint (Stripe / Linear / Mews
			 * onboarding pattern). Снижает страх «выбрать неправильно сейчас»
			 * для prospect'a — даёт сигнал что wizard это quick-start, не
			 * финальная конфигурация. Все advanced features (категории, гибкие
			 * тарифы, сезонные цены, каналы дистрибуции, турналог) живут в
			 * обычных разделах после /demo landing (Round 14.6.2 wow effect).
			 */}
			<p className="text-xs text-muted-foreground">
				Категории номеров, тарифы и каналы продаж добавите позже — в настройках гостиницы.
			</p>
		</form>
	)
}
