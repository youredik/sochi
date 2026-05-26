/**
 * Round 9 — side-by-side sales-demo showcase.
 *
 * Split-pane view с iframe слева (demo OTA) + iframe справа (PMS grid).
 * The presenter shows this page to отельерам: «look — guest books on Yandex
 * (left), the reservation appears в PMS grid (right) в реальном времени».
 *
 * Header carries:
 *   - Channel switcher: Yandex.Путешествия / Островок (changes left iframe `src`)
 *   - Admin controls: Reset / Seed (POST endpoints)
 *   - Trigger scenario dropdown: overbooking / cancel-late / payment-fail
 *
 * **NOT production code** — lives inside `_demo/` per Round 9 canon. Env-gated
 * mount at the route layer (`routes/demo.showcase.tsx`) — production deploy
 * tree-shakes this file entirely (no production caller).
 *
 * **PMS chess board URL**: takes an `orgSlug` prop / search param so the
 * presenter can show their own tenant's grid. Defaults to `/o/demo/grid` —
 * the always-on demo tenant created by `demo.sepshn.ru` magic-link signup.
 *
 * Canon: `feedback_round_9_demo_ota_server_canon_2026_05_25.md`.
 *
 * Out-of-scope (per Phase-1 frozen):
 *   - Real-time SSE indicator showing «webhook just landed»
 *   - Animation of reservation row appearing
 *   - Side-by-side viewport sync (scroll lock)
 *   - Mobile-responsive layout
 */

import { useEffect, useId, useState } from 'react'
import { DEMO_SESSION_TOKEN_STORAGE_KEY } from './showcase-page.constants.ts'

export type ShowcaseChannel = 'yandex' | 'ostrovok'

export type AdminScenario = 'overbooking' | 'cancel-late' | 'payment-fail'

const SCENARIOS: ReadonlyArray<AdminScenario> = [
	'overbooking',
	'cancel-late',
	'payment-fail',
] as const

const CHANNEL_LABELS: Record<ShowcaseChannel, string> = {
	yandex: 'Yandex.Путешествия',
	ostrovok: 'Островок.ru',
}

const CHANNEL_DEMO_URL: Record<ShowcaseChannel, string> = {
	yandex: '/demo/ota/yandex',
	ostrovok: '/demo/ota/ostrovok',
}

export interface ShowcasePageProps {
	/** Default channel shown в the left pane. Defaults to `yandex`. */
	readonly initialChannel?: ShowcaseChannel
	/** Override PMS grid iframe src. Defaults to `/o/demo/grid`. */
	readonly pmsGridUrl?: string
	/**
	 * Inject fetch implementation для tests. Defaults to `globalThis.fetch`.
	 * Real demo сессии use the global; component tests pass a recording spy.
	 */
	readonly fetchImpl?: typeof fetch
	/**
	 * Round 12 P0 fix — session token wired to `X-Demo-Session-Token` header
	 * on every admin POST (Round 11 P1-B2 backend gate). Presenter copies the
	 * token from backend boot log (printed once per process). Persisted via
	 * `localStorage` keyed by `DEMO_SESSION_TOKEN_STORAGE_KEY` so the value
	 * survives page reload and admin handover. Empty = backend accepts
	 * (Round 11 back-compat dev path).
	 */
	readonly sessionToken?: string
}

type LastActionStatus =
	| { readonly kind: 'idle' }
	| { readonly kind: 'pending'; readonly action: string }
	| { readonly kind: 'ok'; readonly action: string; readonly message: string }
	| {
			readonly kind: 'error'
			readonly action: string
			readonly message: string
	  }

/**
 * Side-by-side demo showcase page. Hosts two iframes plus a small admin
 * control header. State management is intentionally minimal — this is
 * presenter UX, не a complex form.
 */
