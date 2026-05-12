/**
 * KpiCard — single composable KPI tile для dashboard glance strip.
 *
 * Three-state UI per Art of Styleframe 2026 dashboard canon (R1 research
 * 2026-05-12): card chrome PERSISTS across Loading / Value / Empty / Error
 * — no layout shift. Skeleton substitutes the number while loading; the
 * label, icon, and footnote stay stable.
 *
 * Strict canon применен (`feedback_strict_tests.md`):
 *   - `tabular-nums` on the value <span> для stable column-width когда
 *     digit count меняется (KPI ticks from "8" → "10" → "12")
 *   - aria-live="polite" so screen-reader announces value updates когда
 *     polling re-fetch refreshes the number
 *   - `role="status"` on the Skeleton wrapper per `ui/skeleton.tsx` canon
 *
 * NOT exported as a route: pure composition primitive. Consumers (KpiStrip,
 * dashboard-page) wire data → state derivation → this component.
 */
import { Card, CardContent, CardHeader, CardTitle } from '../../../components/ui/card.tsx'
import { Skeleton } from '../../../components/ui/skeleton.tsx'
import { cn } from '../../../lib/utils.ts'

export type KpiCardState =
	| { kind: 'loading' }
	| { kind: 'error'; message: string }
	| { kind: 'value'; value: string; ariaValue?: string }

export type KpiCardProps = {
	readonly slug: string
	readonly title: string
	readonly state: KpiCardState
	/**
	 * Optional secondary line — context, comparison, or description.
	 * Rendered as `<CardDescription>`-style text below the value.
	 * Examples: "за сегодня", "за 7 дней", "Доступно в Yandex DataLens".
	 */
	readonly footnote?: string
}

/**
 * KPI card. State-driven render:
 *   - loading: Skeleton bar replaces number, label + footnote stay
 *   - error: red text + label + retry guidance
 *   - value: large `tabular-nums` number with optional sr-only expansion
 */
export function KpiCard({ slug, title, state, footnote }: KpiCardProps) {
	return (
		<Card
			size="sm"
			data-testid={`kpi-card-${slug}`}
			data-state={state.kind}
			className="min-w-[160px]"
		>
			<CardHeader className="pb-1">
				<CardTitle className="text-muted-foreground text-xs font-medium uppercase tracking-wide">
					{title}
				</CardTitle>
			</CardHeader>
			<CardContent className="flex flex-col gap-1">
				{state.kind === 'loading' ? (
					<div role="status" aria-busy="true" aria-live="polite">
						<span className="sr-only">Загрузка</span>
						<Skeleton className="h-8 w-20" />
					</div>
				) : state.kind === 'error' ? (
					<p role="alert" aria-live="assertive" className="text-destructive text-sm font-medium">
						{state.message}
					</p>
				) : (
					<p aria-live="polite" className="flex items-baseline gap-2">
						<span
							className={cn(
								'text-3xl font-semibold tracking-tight tabular-nums',
								state.value === '0' || state.value === '0 ₽' ? 'text-muted-foreground' : '',
							)}
						>
							{state.value}
						</span>
						{state.ariaValue ? <span className="sr-only">{state.ariaValue}</span> : null}
					</p>
				)}
				{footnote ? <p className="text-muted-foreground text-xs">{footnote}</p> : null}
			</CardContent>
		</Card>
	)
}
