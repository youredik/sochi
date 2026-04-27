import {
	type Addon,
	type AddonCategory,
	type AddonCreateInput,
	type AddonPricingUnit,
	type AddonSeasonalTag,
	type AddonVatBps,
	addonCategoryValues,
	addonPricingUnitValues,
	addonSeasonalTagValues,
	VAT_RATE_BPS_VALUES,
} from '@horeca/shared'
import { useId, useState } from 'react'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from '@/components/ui/select'
import { Textarea } from '@/components/ui/textarea'
import { useCan } from '../../../lib/use-can.ts'
import { useAddons, useCreateAddon, useDeleteAddon, usePatchAddon } from '../hooks/use-addons.ts'
import { useContentWizardStore } from '../wizard-store.ts'

interface Props {
	propertyId: string
}

const CATEGORY_LABELS: Record<AddonCategory, string> = {
	FOOD_AND_BEVERAGES: 'Еда и напитки',
	TRANSFER: 'Трансфер',
	PARKING: 'Парковка',
	WELLNESS: 'Спа и велнес',
	ACTIVITIES: 'Активности',
	EARLY_CHECK_IN: 'Ранний заезд',
	LATE_CHECK_OUT: 'Поздний выезд',
	CLEANING: 'Уборка',
	EQUIPMENT: 'Оборудование',
	PET_FEE: 'Питомцы',
	CONNECTIVITY: 'Связь и интернет',
	OTHER: 'Другое',
}

const PRICING_UNIT_LABELS: Record<AddonPricingUnit, string> = {
	PER_STAY: 'За проживание',
	PER_PERSON: 'За гостя',
	PER_NIGHT: 'За ночь',
	PER_NIGHT_PER_PERSON: 'За ночь × гостя',
	PER_HOUR: 'За час',
	PERCENT_OF_ROOM_RATE: '% от стоимости номера',
}

const VAT_BPS_LABELS: Record<AddonVatBps, string> = {
	0: '0% (льгота)',
	500: '5% (УСН-НДС)',
	700: '7% (УСН-НДС)',
	1000: '10% (пониженный)',
	2000: '20% (переход)',
	2200: '22% (основная)',
}

const SEASONAL_TAG_LABELS: Record<AddonSeasonalTag, string> = {
	'ski-season': 'Лыжный сезон (15.12-15.04)',
	'sea-season': 'Морской сезон (01.06-30.09)',
	'new-year-peak': 'Новогодние праздники',
	'may-holidays': 'Майские праздники',
}

interface DraftAddon {
	code: string
	category: AddonCategory
	nameRu: string
	nameEn: string
	descriptionRu: string
	pricingUnit: AddonPricingUnit
	priceRub: string
	vatBps: AddonVatBps
	isActive: boolean
	isMandatory: boolean
	seasonalTags: Set<AddonSeasonalTag>
}

function emptyDraft(): DraftAddon {
	return {
		code: '',
		category: 'OTHER',
		nameRu: '',
		nameEn: '',
		descriptionRu: '',
		pricingUnit: 'PER_STAY',
		priceRub: '',
		vatBps: 2200,
		isActive: true,
		isMandatory: false,
		seasonalTags: new Set(),
	}
}

function rubToMicros(rub: string): bigint | null {
	const cleaned = rub.replace(/[\s,]/g, '')
	if (cleaned === '') return null
	if (!/^\d+(\.\d{1,2})?$/.test(cleaned)) return null
	const [whole, frac = ''] = cleaned.split('.')
	const fracPadded = `${frac}00`.slice(0, 2)
	return BigInt(whole + fracPadded) * 10_000n
}

function microsToRub(micros: bigint): string {
	const rub = Number(micros) / 1_000_000
	return rub.toFixed(2)
}

/**
 * Step 5 — Addons CRUD (Apaleo Services pattern).
 *
 * Single create-form at the top + a list of existing addons with inline
 * patch + delete. Keeps the operator from playing modal-tag (Apaleo's
 * worst UX: every edit a Sheet round-trip).
 *
 * Validation:
 *   - `code` uniqueness — server-side (returns 409 CONFLICT on duplicate
 *     within the same property; we surface via toast).
 *   - `priceMicros` parsed from RUB input field (1 ₽ = 1_000_000 micros).
 *   - `dailyCapacity` deferred (inventoryMode='NONE' default; DAILY_COUNTER
 *     flow is M9+ when bookings reach add-on lines).
 */
