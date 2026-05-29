import { PASSPORT_COUNTRY_WHITELIST_RU } from '@horeca/shared'
import { useId, useMemo, useState } from 'react'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from '@/components/ui/select'

/**
 * Shared citizenship picker — ISO 3166-1 alpha-3 (lowercase canon, e.g. `rus`).
 *
 * Извлечён из passport-scan-dialog CitizenshipRow (2026-05-29) для переиспользования
 * в booking-create-sheet — единый источник правды для выбора гражданства (раньше
 * форма создания брони имела free-text `^[A-Z]{2,3}$` с alpha-2/3 путаницей).
 *
 * UX (Sprint C canon): dropdown из `PASSPORT_COUNTRY_WHITELIST_RU` (страны,
 * поддерживаемые Vision OCR) + «Другая страна» → raw alpha-3 input для
 * неклассифицированных. Снижает typo + matches PASSPORT_COUNTRY_WHITELIST_SET на
 * backend. Хранимое значение — iso3 lowercase; backend `isRussianCitizenship`/
 * `isForeignCitizenship` принимают и alpha-2, и alpha-3 (case-insensitive).
 */
export function CitizenshipSelect({
	value,
	onChange,
	label = 'Гражданство (ISO-3)',
}: {
	readonly value: string
	readonly onChange: (v: string) => void
	readonly label?: string
}) {
	const id = useId()
	const errorId = useId()
	const knownValues = useMemo(() => new Set(PASSPORT_COUNTRY_WHITELIST_RU.map((c) => c.iso3)), [])
	// Если value — unknown ISO-3 (напр. OCR вернул не-whitelist страну) → 'OTHER'.
	const isKnown = value.length === 0 || knownValues.has(value)
	const selectValue = value.length === 0 ? '' : isKnown ? value : 'OTHER'
	const [showRawInput, setShowRawInput] = useState(!isKnown)

	return (
		<div className="space-y-1.5">
			<Label htmlFor={id} className="text-sm">
				{label}
			</Label>
			<Select
				value={selectValue}
				onValueChange={(v) => {
					if (v === 'OTHER') {
						setShowRawInput(true)
						onChange('')
					} else {
						setShowRawInput(false)
						onChange(v)
					}
				}}
			>
				<SelectTrigger id={id} className="w-full">
					<SelectValue placeholder="Выберите страну" />
				</SelectTrigger>
				<SelectContent>
					{PASSPORT_COUNTRY_WHITELIST_RU.map((c) => (
						<SelectItem key={c.iso3} value={c.iso3}>
							{c.labelRu} ({c.iso3.toUpperCase()})
						</SelectItem>
					))}
					<SelectItem value="OTHER">Другая страна — ввести вручную</SelectItem>
				</SelectContent>
			</Select>
			{showRawInput ? (
				<Input
					value={value}
					placeholder="ISO 3166-1 alpha-3 (например, jpn)"
					onChange={(e) => onChange(e.target.value.toLowerCase().slice(0, 3))}
					maxLength={3}
					aria-describedby={errorId}
					aria-label="ISO-3 код страны вручную"
				/>
			) : null}
			<p id={errorId} className="sr-only">
				Введите 3-буквенный ISO 3166-1 alpha-3 код страны. Не-РФ гражданство требует миграционного
				учёта МВД.
			</p>
		</div>
	)
}