export function ShowcasePage({
	initialChannel = 'yandex',
	pmsGridUrl = '/o/demo/grid',
	fetchImpl,
	sessionToken: sessionTokenProp,
}: ShowcasePageProps) {
	const [channel, setChannel] = useState<ShowcaseChannel>(initialChannel)
	const [scenario, setScenario] = useState<AdminScenario>('overbooking')
	const [status, setStatus] = useState<LastActionStatus>({ kind: 'idle' })
	// Round 12 P0 — admin session token state. Initialized lazily from
	// localStorage (browser-only; SSR guard via typeof check).
	const [sessionToken, setSessionToken] = useState<string>(() => {
		if (sessionTokenProp !== undefined) return sessionTokenProp
		if (typeof window === 'undefined') return ''
		return window.localStorage.getItem(DEMO_SESSION_TOKEN_STORAGE_KEY) ?? ''
	})
	const scenarioSelectId = useId()
	const sessionTokenInputId = useId()

	// Persist non-empty token changes to localStorage (test+presenter handover).
	useEffect(() => {
		if (typeof window === 'undefined') return
		if (sessionToken.length === 0) {
			window.localStorage.removeItem(DEMO_SESSION_TOKEN_STORAGE_KEY)
		} else {
			window.localStorage.setItem(DEMO_SESSION_TOKEN_STORAGE_KEY, sessionToken)
		}
	}, [sessionToken])

	const fetchFn = fetchImpl ?? globalThis.fetch

	async function callAdmin(
		path: string,
		actionLabel: string,
		body?: Record<string, unknown>,
	): Promise<void> {
		setStatus({ kind: 'pending', action: actionLabel })
		try {
			const headers: Record<string, string> = { 'content-type': 'application/json' }
			// Round 12 P0 — attach session-token header when set. Backend rejects
			// 401 if production-mode token set + caller didn't provide.
			if (sessionToken.length > 0) {
				headers['x-demo-session-token'] = sessionToken
			}
			const init: RequestInit = {
				method: 'POST',
				headers,
			}
			if (body !== undefined) {
				init.body = JSON.stringify(body)
			}
			const res = await fetchFn(path, init)
			if (!res.ok) {
				const text = await res.text()
				setStatus({
					kind: 'error',
					action: actionLabel,
					message: `${res.status}: ${text.slice(0, 200)}`,
				})
				return
			}
			const data = (await res.json()) as { ok?: boolean }
			setStatus({
				kind: 'ok',
				action: actionLabel,
				message: data.ok === true ? 'Готово' : 'Ответ получен',
			})
		} catch (err) {
			const errMessage = err instanceof Error ? err.message : String(err)
			setStatus({
				kind: 'error',
				action: actionLabel,
				message: errMessage,
			})
		}
	}

	const handleReset = () => {
		void callAdmin('/api/_mock-ota/admin/reset', 'Reset')
	}
	const handleSeed = () => {
		void callAdmin('/api/_mock-ota/admin/seed', 'Seed')
	}
	const handleTrigger = () => {
		void callAdmin('/api/_mock-ota/admin/trigger', `Trigger ${scenario}`, {
			scenario,
		})
	}

	const statusBanner = renderStatusBanner(status)
	const leftIframeSrc = CHANNEL_DEMO_URL[channel]

	return (
		<div
			lang="ru"
			className="flex h-svh flex-col bg-neutral-50 text-neutral-900"
			data-testid="showcase-page"
		>
			<header
				className="flex flex-wrap items-center justify-between gap-3 border-b border-neutral-200 bg-white px-4 py-3 shadow-sm"
				data-testid="showcase-header"
			>
				<div className="flex items-center gap-3">
					<h1 className="text-lg font-bold tracking-tight">Sepshn Demo · Side-by-Side</h1>
					<nav
						aria-label="Канал для демонстрации"
						className="flex items-center gap-1 rounded-md bg-neutral-100 p-1"
					>
						{(Object.keys(CHANNEL_LABELS) as ReadonlyArray<ShowcaseChannel>).map((ch) => (
							<button
								key={ch}
								type="button"
								data-testid={`showcase-channel-${ch}`}
								aria-pressed={channel === ch}
								onClick={() => setChannel(ch)}
								className={`rounded px-3 py-1 text-sm font-medium transition-colors ${
									channel === ch
										? 'bg-white text-neutral-900 shadow-sm'
										: 'text-neutral-600 hover:text-neutral-900'
								}`}
							>
								{CHANNEL_LABELS[ch]}
							</button>
						))}
					</nav>
				</div>

				<div className="flex flex-wrap items-center gap-2">
					<div className="flex items-center gap-1">
						<label htmlFor={sessionTokenInputId} className="text-xs font-medium text-neutral-600">
							Session token
						</label>
						<input
							id={sessionTokenInputId}
							data-testid="showcase-session-token"
							type="password"
							value={sessionToken}
							onChange={(e) => setSessionToken(e.target.value)}
							placeholder="demo_admin_…"
							className="w-40 rounded-md border border-neutral-300 bg-white px-2 py-1 font-mono text-xs text-neutral-700"
							aria-describedby={`${sessionTokenInputId}-help`}
						/>
						<span id={`${sessionTokenInputId}-help`} className="sr-only">
							Скопируйте токен из лога бэкенда (`X-Demo-Session-Token`). Сохраняется в localStorage.
						</span>
					</div>
					<button
						type="button"
						data-testid="showcase-admin-reset"
						onClick={handleReset}
						className="rounded-md border border-neutral-300 bg-white px-3 py-1.5 text-sm font-medium text-neutral-700 hover:bg-neutral-50"
					>
						Reset
					</button>
					<button
						type="button"
						data-testid="showcase-admin-seed"
						onClick={handleSeed}
						className="rounded-md border border-neutral-300 bg-white px-3 py-1.5 text-sm font-medium text-neutral-700 hover:bg-neutral-50"
					>
						Seed
					</button>
					<div className="flex items-center gap-1">
						<label htmlFor={scenarioSelectId} className="sr-only">
							Сценарий
						</label>
						<select
							id={scenarioSelectId}
							data-testid="showcase-scenario-select"
							value={scenario}
							onChange={(e) => setScenario(e.target.value as AdminScenario)}
							className="rounded-md border border-neutral-300 bg-white px-2 py-1.5 text-sm text-neutral-700"
						>
							{SCENARIOS.map((s) => (
								<option key={s} value={s}>
									{s}
								</option>
							))}
						</select>
						<button
							type="button"
							data-testid="showcase-admin-trigger"
							onClick={handleTrigger}
							className="rounded-md border border-amber-300 bg-amber-50 px-3 py-1.5 text-sm font-medium text-amber-900 hover:bg-amber-100"
						>
							Trigger
						</button>
					</div>
				</div>
			</header>

			{statusBanner !== null && (
				<div
					className="border-b border-neutral-200 bg-neutral-100 px-4 py-2 text-sm"
					role="status"
					aria-live="polite"
					data-testid="showcase-status-banner"
				>
					{statusBanner}
				</div>
			)}

			<main className="grid flex-1 grid-cols-2 divide-x divide-neutral-200">
				<section
					className="flex h-full flex-col"
					aria-label={`Demo OTA — ${CHANNEL_LABELS[channel]}`}
				>
					<div className="border-b border-neutral-200 bg-neutral-50 px-3 py-1.5 text-xs font-medium uppercase tracking-wide text-neutral-500">
						Demo OTA · {CHANNEL_LABELS[channel]}
					</div>
					<iframe
						key={channel}
						title={`Demo OTA ${CHANNEL_LABELS[channel]}`}
						data-testid="showcase-iframe-ota"
						src={leftIframeSrc}
						className="flex-1 w-full border-0"
					/>
				</section>
				<section className="flex h-full flex-col" aria-label="PMS grid">
					<div className="border-b border-neutral-200 bg-neutral-50 px-3 py-1.5 text-xs font-medium uppercase tracking-wide text-neutral-500">
						PMS · Шахматка
					</div>
					<iframe
						title="PMS Grid"
						data-testid="showcase-iframe-pms"
						src={pmsGridUrl}
						className="flex-1 w-full border-0"
					/>
				</section>
			</main>
		</div>
	)
}

function renderStatusBanner(status: LastActionStatus): string | null {
	switch (status.kind) {
		case 'idle':
			return null
		case 'pending':
			return `${status.action}…`
		case 'ok':
			return `${status.action}: ${status.message}`
		case 'error':
			return `${status.action} — ошибка: ${status.message}`
	}
}
