import {
	AMENITY_CATALOG,
	type AmenityCategory,
	type AmenityDefinition,
	type AmenityFreePaid,
	amenityCategoryValues,
	type PropertyAmenityInput,
} from '@horeca/shared'
import { useId, useMemo, useState } from 'react'
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
import { freshIdempotencyKey } from '../../../lib/idempotency.ts'
import { useCan } from '../../../lib/use-can.ts'
import { useAmenities, useSetAmenities } from '../hooks/use-amenities.ts'
import { useContentWizardStore } from '../wizard-store.ts'

interface Props {
	propertyId: string
}

/**
 * Step 2 — Amenities multi-select against the 64-code canonical catalog.
 *
 * UX rationale (per Booking.com extranet + Apaleo content patterns):
 *   - One row per amenity in the catalog, grouped by category.
 *   - Checkbox toggles inclusion. When checked, freePaid Select appears
 *     (default = catalog's `defaultFreePaid`). For amenities marked
 *     `supportsValue=true`, an inline value Input appears (e.g. "100" Mbps).
 *   - "Save" sends the FULL desired set via PUT (not per-row PATCH) — the
 *     backend handles diff + emits a single audit event. This avoids the
 *     "save half the changes, network drops, partial state" failure mode.
 *
 * State: local `Map<code, { freePaid, value }>` derived from the server's
 * current set on first render, mutated in-place by checkbox/select changes.
 * On submit we serialize back to PropertyAmenityInput[] and call setMany.
 *
 * NOT a controlled form via useForm — TanStack Form's Field tree pays the
 * cost of 64 Field components for very little benefit. A plain Map +
 * `useState` is simpler and faster here.
 */

const CATEGORY_LABELS: Record<AmenityCategory, string> = {
	internet: 'Интернет',
	parking: 'Парковка',
	transport: 'Трансфер',
	pool: 'Бассейн',
	wellness: 'Спа и велнес',
	fitness: 'Фитнес',
	food: 'Еда и напитки',
	kids: 'Для детей',
	pets: 'Питомцы',
	view: 'Виды',
	business: 'Бизнес',
	accessibility: 'Доступная среда',
	comfort: 'Комфорт',
	room_features: 'В номере',
	kitchen: 'Кухня',
	general: 'Общее',
}

const FREE_PAID_LABELS: Record<AmenityFreePaid, string> = {
	free: 'Бесплатно',
	paid: 'Платно',
	free_for_some: 'Бесплатно для некоторых',
}

interface SelectionEntry {
	freePaid: AmenityFreePaid
	value: string
}

function buildInitialSelection(
	rows: { amenityCode: string; freePaid: AmenityFreePaid; value: string | null }[],
): Map<string, SelectionEntry> {
	const m = new Map<string, SelectionEntry>()
	for (const r of rows) {
		m.set(r.amenityCode, { freePaid: r.freePaid, value: r.value ?? '' })
	}
	return m
}

