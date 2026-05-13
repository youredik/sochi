import { useEffect, useState } from 'react'
import { Button } from '@/components/ui/button'

/**
 * Demo deployment inline inbox panel — polls
 * `GET /api/public/demo/inbox?email=…` and renders the captured magic-link
 * verify URL as a one-click button. Replaces «check your email» copy для
 * public demo deployments (per `[[demo_strategy]]`) so prospects never need
 * an email account to evaluate the product.
 *
 * **Polling cadence**: 1Hz while the panel is mounted. Stops automatically
 * once a non-null `latestUrl` arrives. Display state machine:
 *   1. «Ждём письмо…» (no capture yet)
 *   2. «Письмо пришло!» + «Открыть и войти →» button (capture has URL)
 *
 * **Capture polling vs SSE**: short-poll is the simpler primitive for the
 * single-prospect-at-a-time demo throughput. Backend route is sync (in-
 * process Map lookup) so 1Hz fan-in is negligible cost.
 *
 * **Production safety**: this component is only mounted by callers when
 * `isDemoDeployment === true`. Backend route returns 404 в production
 * regardless, so even an accidental mount would be a no-op (panel shows
 * stuck-on-loading state).
 */

interface DemoInboxResponse {
	readonly email: string
	readonly latestUrl: string | null
	readonly capturedAt: string | null
	readonly subject: string | null
}

interface DemoInboxPanelProps {
	/** Email прозрачно прокинутый из родительской формы (magic-link signup/login). */
	readonly email: string
	/** Polling interval в ms. Defaults к 1000. Override для tests. */
	readonly pollIntervalMs?: number
	/** API base URL override для tests. Defaults к relative `/api`. */
	readonly apiBase?: string
}

const DEFAULT_POLL_MS = 1_000

export function DemoInboxPanel({
	email,
	pollIntervalMs = DEFAULT_POLL_MS,
	apiBase = '',
}: DemoInboxPanelProps) {
	const [latestUrl, setLatestUrl] = useState<string | null>(null)
	const [error, setError] = useState<string | null>(null)

	useEffect(() => {
		if (!email) return
		let cancelled = false

		async function tick() {
			try {
				const res = await fetch(
					`${apiBase}/api/public/demo/inbox?email=${encodeURIComponent(email)}`,
				)
				if (!res.ok) {
					if (!cancelled) setError(`HTTP ${res.status}`)
					return
				}
				const body = (await res.json()) as { data: DemoInboxResponse }
				if (cancelled) return
				if (body.data.latestUrl) {
					setLatestUrl(body.data.latestUrl)
				}
			} catch (e) {
				if (!cancelled) setError(e instanceof Error ? e.message : String(e))
			}
		}

		// Fire immediately, then on interval. Stop polling once URL arrives.
		void tick()
		const id = setInterval(() => {
			if (latestUrl !== null) return
			void tick()
		}, pollIntervalMs)

		return () => {
			cancelled = true
			clearInterval(id)
		}
	}, [email, latestUrl, pollIntervalMs, apiBase])

	if (latestUrl) {
		return (
			<div
				role="status"
				aria-live="polite"
				className="rounded-md border border-primary/40 bg-primary/5 px-4 py-3 text-sm"
			>
				<p className="font-medium">Письмо пришло</p>
				<p className="mt-1 text-muted-foreground">
					В демо-режиме письма приходят прямо сюда — нажмите кнопку чтобы войти как{' '}
					<strong>{email}</strong>.
				</p>
				<Button asChild className="mt-3" size="sm">
					<a href={latestUrl}>Открыть и войти →</a>
				</Button>
			</div>
		)
	}

	return (
		<div
			role="status"
			aria-live="polite"
			className="rounded-md border border-muted bg-muted/30 px-4 py-3 text-sm"
		>
			<p className="font-medium">Ждём письмо…</p>
			<p className="mt-1 text-muted-foreground">
				В демо-режиме мы перехватим письмо и покажем кнопку для входа прямо здесь.
			</p>
			{error ? <p className="mt-2 text-xs text-destructive">Ошибка опроса: {error}</p> : null}
		</div>
	)
}
