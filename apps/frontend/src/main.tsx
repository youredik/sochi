import { I18nProvider } from '@lingui/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { createRouter, RouterProvider } from '@tanstack/react-router'
import { MotionConfig } from 'motion/react'
import * as React from 'react'
import { createRoot } from 'react-dom/client'
import { Toaster } from 'sonner'
import { i18n, setupI18n } from './features/i18n/setup.ts'
import { setupOtel } from './features/observability/setup-otel.ts'
import { ErrorBoundary } from './lib/error-boundary.tsx'
import { logger } from './lib/logger.ts'
import { routeTree } from './routeTree.gen.ts'
import './index.css'

// Observability + i18n must boot before the first render so route `beforeLoad`
// guards emit traces and any suspended query uses the hydrated `i18n._()`
// singleton from the very first navigation. OTel → /api/otel/v1/traces →
// Yandex Monium in prod; structured `logger` is complementary for app
// events (pino-shape, console transport in dev, backend-POST in prod).
setupOtel()
setupI18n()

const queryClient = new QueryClient({
	defaultOptions: {
		queries: {
			staleTime: 60_000,
			refetchOnWindowFocus: false,
		},
	},
})

const router = createRouter({
	routeTree,
	context: { queryClient },
	defaultPreload: 'intent',
	defaultPreloadStaleTime: 0,
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
					<QueryClientProvider client={queryClient}>
						<RouterProvider router={router} />
						<Toaster position="top-right" richColors closeButton expand={false} visibleToasts={3} />
					</QueryClientProvider>
				</MotionConfig>
			</I18nProvider>
		</ErrorBoundary>
	</React.StrictMode>,
)