export function AmenitiesStep({ propertyId }: Props) {
	const canUpdate = useCan({ amenity: ['create', 'update', 'delete'] })
	const { data: rows = [], isLoading, error } = useAmenities(propertyId)
	const setAmenities = useSetAmenities(propertyId)
	const next = useContentWizardStore((s) => s.next)
	const headingId = useId()
	const filterId = useId()

	const [selection, setSelection] = useState<Map<string, SelectionEntry> | null>(null)
	const [filter, setFilter] = useState<AmenityCategory | 'all'>('all')

	// Hydrate selection once data lands (and again if propertyId changes
	// — handled by the `propertyId` part of the key effectively via a
	// remount when the prop changes).
	const effectiveSelection = useMemo(() => {
		if (selection !== null) return selection
		return buildInitialSelection(rows)
	}, [selection, rows])

	const visibleCatalog = useMemo<readonly AmenityDefinition[]>(
		() =>
			filter === 'all' ? AMENITY_CATALOG : AMENITY_CATALOG.filter((a) => a.category === filter),
		[filter],
	)

	const grouped = useMemo(() => {
		const out = new Map<AmenityCategory, AmenityDefinition[]>()
		for (const def of visibleCatalog) {
			const arr = out.get(def.category) ?? []
			arr.push(def)
			out.set(def.category, arr)
		}
		return out
	}, [visibleCatalog])

	function toggle(def: AmenityDefinition, on: boolean) {
		const next = new Map(effectiveSelection)
		if (on) {
			next.set(def.code, { freePaid: def.defaultFreePaid, value: '' })
		} else {
			next.delete(def.code)
		}
		setSelection(next)
	}

	function setEntry(code: string, patch: Partial<SelectionEntry>) {
		const next = new Map(effectiveSelection)
		const cur = next.get(code)
		if (!cur) return
		next.set(code, { ...cur, ...patch })
		setSelection(next)
	}

	async function onSave() {
		const items: PropertyAmenityInput[] = Array.from(effectiveSelection.entries()).map(
			([code, entry]) => ({
				amenityCode: code,
				freePaid: entry.freePaid,
				value: entry.value.trim() === '' ? null : entry.value.trim(),
			}),
		)
		await setAmenities.mutateAsync({ items, idempotencyKey: freshIdempotencyKey() })
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

	const selectedCount = effectiveSelection.size

	return (
		<section aria-labelledby={headingId}>
			<h2 id={headingId} className="text-xl font-semibold">
				Удобства
			</h2>
			<p className="text-muted-foreground mt-1 text-sm">
				Multi-select из канонического каталога (64 кода). Используется в публичных виджетах и
				выгружается в каналы продаж (Booking, Expedia, OTA).
			</p>

			{!canUpdate ? (
				<Alert className="mt-4">
					<AlertTitle>Только просмотр</AlertTitle>
					<AlertDescription>
						Редактирование удобств доступно владельцу или менеджеру.
					</AlertDescription>
				</Alert>
			) : null}

			<div className="mt-6 flex flex-wrap items-center gap-3">
				<Label htmlFor={filterId}>Категория</Label>
				<Select value={filter} onValueChange={(v) => setFilter(v as AmenityCategory | 'all')}>
					<SelectTrigger id={filterId} className="w-64">
						<SelectValue />
					</SelectTrigger>
					<SelectContent>
						<SelectItem value="all">Все категории</SelectItem>
						{amenityCategoryValues.map((c) => (
							<SelectItem key={c} value={c}>
								{CATEGORY_LABELS[c]}
							</SelectItem>
						))}
					</SelectContent>
				</Select>
				<span className="text-muted-foreground text-sm">
					Выбрано: <strong className="text-foreground">{selectedCount}</strong> из{' '}
					{AMENITY_CATALOG.length}
				</span>
			</div>

			<div className="mt-6 space-y-6">
				{Array.from(grouped.entries()).map(([category, defs]) => (
					<fieldset key={category} className="border-border rounded-md border p-4">
						<legend className="text-sm font-medium px-2">{CATEGORY_LABELS[category]}</legend>
						<ul className="mt-2 space-y-3">
							{defs.map((def) => {
								const entry = effectiveSelection.get(def.code)
								const checked = entry !== undefined
								const checkboxId = `amn-${def.code}`
								const valueId = `amn-${def.code}-value`
								return (
									<li key={def.code} className="flex flex-col gap-2 sm:flex-row sm:items-center">
										<div className="flex flex-1 items-center gap-2">
											<Checkbox
												id={checkboxId}
												checked={checked}
												disabled={!canUpdate}
												onCheckedChange={(v) => toggle(def, v === true)}
											/>
											<Label htmlFor={checkboxId} className="font-normal">
												{def.labelRu}
											</Label>
										</div>
										{checked && entry ? (
											<div className="flex items-center gap-2">
												<Select
													value={entry.freePaid}
													onValueChange={(v) =>
														setEntry(def.code, { freePaid: v as AmenityFreePaid })
													}
													disabled={!canUpdate}
												>
													<SelectTrigger className="w-44">
														<SelectValue />
													</SelectTrigger>
													<SelectContent>
														<SelectItem value="free">{FREE_PAID_LABELS.free}</SelectItem>
														<SelectItem value="paid">{FREE_PAID_LABELS.paid}</SelectItem>
														<SelectItem value="free_for_some">
															{FREE_PAID_LABELS.free_for_some}
														</SelectItem>
													</SelectContent>
												</Select>
												{def.supportsValue ? (
													<Input
														id={valueId}
														value={entry.value}
														onChange={(e) => setEntry(def.code, { value: e.target.value })}
														disabled={!canUpdate}
														placeholder="Напр. 100 Мбит/с"
														maxLength={200}
														className="w-44"
														aria-label={`Значение для ${def.labelRu}`}
													/>
												) : null}
											</div>
										) : null}
									</li>
								)
							})}
						</ul>
					</fieldset>
				))}
			</div>

			<div className="mt-8 flex items-center gap-3">
				<Button
					type="button"
					size="lg"
					onClick={() => void onSave()}
					disabled={!canUpdate || setAmenities.isPending}
				>
					{setAmenities.isPending ? 'Сохраняем…' : 'Сохранить'}
				</Button>
				<Button type="button" variant="ghost" onClick={() => next()}>
					Далее — описание
				</Button>
			</div>
		</section>
	)
}
