/**
 * `<Money>` and `<MoneyInput>` — canonical RU-locale money UI components.
 *
 * Per memory `project_m6_7_frontend_research.md` (3-round research synthesis):
 *
 * **`<Money>`** renders money for both sighted users + screen readers. Pattern:
 * visible `aria-hidden` span with `Intl.NumberFormat('ru-RU')` formatted text +
 * sr-only span with full pronunciation ("1500 рублей 50 копеек") so the SR reads
 * the natural Russian phrase instead of "one five zero zero".
 *
 * Anti-pattern caught from Mercado Libre case study: bare `<span aria-label>`
 * is IGNORED by ARIA spec (span has no implicit role). Canonical 2026 pattern
 * is the dual-span form below.
 *
 * **`<MoneyInput>`** wraps `react-number-format` 5.4.5 with the canonical
 * RU-locale config:
 *   - `inputMode="decimal"` (iPad Safari numeric pad with comma)
 *   - `decimalSeparator=","` (RU)
 *   - `thousandSeparator=" "` (NBSP — matches Intl.NumberFormat output)
 *   - `decimalScale={2}` (kopeck precision)
 *   - `allowNegative={false}`
 *   - `valueIsNumericString` (controlled via string, parsed with
 *     `moneyKopecksSchema` on submit)
 *   - `suffix=" ₽"` (visual; stripped on parse)
 *
 * **Why not native `<input type="number">`:** strips trailing zeros, breaks
 * RU comma decimal, no NBSP grouping, locale-clamped behavior across browsers.
 */
import type { Ref } from 'react'
import { NumericFormat, type NumericFormatProps } from 'react-number-format'
import { formatMoney, formatMoneyA11y } from '../lib/format-ru.ts'
import { cn } from '../lib/utils.ts'

/**
 * Render kopecks (Int64 minor) as canonical RU money.
 *
 * - Visible span: "1 500,00 ₽" (NBSP groups, comma decimal, NBSP+₽).
 *   `aria-hidden="true"` so screen readers SKIP this — they'd otherwise read
 *   the digits as "one five zero zero".
 * - Sr-only span: "1500 рублей 0 копеек" with proper RU plural agreement.
 *   Read instead by VoiceOver / NVDA / JAWS.
 *
 * Use `tabular-nums` so columns of money values align under proportional fonts
 * (Inter Variable / Geist Variable both ship `tnum` OpenType feature).
 */
export function Money({ kopecks, className }: { kopecks: bigint; className?: string }) {
	return (
		<span className={cn('tabular-nums', className)}>
			<span aria-hidden="true">{formatMoney(kopecks)}</span>
			<span className="sr-only">{formatMoneyA11y(kopecks)}</span>
		</span>
	)
}

/**
 * `<MoneyInput>` — controlled money input field with RU-locale formatting.
 *
 * Forwards `ref` so it integrates with `@tanstack/react-form` (and any other
 * controlled-form lib that needs the underlying input element). Pair with
 * `moneyKopecksSchema` on submit to convert the displayed string into the
 * canonical bigint kopecks value:
 *
 * ```tsx
 * const [value, setValue] = useState('')
 * <MoneyInput value={value} onValueChange={({ value }) => setValue(value)} />
 * // on submit: moneyKopecksSchema.parse(value) → bigint
 * ```
 *
 * `aria-invalid` + `aria-describedby` via the standard
 * pattern from `@tanstack/react-form` + shadcn `<Field>`.
 */
export type MoneyInputProps = Omit<
	NumericFormatProps,
	'decimalSeparator' | 'thousandSeparator' | 'allowNegative' | 'inputMode'
> & {
	className?: string
	/** React 19 — `ref` is a regular prop now, NOT via `forwardRef` (deprecated for new code per React 19 release notes Dec 2024). */
	ref?: Ref<HTMLInputElement>
}

export function MoneyInput({
	className,
	suffix,
	decimalScale,
	valueIsNumericString,
	ref,
	...rest
}: MoneyInputProps) {
	return (
		<NumericFormat
			// `getInputRef` from react-number-format requires a defined Ref;
			// conditional spread under exactOptionalPropertyTypes.
			{...(ref !== undefined ? { getInputRef: ref } : {})}
			className={cn(
				'flex h-12 w-full rounded-md border border-input bg-background px-3 py-2 text-2xl tabular-nums shadow-sm transition-colors file:border-0 file:bg-transparent file:text-sm file:font-medium placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50',
				className,
			)}
			decimalSeparator=","
			thousandSeparator=" "
			decimalScale={decimalScale ?? 2}
			fixedDecimalScale={false}
			allowNegative={false}
			inputMode="decimal"
			suffix={suffix ?? ' ₽'}
			valueIsNumericString={valueIsNumericString ?? true}
			{...rest}
		/>
	)
}
