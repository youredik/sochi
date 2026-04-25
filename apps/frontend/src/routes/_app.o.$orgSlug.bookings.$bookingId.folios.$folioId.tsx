/**
 * Folio screen — Apaleo single-list canonical layout per memory
 * `project_m6_7_frontend_research.md` (3-round research synthesis).
 *
 * URL: `/o/{orgSlug}/bookings/{bookingId}/folios/{folioId}?tab=lines|payments|refunds`
 *
 * **Architecture:**
 *   - File-based TanStack Router 1.168 (`createFileRoute`).
 *   - `validateSearch`: hand-rolled Zod 4 parse (zod-adapter has Zod-3-only
 *     peer — empirical pnpm gate caught this; see canon).
 *   - `loader`: prefetches folio header + lines + payments via
 *     `queryClient.ensureQueryData` (parallel via Promise.all).
 *   - `pendingComponent` shows skeleton (pendingMs=200, pendingMinMs=500
 *     to avoid flash for sub-200ms loads).
 *   - `errorComponent` shows recovery panel.
 *   - Body uses `useSuspenseQuery` for required data (no `data: undefined`
 *     branches — Suspense boundary handles loading).
 *
 * **Layout (canon):**
 *   - Header strip with breadcrumb + folio Tabs.
 *   - 2-col: payer info (left) + balance card with action buttons (right).
 *   - Lines/Payments/Refunds tabs (lines is default + first).
 *   - Sticky balance footer (TODO when content overflows viewport).
 *
 * **A11y per canon (axe-core 4.11 mandatory pass):**
 *   - One `<main>` per route.
 *   - One `<h1>` per route ("Фолио · бронь N…").
 *   - `<section>` cards with own `<h2>`.
 *   - `<Money>` component renders visible (aria-hidden) + sr-only expanded.
 *   - Status badge: icon + text + color (NOT color alone — WCAG 1.4.1).
 *   - Money column right-aligned + tabular-nums.
 *   - Negatives: minus sign (NEVER parentheses — non-RU convention).
 */
import type { Payment } from '@horeca/shared'
import { useSuspenseQuery } from '@tanstack/react-query'
import { createFileRoute, Link } from '@tanstack/react-router'
import { useId, useState } from 'react'
import { z } from 'zod'
import { Money } from '../components/money.tsx'
import { RbacButton } from '../components/rbac-button.tsx'
import { Alert, AlertDescription, AlertTitle } from '../components/ui/alert.tsx'
import { Button } from '../components/ui/button.tsx'
import { Card, CardContent, CardHeader, CardTitle } from '../components/ui/card.tsx'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '../components/ui/tabs.tsx'
import { FolioLinesTable } from '../features/folios/components/folio-lines-table.tsx'
import { FolioPaymentsTable } from '../features/folios/components/folio-payments-table.tsx'
import { FolioStatusBadge } from '../features/folios/components/folio-status-badge.tsx'
import { MarkPaidSheet } from '../features/folios/components/mark-paid-sheet.tsx'
import { RefundSheet } from '../features/folios/components/refund-sheet.tsx'
import {
	folioLinesQueryOptions,
	folioPaymentsQueryOptions,
	folioQueryOptions,
} from '../features/folios/hooks/use-folio-queries.ts'
import { canRefundPayment } from '../features/folios/lib/can-refund-payment.ts'
import { formatDateShort } from '../lib/format-ru.ts'
import { useCan } from '../lib/use-can.ts'

/* --------------------------------------------------------- search params */

const folioSearchSchema = z.object({
	tab: z.enum(['lines', 'payments', 'refunds']).catch('lines'),
})
type FolioSearch = z.infer<typeof folioSearchSchema>

/* ---------------------------------------------------------------- route */

export const Route = createFileRoute('/_app/o/$orgSlug/bookings/$bookingId/folios/$folioId')({
	// Hand-rolled validateSearch (no zod-adapter — Zod-3-only peer; canon).
	validateSearch: (input: Record<string, unknown>): FolioSearch => folioSearchSchema.parse(input),
	loader: async ({ context: { queryClient }, params: { folioId } }) =>
		Promise.all([
			queryClient.ensureQueryData(folioQueryOptions(folioId)),
			queryClient.ensureQueryData(folioLinesQueryOptions(folioId)),
			queryClient.ensureQueryData(folioPaymentsQueryOptions(folioId)),
		]),
	pendingComponent: FolioSkeleton,
	errorComponent: FolioErrorPanel,
	pendingMs: 200,
	pendingMinMs: 500,
	component: FolioRoute,
})

