import { SpanStatusCode } from '@opentelemetry/api'
import type { ErrorInfo, ReactNode } from 'react'
import { Component } from 'react'
import { tracer } from '../features/observability/setup-otel.ts'
import { logger } from './logger.ts'

/**
 * Root React error boundary.
 *
 * - Captures render-time exceptions below the root. React 19's `onCaughtError` /
 *   `onUncaughtError` hooks are wired at createRoot in main.tsx (for async
 *   errors and hydration failures respectively); this class boundary covers
 *   the classic render-phase path those hooks don't catch.
 * - Records both: structured `logger.error` (for Cloud Logging flush) AND
 *   OTel span (`span.recordException`) so the error appears in the Monium
 *   trace alongside the user action that triggered it. Dual-emit is cheap
 *   and eliminates "I see the error but not what the user was doing" gaps.
 * - Fallback UI is production-grade (localized, action-oriented), not a
 *   "Something went wrong" placeholder — user can reload without losing
 *   confidence in the product.
 */

interface State {
	error: Error | null
}

interface Props {
	children: ReactNode
}

export class ErrorBoundary extends Component<Props, State> {
	override state: State = { error: null }

	static getDerivedStateFromError(error: Error): State {
		return { error }
	}

	override componentDidCatch(error: Error, info: ErrorInfo): void {
		logger.error('react render error', {
			name: error.name,
			message: error.message,
			stack: error.stack,
			componentStack: info.componentStack,
		})
		tracer.startActiveSpan('react.render.error', (span) => {
			span.setAttribute('error.type', error.name)
			span.setAttribute('react.componentStack', info.componentStack ?? '')
			span.recordException(error)
			span.setStatus({ code: SpanStatusCode.ERROR, message: error.message })
			span.end()
		})
	}

	private handleReload = () => {
		window.location.reload()
	}

	override render(): ReactNode {
		if (this.state.error) {
			return (
				<div
					role="alert"
					aria-live="assertive"
					className="mx-auto max-w-md px-6 py-16 text-neutral-100"
				>
					<h1 className="text-2xl font-semibold">Что-то пошло не так</h1>
					<p className="mt-3 text-sm text-neutral-400">
						Мы записали ошибку и уже работаем над ней. Попробуйте обновить страницу.
					</p>
					<button
						type="button"
						onClick={this.handleReload}
						className="mt-6 rounded-md bg-neutral-100 px-4 py-2 text-sm font-medium text-neutral-900 hover:bg-white focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-500"
					>
						Обновить страницу
					</button>
				</div>
			)
		}
		return this.props.children
	}
}
