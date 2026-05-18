import { I18nProvider } from '@lingui/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { createRouter, RouterProvider } from '@tanstack/react-router'
import { MotionConfig } from 'motion/react'
import * as React from 'react'
import { createRoot } from 'react-dom/client'
import { Toaster } from 'sonner'
import { broadcastQueryClient } from '@tanstack/query-broadcast-client-experimental'
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
void import('./lib/rum/index.ts').then((m) => m.startRum())

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

	// G11 v3 (2026-05-18) — one-shot boot wipe of any auth state poisoned
	// by pre-fix persister builds. Existing users have `['auth', 'session']`
	// stored в IndexedDB с stale `null` от anonymous probe; predicate fix
	// prevents FUTURE writes, but the already-stored entry needs explicit
	// removal — otherwise `experimental_createQueryPersister` rehydrates
	// it on cold boot ДО any auth event can fire. `queryClient.removeQueries`
	// touches только in-memory cache; `persister.removeQueries` hits
	// IndexedDB via the storage adapter (`idb-keyval` `del`). Both needed:
	// remove already-mounted query state + delete persistent storage.
	// Idempotent: после первого успешного boot key gone, future boots no-op.
	queryClient.removeQueries({ queryKey: ['auth'] })
	void queryPersister.removeQueries({ queryKey: ['auth'], exact: false })
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