export function AddonsStep({ propertyId }: Props) {
	const canCreate = useCan({ addon: ['create'] })
	const canUpdate = useCan({ addon: ['update'] })
	const canDelete = useCan({ addon: ['delete'] })
	const next = useContentWizardStore((s) => s.next)
	const headingId = useId()
	const codeInputId = useId()

	const { data: rows = [], isLoading, error } = useAddons(propertyId)
	const create = useCreateAddon(propertyId)
	const patch = usePatchAddon(propertyId)
	const del = useDeleteAddon(propertyId)

	const [draft, setDraft] = useState<DraftAddon>(emptyDraft())

	function patchDraft(p: Partial<DraftAddon>) {
		setDraft((d) => ({ ...d, ...p }))
	}

	function toggleSeasonalTag(tag: AddonSeasonalTag, on: boolean) {
		setDraft((d) => {
			const next = new Set(d.seasonalTags)
			if (on) next.add(tag)
			else next.delete(tag)
			return { ...d, seasonalTags: next }
		})
	}

	async function onCreate() {
		const micros = rubToMicros(draft.priceRub)
		if (micros === null) return
		const input: AddonCreateInput = {
			code: draft.code.trim(),
			category: draft.category,
			nameRu: draft.nameRu.trim(),
			nameEn: draft.nameEn.trim() === '' ? null : draft.nameEn.trim(),
			descriptionRu: draft.descriptionRu.trim() === '' ? null : draft.descriptionRu.trim(),
			descriptionEn: null,
			pricingUnit: draft.pricingUnit,
			priceMicros: micros,
			currency: 'RUB',
			vatBps: draft.vatBps,
			isActive: draft.isActive,
			isMandatory: draft.isMandatory,
			inventoryMode: 'NONE',
			dailyCapacity: null,
			seasonalTags: Array.from(draft.seasonalTags),
			sortOrder: 0,
		}
		await create.mutateAsync(input)
		setDraft(emptyDraft())
	}

	if (isLoading) return <p className="text-muted-foreground">Загрузка…</p>
	if (error) {
		return (
			<Alert variant="destructive">
				<AlertTitle>Ошибка загрузки</AlertTitle>
				<AlertDescription>{(error as Error).message}</AlertDescription>
			</Alert>
		)
	}

	const minRequiredOk =
		draft.code.trim() !== '' && draft.nameRu.trim() !== '' && rubToMicros(draft.priceRub) !== null

	return (
		<section aria-labelledby={headingId}>
			<h2 id={headingId} className="text-xl font-semibold">
				Услуги и доп. сервис
			</h2>
			<p className="text-muted-foreground mt-1 text-sm">
				Apaleo Services pattern — 12 категорий × 6 единиц цены × VAT 2026 (376-ФЗ). Sezonality tags:
				лыжный сезон / морской сезон / праздники.
			</p>

			{!canCreate ? (
				<Alert className="mt-4">
					<AlertTitle>Только просмотр</AlertTitle>
					<AlertDescription>Создание услуг доступно владельцу или менеджеру.</AlertDescription>
				</Alert>
			) : null}

			{/* ── Create form ──────────────────────────────────────────── */}
			<fieldset className="mt-6 rounded-md border p-4" disabled={!canCreate}>
				<legend className="px-2 text-sm font-medium">Новая услуга</legend>
				<div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
					<div className="space-y-1.5">
						<Label htmlFor={codeInputId}>Код (уникален в гостинице)</Label>
						<Input
							id={codeInputId}
							value={draft.code}
							onChange={(e) => patchDraft({ code: e.target.value })}
							maxLength={50}
							required
							placeholder="напр. BREAKFAST_RU"
						/>
					</div>

					<div className="space-y-1.5">
						<Label htmlFor={`${codeInputId}-cat`}>Категория</Label>
						<Select
							value={draft.category}
							onValueChange={(v) => patchDraft({ category: v as AddonCategory })}
						>
							<SelectTrigger id={`${codeInputId}-cat`}>
								<SelectValue />
							</SelectTrigger>
							<SelectContent>
								{addonCategoryValues.map((c) => (
									<SelectItem key={c} value={c}>
										{CATEGORY_LABELS[c]}
									</SelectItem>
								))}
							</SelectContent>
						</Select>
					</div>

					<div className="space-y-1.5">
						<Label htmlFor={`${codeInputId}-nameRu`}>Название (ru)</Label>
						<Input
							id={`${codeInputId}-nameRu`}
							value={draft.nameRu}
							onChange={(e) => patchDraft({ nameRu: e.target.value })}
							maxLength={200}
							required
						/>
					</div>

					<div className="space-y-1.5">
						<Label htmlFor={`${codeInputId}-nameEn`}>Название (en, опц.)</Label>
						<Input
							id={`${codeInputId}-nameEn`}
							value={draft.nameEn}
							onChange={(e) => patchDraft({ nameEn: e.target.value })}
							maxLength={200}
						/>
					</div>

					<div className="space-y-1.5 sm:col-span-2">
						<Label htmlFor={`${codeInputId}-descRu`}>Описание (ru, опц.)</Label>
						<Textarea
							id={`${codeInputId}-descRu`}
							value={draft.descriptionRu}
							onChange={(e) => patchDraft({ descriptionRu: e.target.value })}
							maxLength={2000}
							rows={3}
						/>
					</div>

					<div className="space-y-1.5">
						<Label htmlFor={`${codeInputId}-unit`}>Единица цены</Label>
						<Select
							value={draft.pricingUnit}
							onValueChange={(v) => patchDraft({ pricingUnit: v as AddonPricingUnit })}
						>
							<SelectTrigger id={`${codeInputId}-unit`}>
								<SelectValue />
							</SelectTrigger>
							<SelectContent>
								{addonPricingUnitValues.map((u) => (
									<SelectItem key={u} value={u}>
										{PRICING_UNIT_LABELS[u]}
									</SelectItem>
								))}
							</SelectContent>
						</Select>
					</div>

					<div className="space-y-1.5">
						<Label htmlFor={`${codeInputId}-price`}>Цена, ₽</Label>
						<Input
							id={`${codeInputId}-price`}
							value={draft.priceRub}
							onChange={(e) => patchDraft({ priceRub: e.target.value })}
							inputMode="numeric"
							placeholder="1500.00"
							required
						/>
						{draft.pricingUnit === 'PERCENT_OF_ROOM_RATE' ? (
							<p className="text-muted-foreground text-xs">
								Для % от номера: укажите проценты × 100 (5% = 500)
							</p>
						) : null}
					</div>

					<div className="space-y-1.5">
						<Label htmlFor={`${codeInputId}-vat`}>НДС</Label>
						<Select
							value={String(draft.vatBps)}
							onValueChange={(v) => patchDraft({ vatBps: Number(v) as AddonVatBps })}
						>
							<SelectTrigger id={`${codeInputId}-vat`}>
								<SelectValue />
							</SelectTrigger>
							<SelectContent>
								{VAT_RATE_BPS_VALUES.map((bps) => (
									<SelectItem key={bps} value={String(bps)}>
										{VAT_BPS_LABELS[bps]}
									</SelectItem>
								))}
							</SelectContent>
						</Select>
					</div>

					<div className="space-y-2 sm:col-span-2">
						<Label>Сезонные теги</Label>
						<div className="flex flex-wrap gap-3">
							{addonSeasonalTagValues.map((tag) => {
								const id = `${codeInputId}-tag-${tag}`
								return (
									<div key={tag} className="flex items-center gap-2">
										<Checkbox
											id={id}
											checked={draft.seasonalTags.has(tag)}
											onCheckedChange={(v) => toggleSeasonalTag(tag, v === true)}
										/>
										<Label htmlFor={id} className="font-normal">
											{SEASONAL_TAG_LABELS[tag]}
										</Label>
									</div>
								)
							})}
						</div>
					</div>

					<div className="flex flex-wrap gap-4 sm:col-span-2">
						<div className="flex items-center gap-2">
							<Checkbox
								id={`${codeInputId}-active`}
								checked={draft.isActive}
								onCheckedChange={(v) => patchDraft({ isActive: v === true })}
							/>
							<Label htmlFor={`${codeInputId}-active`} className="font-normal">
								Активна
							</Label>
						</div>
						<div className="flex items-center gap-2">
							<Checkbox
								id={`${codeInputId}-mand`}
								checked={draft.isMandatory}
								onCheckedChange={(v) => patchDraft({ isMandatory: v === true })}
							/>
							<Label htmlFor={`${codeInputId}-mand`} className="font-normal">
								Обязательная
							</Label>
						</div>
					</div>
				</div>

				<div className="mt-4">
					<Button
						type="button"
						onClick={() => void onCreate()}
						disabled={!minRequiredOk || create.isPending}
					>
						{create.isPending ? 'Создаём…' : 'Добавить услугу'}
					</Button>
				</div>
			</fieldset>

			{/* ── Existing addons list ─────────────────────────────────── */}
			<div className="mt-8">
				<h3 className="text-sm font-medium">Существующие услуги ({rows.length})</h3>
				{rows.length === 0 ? (
					<p className="text-muted-foreground mt-2 text-sm">Пока ничего не добавлено.</p>
				) : (
					<ul className="mt-3 space-y-3">
						{rows.map((row) => (
							<AddonRow
								key={row.addonId}
								row={row}
								canUpdate={canUpdate}
								canDelete={canDelete}
								onToggleActive={() =>
									patch.mutate({ addonId: row.addonId, patch: { isActive: !row.isActive } })
								}
								onDelete={() => del.mutate(row.addonId)}
							/>
						))}
					</ul>
				)}
			</div>

			<div className="mt-8">
				<Button type="button" onClick={() => next()}>
					Завершить
				</Button>
			</div>
		</section>
	)
}

