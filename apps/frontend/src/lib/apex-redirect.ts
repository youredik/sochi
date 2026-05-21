/**
 * Apex → app subdomain redirect helper.
 *
 * **Architecture canon 2026-05-21**: `sepshn.ru` apex = marketing landing
 * surface only. All app routes (login/signup/welcome/o/*) live on the
 * `demo.sepshn.ru` subdomain (and later `app.sepshn.ru` для production
 * tenant flip per `[[project_demo_to_live_roadmap]]`).
 *
 * Why split-domain:
 *   - **BA `trustedOrigins`** — restricted к app subdomain so apex never
 *     hosts auth. Earlier prod bug: user navigated к `sepshn.ru/login`,
 *     form built `callbackURL=https://sepshn.ru/welcome`, BA rejected
 *     «Invalid callbackURL» (apex не в trustedOrigins). 2026-05-21.
 *   - **Cookie scoping** — session cookies set с `Domain=demo.sepshn.ru`
 *     (default, не parent). Apex never has the cookie → guards work
 *     correctly only on app subdomain.
 *   - **Marketing analytics independence** — Метрика на apex меряет
 *     funnel acquisition, demo.sepshn.ru меряет product. Separate.
 *   - **Future production split** — production tenants land on
 *     `app.sepshn.ru` (different infra contour); apex stays marketing.
 *
 * Single source of truth для «is this an app path»:
 *   - `/` — landing, STAYS на apex
 *   - `/legal/*` — privacy/terms/cookies, STAYS на apex (future)
 *   - everything else (`/login`, `/signup`, `/welcome`, `/o/*`,
 *     `/o-select`, `/booking/*`) → REDIRECT к app subdomain
 */

/** Apex hosts that should redirect non-marketing paths к app. */
const APEX_HOSTS = ['sepshn.ru', 'www.sepshn.ru']

/** Canonical app subdomain — where login/signup/welcome/o/* live. */
const APP_HOST = 'demo.sepshn.ru'

/**
 * Marketing paths that STAY on apex. Everything else on apex redirects.
 * Allow-list approach (restrictive + safe) — adding new app routes never
 * accidentally leaves them stranded on apex.
 *
 * Allow-list:
 *   - `/` — landing page (credibility surface)
 *   - `/privacy` — 152-ФЗ privacy policy, marketing concern
 *   - `/legal/*` — future ToS / cookies / OFERTA pages
 */
function isApexPath(pathname: string): boolean {
	return pathname === '/' || pathname === '/privacy' || pathname.startsWith('/legal/')
}

/**
 * Returns absolute URL к which the user should be redirected, OR `null`
 * если current hostname+path doesn't trigger a redirect.
 *
 * Pure function — no `window` access, easily tested. Caller responsible
 * for invoking `window.location.replace(target)` (in TanStack Router
 * beforeLoad guards).
 *
 * @param hostname `window.location.hostname` (case-insensitive match)
 * @param pathname `window.location.pathname`
 * @param search   `window.location.search` (preserved across redirect)
 */
export function resolveAppHostRedirect(
	hostname: string,
	pathname: string,
	search: string,
): string | null {
	const host = hostname.toLowerCase()
	if (!APEX_HOSTS.includes(host)) return null
	if (isApexPath(pathname)) return null
	return `https://${APP_HOST}${pathname}${search}`
}

/**
 * Browser-side wrapper для use in TanStack Router `beforeLoad` guards.
 * If a redirect is needed, navigates the browser and returns a Promise
 * that never resolves — router stops loading the route, browser nav
 * takes over. Returns `false` if no redirect needed (caller continues).
 *
 * SSR/test guard: returns `false` если `window` undefined.
 */
export function maybeRedirectToAppHost(): Promise<never> | false {
	if (typeof window === 'undefined') return false
	const target = resolveAppHostRedirect(
		window.location.hostname,
		window.location.pathname,
		window.location.search,
	)
	if (!target) return false
	window.location.replace(target)
	// Never resolves — browser is navigating, router should suspend.
	return new Promise<never>(() => {})
}
