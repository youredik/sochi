import { Minus, Plus } from 'lucide-react'
import { useCallback } from 'react'
import { Button } from '../../../components/ui/button.tsx'
import { Input } from '../../../components/ui/input.tsx'

/**
 * `<OversellDeltaField>` — signed-integer editor for per-day overbook delta
 * (Apaleo «Allowed Overbooking» canon 2026). Effective allotment =
 * `allotment + oversellDelta`. Negative = pull units offline. Positive =
 * intentional oversell (revenue-mgr policy).
 *
 * Design: stepper-with-free-text hybrid per NN/g 2026:
 *   - Native `<input type="number">` for keyboard ArrowUp/Down + APG
 *     spinbutton role (implicit, no aria-role override per MDN).
 *   - +/− buttons sized 44×44 (WCAG 2.5.5) — required as PRIMARY signed-
 *     entry affordance on mobile because iOS numpad loses minus key
 *     когда minValue < 0 (React Aria caveat 2026).
 *   - Signed display via `Intl.NumberFormat('ru-RU', {signDisplay:'exceptZero'})`
 *     produces `+2`, `0`, `−1` (U+2212 minus in RU locale).
 *
 * No new deps — built on existing shadcn `<Input>` + `<Button>` + Lucide
 * icons + `Intl` API. ~120 LOC vs ~80 LOC pure-input alternative; trade
 * earns mobile a11y + APG keyboard nav.
 *
 * Bounds: -1000..+1000 (defaults). Zod schema in
 * `packages/shared/src/availability.ts` enforces same range at API boundary
 * — caller MUST pass already-validated values. Component clamps on blur
 * silently to keep within visible bounds; out-of-range typing surfaces
 * через caller-provided onChange handler (operator's form layer reports
 * Zod error via `<FieldError>`).
 */

export interface OversellDeltaFieldProps {
	/** Current signed value (controlled). Caller-validated against bounds. */
	readonly value: number
	readonly onChange: (next: number) => void
	readonly min?: number
	readonly max?: number
	readonly step?: number
	readonly disabled?: boolean
	readonly id?: string
	readonly ariaDescribedBy?: string
}

const DEFAULT_MIN = -1000
const DEFAULT_MAX = 1000
const DEFAULT_STEP = 1

const SIGNED_FORMATTER = new Intl.NumberFormat('ru-RU', { signDisplay: 'exceptZero' })

function clamp(v: number, min: number, max: number): number {
	if (v < min) return min
	if (v > max) return max
	return v
}

export function OversellDeltaField({
	value,
	onChange,
	min = DEFAULT_MIN,
	max = DEFAULT_MAX,
	step = DEFAULT_STEP,
	disabled = false,
	id,
	ariaDescribedBy,
}: OversellDeltaFieldProps) {
	const decrement = useCallback(() => {
		onChange(clamp(value - step, min, max))
	}, [value, step, min, max, onChange])

	const increment = useCallback(() => {
		onChange(clamp(value + step, min, max))
	}, [value, step, min, max, onChange])

	const handleInputChange = useCallback(
		(e: React.ChangeEvent<HTMLInputElement>) => {
			const raw = e.target.value
			if (raw === '' || raw === '-') {
				// Allow transient empty / single-minus states during typing;
				// don't fire onChange — caller's state stays valid.
				return
			}
			const parsed = Number(raw)
			if (Number.isFinite(parsed) && Number.isInteger(parsed)) {
				// NO silent-clamp here (canon `[[silent-clamp-anti-pattern]]`) —
				// emit raw value; caller validates via Zod + surfaces FieldError
				// if out of bounds.
				onChange(parsed)
			}
		},
		[onChange],
	)

	const handleInputBlur = useCallback(
		(e: React.FocusEvent<HTMLInputElement>) => {
			const raw = e.target.value
			// On blur: empty / single-minus → reset к 0. Out-of-bounds → clamp.
			// Operator gets explicit value back, not silent gibberish.
			if (raw === '' || raw === '-') {
				onChange(0)
				return
			}
			const parsed = Number(raw)
			if (!Number.isFinite(parsed)) {
				onChange(0)
				return
			}
			const intVal = Math.trunc(parsed)
			onChange(clamp(intVal, min, max))
		},
		[min, max, onChange],
	)

	const handleKeyDown = useCallback(
		(e: React.KeyboardEvent<HTMLInputElement>) => {
			// W3C APG spinbutton: PageUp/Down = ±10×step. Browser handles ArrowUp/Down.
			if (e.key === 'PageUp') {
				e.preventDefault()
				onChange(clamp(value + step * 10, min, max))
			} else if (e.key === 'PageDown') {
				e.preventDefault()
				onChange(clamp(value - step * 10, min, max))
			}
		},
		[value, step, min, max, onChange],
	)

	const decrementDisabled = disabled || value <= min
	const incrementDisabled = disabled || value >= max

	return (
		<div data-slot="oversell-delta-field" data-value={value} className="flex items-center gap-1">
			<Button
				type="button"
				variant="outline"
				size="icon"
				onClick={decrement}
				disabled={decrementDisabled}
				aria-label="Уменьшить овербукинг"
				className="size-11 shrink-0"
				data-slot="oversell-delta-decrement"
			>
				<Minus className="size-4" aria-hidden="true" />
			</Button>
			<Input
				id={id}
				type="number"
				inputMode="numeric"
				step={step}
				min={min}
				max={max}
				value={value}
				onChange={handleInputChange}
				onBlur={handleInputBlur}
				onKeyDown={handleKeyDown}
				disabled={disabled}
				aria-describedby={ariaDescribedBy}
				aria-label={`Овербукинг ${SIGNED_FORMATTER.format(value)} (от ${SIGNED_FORMATTER.format(min)} до ${SIGNED_FORMATTER.format(max)})`}
				className="w-20 text-center tabular-nums"
				data-slot="oversell-delta-input"
			/>
			<Button
				type="button"
				variant="outline"
				size="icon"
				onClick={increment}
				disabled={incrementDisabled}
				aria-label="Увеличить овербукинг"
				className="size-11 shrink-0"
				data-slot="oversell-delta-increment"
			>
				<Plus className="size-4" aria-hidden="true" />
			</Button>
		</div>
	)
}

/**
 * Read-only display variant — used in grid cells / banners когда `value !== 0`.
 * Returns null when value is 0 (no badge when no delta — keep grid clean).
 * Amber/rose color per Apaleo / TravelLine canon: warning-amber для positive
 * oversell, rose-destructive для negative (units pulled offline).
 */
export function OversellDeltaBadge({ value }: { value: number }) {
	if (value === 0) return null
	const isPositive = value > 0
	const palette = isPositive ? 'bg-amber-50 text-amber-700' : 'bg-rose-50 text-rose-700'
	return (
		<span
			data-slot="oversell-delta-badge"
			data-value={value}
			data-sign={isPositive ? 'positive' : 'negative'}
			className={`ml-1 inline-block rounded px-1.5 py-0.5 text-xs font-medium tabular-nums ${palette}`}
			title={`Овербукинг: ${SIGNED_FORMATTER.format(value)} мест сверх квоты`}
		>
			{SIGNED_FORMATTER.format(value)}
		</span>
	)
}
