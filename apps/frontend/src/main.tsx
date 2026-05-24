import { I18nProvider } from '@lingui/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { createRouter, RouterProvider } from '@tanstack/react-router'
import { MotionConfig } from 'motion/react'
import * as React from 'react'
import { createRoot } from 'react-dom/client'
import { Toaster } from 'sonner'
import { broadcastQueryClient } from '@tanstack/query-broadcast-client-experimental'
import { CookieBanner } from './components/cookie-banner.tsx'
import { OfflineBanner } from './components/offline-banner'
import { SwUpdatePrompt } from './components/sw-update-prompt'
import { i18n, setupI18n } from './features/i18n/setup.ts'
import { setupOtel } from './features/observability/setup-otel.ts'
import { ErrorBoundary } from './lib/error-boundary.tsx'
import { logger } from './lib/logger.ts'
import { createOfflineQueryPersister } from './lib/offline/persister.ts'
import { ThemeProvider } from './lib/theme-provider.tsx'
import { reportWebVitals } from './lib/web-vitals.ts'
import { routeTree } from './routeTree.gen.ts'
import './index.css'

// Observability + i18n must boot before the first render so route `beforeLoad`
// guards emit traces and any suspended query uses the hydrated `i18n._()`
// singleton from the very first navigation. OTel → /api/otel/v1/traces →
// Yandex Monium in prod; structured `logger` is complementary for app
// events (pino-shape, console transport in dev, backend-POST in prod).
setupOtel()
setupI18n()
// M9.6 — wire web-vitals 5 (CLS/INP/LCP/FCP/TTFB) к OTel tracer. Spans no-op
// до Monium activation, but data collection production-grade с первой строчки.
reportWebVitals()
// M9.widget.7 / A5.2 — separate RUM pipeline: web-vitals 5 attribution build
// → 152-ФЗ anonymize (selector / UA / URL scrub) → batched POST `/api/rum/v1/web-vitals`.
// Backend bridges to Yandex Cloud Monitoring (D7). Idempotent — React StrictMode
// double-register-safe via `started` singleton.
//
// **Code-split for SPA-index budget**: RUM lib (web-vitals/attribution + anonymize +
// shared/rum schema) is ~3 KB gzipped — keeping it out of the initial chunk pulls
// us back under the 180 KB SPA-index budget (M9.widget.7 / A5.1). web-vitals
// callbacks are async by design (PerformanceObserver-driven) — нет смысла
// блокировать LCP-критический путь impportom.
// Sprint C+ Round 6 self-review fix 2026-05-24 (Adversarial code review P0):
// RUM ships UA + URL + IP-derived metrics к /api/rum/v1/web-vitals. Под 152-ФЗ
// ст.6 + ст.18 это identifiable analytics → ОБЯЗАТЕЛЬНО за consent gate same
// как Yandex Metrika. Без gate то же violation 150-300к ₽ КоАП ст.13.11 ч.3.
void Promise.all([import('./lib/rum/index.ts'), import('./lib/cookie-consent.ts')]).then(
	([rumMod, consent]) => {
		let started = false
		function maybeStartRum(): void {
			if (started) return
			if (!consent.isGranted('analytics')) return
			started = true
			rumMod.startRum()
		}
		maybeStartRum()
		consent.onConsentChange(maybeStartRum)
	},
)

// G11 (2026-05-16) — TanStack Query offline canon (R1+R2 ≥ 2026-05-16):
//   - networkMode: 'offlineFirst' (createPersister default — fires request
//     so SW can intercept; cache hit success; cache miss pauses retries)
//   - gcTime 7 days (weekend offline coverage; matches persister maxAge)
//   - per-query persister via experimental_createQueryPersister + idb-keyval
//   - buster=VITE_GIT_SHA invalidates ALL cache on deploy
const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000
const queryPersister = createOfflineQueryPersister()
const queryClient = new QueryClient({
	defaultOptions: {
		queries: {
			staleTime: 60_000,
			gcTime: SEVEN_DAYS_MS,
			networkMode: 'offlineFirst',
			refetchOnWindowFocus: false,
			persister: queryPersister.persisterFn,
		},
		mutations: {
			networkMode: 'offlineFirst',
		},
	},
})

