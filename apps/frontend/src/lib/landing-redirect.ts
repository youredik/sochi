/**
 * Pure function: determines redirect target (если есть) когда пользователь
 * заходит на `/` route. Extracted из `routes/index.tsx` beforeLoad ради
 * testability per `feedback_critical_fix_test_coverage_canon`.
 *
 * Semantics:
 *   - No session OR session.session=null → null (render landing)
 *   - Session + missing activeOrganizationId → `/o-select`
 *   - Session + activeOrgId + orgs=null/undefined → null
 *     (fail-open: org-list fetch failed → не error-page визитёру,
 *     рендерим landing)
 *   - Session + activeOrgId + orgs не содержат match → `/o-select`
 *   - Session + activeOrgId + matching org → `/o/$orgSlug` с exact slug
 *
 * **Fail-open принцип**: landing — static credibility page; не должна
 * падать от backend transients (502/500/timeout). Auth-redirect ниже —
 * best-effort optimization для залогиненных, не critical path. Это
 * сознательное design-решение per `plans/customer-discovery-plan.md` §10.
 */

/**
 * Structural input types. Намеренно лояльные:
 *
 *   - `?` + `| undefined` on inner fields для совместимости с
 *     `exactOptionalPropertyTypes: true` tsconfig — discriminates
 *     «свойство absent» от «свойство explicit undefined» (Better Auth's
 *     StripEmptyObjects + activeOrganizationId nullable canon).
 *   - Минимальные required fields (`id`, `slug` для org) — full org / session
 *     shapes ИМЕЮТ больше fields, structural typing разрешает.
 */
export interface SessionLike {
	readonly session?:
		| {
				readonly activeOrganizationId?: string | null | undefined
		  }
		| null
		| undefined
}

export interface OrgLike {
	readonly id: string
	readonly slug: string
}

export interface ResolveLandingRedirectInput {
	readonly session: SessionLike | null | undefined
	readonly orgs: ReadonlyArray<OrgLike> | null | undefined
}

export type LandingRedirectTarget =
	| { readonly to: '/o-select' }
	| { readonly to: '/o/$orgSlug'; readonly params: { readonly orgSlug: string } }

/**
 * Returns redirect target if залогиненный user должен попасть в свой
 * tenant home, иначе `null` — рендерим landing.
 */
export function resolveLandingRedirect(
	input: ResolveLandingRedirectInput,
): LandingRedirectTarget | null {
	const { session, orgs } = input

	// No session → anonymous visitor → landing
	if (!session?.session) return null

	const activeId = session.session.activeOrganizationId
	// Session без активного org → /o-select handles edge-cases
	// (`_app.tsx` routes zero/one/many)
	if (!activeId) return { to: '/o-select' }

	// Org-list fetch unreachable (backend error caught наверху) →
	// fail-open: не error-page user'у, рендерим landing. Они смогут
	// зайти позже когда backend recovery.
	if (!orgs) return null

	const org = orgs.find((o) => o.id === activeId)
	// Active org-id не соответствует ни одному org из list → state mismatch,
	// route к /o-select для re-resolution.
	if (!org) return { to: '/o-select' }

	return { to: '/o/$orgSlug', params: { orgSlug: org.slug } }
}