/* ============================================================ pending */

function FolioSkeleton() {
	return (
		<main aria-busy="true" aria-live="polite" className="container mx-auto p-6">
			<div className="space-y-4">
				<div className="h-8 w-1/3 animate-pulse rounded bg-muted" />
				<div className="grid gap-4 md:grid-cols-[1fr_auto]">
					<div className="h-40 animate-pulse rounded bg-muted" />
					<div className="h-40 w-72 animate-pulse rounded bg-muted" />
				</div>
				<div className="h-96 animate-pulse rounded bg-muted" />
			</div>
		</main>
	)
}

/* ============================================================ error panel */

function FolioErrorPanel({ error }: { error: Error }) {
	return (
		<main className="container mx-auto p-6">
			<Alert variant="destructive" role="alert">
				<AlertTitle>Не удалось загрузить фолио</AlertTitle>
				<AlertDescription>
					{error.message || 'Попробуйте обновить страницу через несколько секунд.'}
				</AlertDescription>
			</Alert>
		</main>
	)
}

/* ============================================================ folio screen */

function FolioRoute() {
	const { folioId } = Route.useParams()
	const search = Route.useSearch()
	const navigate = Route.useNavigate()

	const folio = useSuspenseQuery(folioQueryOptions(folioId)).data
	const lines = useSuspenseQuery(folioLinesQueryOptions(folioId)).data
	const payments = useSuspenseQuery(folioPaymentsQueryOptions(folioId)).data

	// RBAC: staff CANNOT refund (Apaleo/Cloudbeds canon). Server enforces via
	// requirePermission middleware; этот hook — UI hint (aria-disabled + tooltip).
	const canRefund = useCan({ refund: ['create'] })

	// Sheet state. Refund — null = closed, payment object = open with that target.
	// Conditional render (NOT controlled-with-null-payload) гарантирует свежий
	// idempotencyKey + form state на каждое открытие.
	const [markPaidOpen, setMarkPaidOpen] = useState(false)
	const [refundPayment, setRefundPayment] = useState<Payment | null>(null)

	// Stable per-render IDs (lint/correctness/useUniqueElementIds — hardcoded
	// IDs ломаются если route рендерится дважды, e.g. в портале + dev StrictMode).
	const mainId = useId()
	const payerHeadingId = useId()
	const balanceHeadingId = useId()

	return (
		<main className="container mx-auto p-6 space-y-6" id={mainId}>
			{/* h1 — single per route */}
			<header className="space-y-1">
				<h1 className="text-2xl font-semibold tracking-tight">
					Фолио · бронь {folio.bookingId.slice(-6)}
				</h1>
				<p className="text-sm text-muted-foreground">
					№ {folio.id.slice(-8)} · открыто {formatDateShort(folio.createdAt)}
				</p>
			</header>

			{/* 2-col header strip: payer + balance card */}
			<div className="grid gap-4 md:grid-cols-[1fr_auto]">
				<section aria-labelledby={payerHeadingId}>
					<Card>
						<CardHeader>
							<CardTitle id={payerHeadingId} className="text-base">
								Плательщик
							</CardTitle>
						</CardHeader>
						<CardContent className="text-sm">
							<dl className="grid grid-cols-[120px_1fr] gap-1">
								<dt className="text-muted-foreground">Тип фолио</dt>
								<dd>{folioKindLabel(folio.kind)}</dd>
								<dt className="text-muted-foreground">Валюта</dt>
								<dd>{folio.currency}</dd>
								{folio.companyId ? (
									<>
										<dt className="text-muted-foreground">Компания</dt>
										<dd className="font-mono text-xs">{folio.companyId}</dd>
									</>
								) : null}
							</dl>
						</CardContent>
					</Card>
				</section>

				<section aria-labelledby={balanceHeadingId} className="md:w-72">
					<Card>
						<CardHeader>
							<CardTitle id={balanceHeadingId} className="text-base text-muted-foreground">
								Баланс к оплате
							</CardTitle>
						</CardHeader>
						<CardContent className="space-y-3">
							<div className="text-3xl font-bold tabular-nums">
								<Money kopecks={BigInt(folio.balanceMinor)} />
							</div>
							<div className="flex flex-col gap-2">
								<Button
									type="button"
									variant="default"
									className="h-12 w-full"
									disabled={folio.status !== 'open'}
									onClick={() => setMarkPaidOpen(true)}
								>
									Принять оплату
								</Button>
								{payments.some((p) => canRefundPayment(p)) ? (
									<RbacButton
										can={canRefund}
										deniedReason="Возврат: требуется роль Менеджер"
										type="button"
										variant="outline"
										className="h-12 w-full"
										onClick={() => {
											// Per-payment refund — switch to Payments tab; per-row
											// «Возврат» кнопка инициирует фактический refund.
											void navigate({ search: { tab: 'payments' } })
										}}
									>
										Возврат
									</RbacButton>
								) : null}
							</div>
							<FolioStatusBadge status={folio.status} />
						</CardContent>
					</Card>
				</section>
			</div>

			{/* Tabs — Lines / Payments / Refunds (refunds tab is empty placeholder for now) */}
			<Tabs
				value={search.tab}
				onValueChange={(value) => {
					const next = folioSearchSchema.parse({ tab: value })
					void navigate({ search: next })
				}}
			>
				<TabsList>
					<TabsTrigger value="lines">Начисления ({lines.length})</TabsTrigger>
					<TabsTrigger value="payments">Платежи ({payments.length})</TabsTrigger>
					<TabsTrigger value="refunds">Возвраты</TabsTrigger>
				</TabsList>

				<TabsContent value="lines">
					<FolioLinesTable lines={lines} />
				</TabsContent>
				<TabsContent value="payments">
					<FolioPaymentsTable payments={payments} onRefund={setRefundPayment} />
				</TabsContent>
				<TabsContent value="refunds">
					<p className="py-8 text-center text-muted-foreground">
						Возвраты делайте из карточки платежа на вкладке «Платежи».
					</p>
				</TabsContent>
			</Tabs>

			{/* Mark Paid Sheet — conditionally rendered чтобы `useMemo(crypto.randomUUID, [])`
				внутри пересоздавал idempotency-key на каждое открытие (canon: per-dialog-mount).
				Без conditional render первый платёж succeeds, второй replays → silent skip.
				Self-audit catch (M6.7.7 closing). Mirror RefundSheet pattern. */}
			{markPaidOpen ? (
				<MarkPaidSheet
					open={true}
					onOpenChange={setMarkPaidOpen}
					propertyId={folio.propertyId}
					bookingId={folio.bookingId}
					folioId={folio.id}
					currentBalanceMinor={BigInt(folio.balanceMinor)}
				/>
			) : null}

			{/* Refund Sheet — conditionally rendered чтобы каждое открытие давало
				свежий idempotencyKey + reset form state. Sheet хранит payment в
				замыкании; close → unmount → next open генерирует новый key. */}
			{refundPayment !== null ? (
				<RefundSheet
					open={true}
					onOpenChange={(o) => {
						if (!o) setRefundPayment(null)
					}}
					payment={refundPayment}
					folioId={folio.id}
				/>
			) : null}

			<nav aria-label="Навигация">
				<Button asChild variant="ghost" size="sm">
					<Link to="/o/$orgSlug" params={{ orgSlug: Route.useParams().orgSlug }}>
						← Дашборд
					</Link>
				</Button>
			</nav>
		</main>
	)
}

/* ============================================================ helpers */

function folioKindLabel(kind: string): string {
	switch (kind) {
		case 'guest':
			return 'Гостевое'
		case 'company':
			return 'Корпоративное'
		case 'group_master':
			return 'Группа (мастер)'
		case 'ota_receivable':
			return 'OTA: к получению'
		case 'ota_payable':
			return 'OTA: к выплате'
		case 'transitory':
			return 'Транзитное'
		default:
			return kind
	}
}
