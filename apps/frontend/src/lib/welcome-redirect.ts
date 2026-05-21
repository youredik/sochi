/**
 * Pure function: determines what /welcome route guard should do given current
 * auth state. Extracted из `routes/welcome.tsx` beforeLoad ради testability
 * per `feedback_critical_fix_test_coverage_canon`.
 *
 * Decision tree (canonical, mirrors `_app.tsx` org-resolution logic):
 *
 *   1. No session → redirect к /login (user needs to sign in)
 *   2. Session has activeOrganizationId → redirect к / (already settled,
 *      bouncing prevents accidental re-create from bookmark/back-button)
 *   3. Session valid + no active + orgs.length === 0 → render /welcome form
 *      (true new-user — must create first org)
 *   4. **RETURN-VISIT case** (added 2026-05-21): session valid + no active +
 *      orgs.length > 0 → caller must `setActive(firstOrg)` + redirect к
 *      /o/{slug}. Без этого guard'а existing user который вернулся после
 *      cookie expiry создаёт DUPLICATE empty org каждое magic-link verify
 *      via /welcome callback path. Bug empirically reproduced 2026-05-21:
 *      tests/e2e/demo-funnel-smoke.spec.ts [E2].
 *
 * Function returns a DECISION (intent) not a side-effect — caller (route
 * beforeLoad) executes setActive call + throws redirect. Pure-vs-impure
 * separation enables strict unit-testing of all 5 branches без mocking
 * authClient.
 *
 * See sibling: `lib/landing-redirect.ts` (same pattern для / route).
 */

import type { OrgLike, SessionLike } from './landing-redirect.ts'

export interface ResolveWelcomeRedirectInput {
	readonly session: SessionLike | null | undefined
	readonly orgs: ReadonlyArray<OrgLike> | null | undefined
}

export type WelcomeRedirectDecision =
	| { readonly kind: 'redirect-login' }
	| { readonly kind: 'redirect-home' }
	| {
			readonly kind: 'set-active-and-redirect'
			readonly orgId: string
			readonly orgSlug: string
	  }
	| { readonly kind: 'render-form' }

export function resolveWelcomeRedirect(
	input: ResolveWelcomeRedirectInput,
): WelcomeRedirectDecision {
	const { session, orgs } = input

	// 1. No session → /login
	if (!session?.session) return { kind: 'redirect-login' }

	// 2. Active org already set → /
	if (session.session.activeOrganizationId) return { kind: 'redirect-home' }

	// 3. + 4. Determine based on orgs list
	// Fail-open: if orgs fetch failed (null/undefined) → render form so user
	// isn't blocked from creating their first org. Worst case: duplicate
	// org on transient backend hiccup (acceptable vs hard error-page).
	if (!orgs || orgs.length === 0) return { kind: 'render-form' }

	const firstOrg = orgs[0]
	if (!firstOrg) return { kind: 'render-form' }

	// 4. Return-visit: setActive first org + redirect к /o/{slug}.
	// Multi-org (>1) edge case: forces first org. User can still use
	// in-app org-switcher after landing. Better than /o-select fork here
	// which would lose the return-visit «попал в свои данные» feel.
	return {
		kind: 'set-active-and-redirect',
		orgId: firstOrg.id,
		orgSlug: firstOrg.slug,
	}
}
