/**
 * Filter bar для tourism-tax report — quick quarter presets + property
 * select + XLSX download button.
 *
 * URL state управляется через TanStack Router search params в parent route;
 * этот компонент только UI + emit-callbacks.
 *
 * Per memory `project_ru_tax_form_2026q1.md`: декларация подаётся
 * квартально (НК РФ ст. 418.7), поэтому quick-presets — последние
 * 4 квартала + текущий.
 */
import type { Property } from '@horeca/shared'
import { Download } from 'lucide-react'
import { useId } from 'react'
import { Button } from '../../../components/ui/button.tsx'
import { Label } from '../../../components/ui/label.tsx'
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from '../../../components/ui/select.tsx'
import {
	formatQuarterLabel,
	lastNQuarters,
	quarterEnd,
	quarterStart,
	type YearQuarter,
} from '../lib/quarter-defaults.ts'

export interface TaxFilterValue {
	from: string
	to: string
	propertyId: string | null
}

const ALL_PROPERTIES_VALUE = '__all__'

export function TaxFilterBar({
	value,
	properties,
	xlsxUrl,
	onChange,
	now = new Date(),
}: {
	value: TaxFilterValue
	properties: Property[]
	xlsxUrl: string
	onChange: (next: TaxFilterValue) => void
	/** Inject for tests. */
	now?: Date
}) {
	const presets = lastFourQuarters(now)
	const presetMatch = presets.find(
		(p) => quarterStart(p.yq) === value.from && quarterEnd(p.yq) === value.to,
	)
	const periodId = useId()
	const propertyId = useId()

	return (
		<div className="flex flex-wrap items-end gap-4">
			<div className="space-y-1">
				<Label htmlFor={periodId}>Период</Label>
				<Select
					value={presetMatch ? presetKey(presetMatch.yq) : 'custom'}
					onValueChange={(v) => {
						if (v === 'custom') return
						const found = presets.find((p) => presetKey(p.yq) === v)
						if (!found) return
						onChange({
							from: quarterStart(found.yq),
							to: quarterEnd(found.yq),
							propertyId: value.propertyId,
						})
					}}
				>
					<SelectTrigger id={periodId} className="w-56">
						<SelectValue placeholder="Выберите квартал" />
					</SelectTrigger>
					<SelectContent>
						{presets.map((p) => (
							<SelectItem key={presetKey(p.yq)} value={presetKey(p.yq)}>
								{p.label}
							</SelectItem>
						))}
						{!presetMatch && (
							<SelectItem value="custom" disabled>
								Произвольный диапазон
							</SelectItem>
						)}
					</SelectContent>
				</Select>
			</div>

			<div className="space-y-1">
				<Label htmlFor={propertyId}>Объект</Label>
				<Select
					value={value.propertyId ?? ALL_PROPERTIES_VALUE}
					onValueChange={(v) => {
						onChange({
							...value,
							propertyId: v === ALL_PROPERTIES_VALUE ? null : v,
						})
					}}
				>
					<SelectTrigger id={propertyId} className="w-64">
						<SelectValue />
					</SelectTrigger>
					<SelectContent>
						<SelectItem value={ALL_PROPERTIES_VALUE}>Все объекты</SelectItem>
						{properties.map((p) => (
							<SelectItem key={p.id} value={p.id}>
								{p.name}
							</SelectItem>
						))}
					</SelectContent>
				</Select>
			</div>

			<div className="flex-1" />

			<Button asChild variant="default">
				<a href={xlsxUrl} download>
					<Download className="size-4" aria-hidden />
					Скачать XLSX
				</a>
			</Button>
		</div>
	)
}

function presetKey(yq: YearQuarter): string {
	return `${yq.year}-Q${yq.quarter}`
}

/** Текущий квартал + 3 предыдущих с RU-локализованными лейблами. */
function lastFourQuarters(now: Date): { yq: YearQuarter; label: string }[] {
	return lastNQuarters(now, 4).map((yq, i) => ({
		yq,
		label: i === 0 ? `Текущий — ${formatQuarterLabel(yq)}` : formatQuarterLabel(yq),
	}))
}