// G11 v2 (2026-05-16) — cross-tab cache invalidation per R1+R2 ≥ 2026-05-15
// canon. `broadcastQueryClient` uses BroadcastChannel — when operator
// edits booking в tab A, tab B's cache invalidates automatically. No
// mutation-state sync (TanStack limitation — last-write-wins per-tab),
// но invalidations + data updates auto-sync. Production canon 2026.
if (typeof window !== 'undefined') {
	broadcastQueryClient({ queryClient, broadcastChannel: 'sochi-pms-cache' })
	logger.info('offline: cross-tab broadcastQueryClient mounted')

	// G11 v3 (2026-05-18) — one-shot boot wipe of state poisoned by pre-fix
	// G11 v2 persister builds. Three categories of stale IndexedDB entries:
	//   1. `['auth', 'session']` — cached null от anonymous probe →
	//      bounced fresh magic-link verify (first reported bug).
	//   2. `['bookings', ...]` — guestSnapshot stripped к null via prior
	//      `stripPiiFromTree` → downstream `.trim()` crashed («Cannot read
	//      properties of null (reading 'trim')», 2nd reported bug 2026-05-18).
	//      v3 fix projects grid query к narrow shape (no PII) на receive;
	//      old persisted entries still carry stripped guestSnapshot rooted
	//      в IDB until wiped.
	//   3. `['booking', id]` + `['unassigned', ...]` — same stripped-null
	//      cascade; v3 marks these queries `meta: { persist: false }`.
	// `queryClient.removeQueries` touches in-memory; `persister.removeQueries`
	// hits IndexedDB. Both needed. Idempotent: after first boot все ключи
	// gone, future boots no-op.
	for (const key of [['auth'], ['bookings'], ['booking'], ['unassigned']] as const) {
		queryClient.removeQueries({ queryKey: key })
		void queryPersister.removeQueries({ queryKey: key, exact: false })
	}
}

const router = createRouter({
	routeTree,
	context: { queryClient },
	defaultPreload: 'intent',
	defaultPreloadStaleTime: 0,
	// M9.5: page cross-fade between routes via View Transitions API.
	// Browser handles `prefers-reduced-motion` automatically (View Transitions
	// API spec). Single line — Vercel-в-проде canon (Round 5 research,
	// TanStack Router official example). Plan §M9.5 5.8.
	defaultViewTransition: true,
})

declare module '@tanstack/react-router' {
	interface Register {
		router: typeof router
	}
}

// Yandex.Metrika analytics — counter 109307396 (created 2026-05-19).
// Conditional на `VITE_YANDEX_METRIKA_ID` — no-op в dev/test где env не set.
// Deferred init за `requestIdleCallback` + first-interaction trigger
// (scroll/click/keydown) — LCP optimization per
// `project_landing_research_2026_05_19`. SPA navigation hits через
// router.subscribe('onResolved') — tracking каждой client-side
// route-change (initial pageview fires автоматически тегом-script'ом).
// Code-split via dynamic import keeps initial SPA bundle clean.
//
// Sprint C+ Round 6 Legal P0 fix 2026-05-24 — 152-ФЗ cookie opt-in:
// Metrika init теперь GATED за `cookie-consent.isGranted('analytics')`. До
// user explicit accept Метрика не загружается. После accept — subscribe to
// consent state и init deferred. SPA pageview tracking тоже gated.
void Promise.all([import('./lib/yandex-metrika.ts'), import('./lib/cookie-consent.ts')]).then(
	([metrika, consent]) => {
		const rawId = import.meta.env.VITE_YANDEX_METRIKA_ID
		const counterId = rawId ? Number(rawId) : undefined
		if (counterId === undefined) return

		let initialized = false
		function maybeInit(): void {
			if (initialized) return
			if (!consent.isGranted('analytics')) return
			initialized = true
			metrika.initYandexMetrikaDeferred(counterId)
			router.subscribe('onResolved', ({ toLocation }) => {
				// `.href` = pathname + searchStr + hash для Метрики 'hit'.
				metrika.trackPageView(toLocation.href)
			})
		}

		// 1. Try init immediately — user уже decided ранее (return visitor)
		maybeInit()
		// 2. Subscribe to consent changes — fires когда user accepts на banner
		consent.onConsentChange(maybeInit)
	},
)

const rootEl = document.getElementById('root')
if (!rootEl) throw new Error('Root element #root not found')

// React 19 error hooks: `onCaughtError` fires for errors that any boundary
// (including ours) re-caught; `onUncaughtError` for errors that bubbled to
// the root. React 19 typed these as `unknown` (vs `Error` in 18) — narrow
// defensively before extracting stack. Log via the structured logger so
// the record shape stays stable when the transport flips to fetch→backend.
function logReactRootError(
	tag: string,
	error: unknown,
	info: { componentStack?: string | undefined },
) {
	const err = error instanceof Error ? error : new Error(String(error))
	logger.error(tag, {
		name: err.name,
		message: err.message,
		stack: err.stack,
		componentStack: info.componentStack,
	})
}

createRoot(rootEl, {
	onCaughtError: (error, info) => logReactRootError('react caught error', error, info),
	onUncaughtError: (error, info) => logReactRootError('react uncaught error', error, info),
}).render(
	<React.StrictMode>
		<ErrorBoundary>
			<I18nProvider i18n={i18n}>
				<MotionConfig reducedMotion="user">
					<ThemeProvider>
						<QueryClientProvider client={queryClient}>
							<OfflineBanner />
							<RouterProvider router={router} />
							<SwUpdatePrompt />
							<CookieBanner />
							<Toaster
								position="top-right"
								richColors
								closeButton
								expand={false}
								visibleToasts={3}
							/>
						</QueryClientProvider>
					</ThemeProvider>
				</MotionConfig>
			</I18nProvider>
		</ErrorBoundary>
	</React.StrictMode>,
)