interface AddonRowProps {
	row: Addon
	canUpdate: boolean
	canDelete: boolean
	onToggleActive: () => void
	onDelete: () => void
}

function AddonRow({ row, canUpdate, canDelete, onToggleActive, onDelete }: AddonRowProps) {
	return (
		<li className="rounded-md border p-3">
			<div className="flex flex-wrap items-start gap-3">
				<div className="flex-1">
					<p className="text-sm font-medium">
						{row.nameRu}
						{!row.isActive ? (
							<span className="bg-muted text-muted-foreground ml-2 rounded px-2 py-0.5 text-xs">
								Неактивна
							</span>
						) : null}
						{row.isMandatory ? (
							<span className="bg-orange-100 text-orange-900 dark:bg-orange-900 dark:text-orange-100 ml-2 rounded px-2 py-0.5 text-xs">
								Обязательная
							</span>
						) : null}
					</p>
					<p className="text-muted-foreground mt-1 text-xs">
						<code>{row.code}</code> · {CATEGORY_LABELS[row.category]} ·{' '}
						{microsToRub(row.priceMicros)} ₽ {PRICING_UNIT_LABELS[row.pricingUnit]} ·{' '}
						{VAT_BPS_LABELS[row.vatBps as AddonVatBps] ?? `${row.vatBps} bps`}
					</p>
					{row.seasonalTags.length > 0 ? (
						<p className="mt-1 flex flex-wrap gap-1">
							{row.seasonalTags.map((t) => (
								<span
									key={t}
									className="bg-secondary text-secondary-foreground rounded px-2 py-0.5 text-xs"
								>
									{SEASONAL_TAG_LABELS[t]}
								</span>
							))}
						</p>
					) : null}
				</div>
				<div className="flex flex-col gap-2">
					<Button
						type="button"
						size="sm"
						variant="outline"
						disabled={!canUpdate}
						onClick={onToggleActive}
					>
						{row.isActive ? 'Деактивировать' : 'Активировать'}
					</Button>
					<Button
						type="button"
						size="sm"
						variant="destructive"
						disabled={!canDelete}
						onClick={onDelete}
					>
						Удалить
					</Button>
				</div>
			</div>
		</li>
	)
}
