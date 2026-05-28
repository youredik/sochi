/**
 * `resolveWelcomeRedirect()` — strict tests per `feedback_strict_tests`.
 *
 * Invariants:
 *   - I1 No session → redirect-login (gate /welcome behind auth)
 *   - I2 Session + activeOrg → redirect-home (prevents accidental re-create)
 *   - I3 Session + no active + 0 orgs → **auto-create-org** (Round 14.6.2
 *        — caller invokes authClient.organization.create с placeholder
 *        `DEFAULT_WELCOME_ORG_NAME` + slug `org-<base36>`, redirects к
 *        /o/{slug}/. Replaces pre-Round-14.6.2 form-based path)
 *   - I4 Session + no active + ≥1 orgs → set-active-and-redirect
 *        (RETURN-VISIT canon — Bug fix 2026-05-21 per demo-funnel-smoke [E2])
 *   - I5 Fail-open: orgs=null/undefined → auto-create-org (transient backend
 *        не блокирует true new-user)
 *
 * Test matrix:
 *   ─── I1 redirect-login ───────────────────────────────────────
 *     [W1] session=null
 *     [W2] session.session=null
 *     [W3] session={} (no session field)
 *
 *   ─── I2 redirect-home ────────────────────────────────────────
 *     [W4] activeOrgId="org_X" → home (regardless orgs list)
 *
 *   ─── I3 auto-create-org (true new-user) ──────────────────────
 *     [W5] no active + orgs=[] empty
 *
 *   ─── I5 fail-open auto-create-org ────────────────────────────
 *     [W6] orgs=null (fetch failed)
 *     [W7] orgs=undefined
 *
 *   ─── I4 set-active-and-redirect (return-visit canon) ─────────
 *     [W8] orgs=[org_A] → setActive org_A + redirect к /o/alpha
 *     [W9] orgs=[org_A, org_B] → still first (deterministic)
 *
 *   ─── Adversarial ─────────────────────────────────────────────
 *     [W10] orgs containing empty-slug org → passes through (caller validates)
 */

import { describe, expect, test } from 'bun:test'
import { resolveWelcomeRedirect } from './welcome-redirect.ts'

describe('resolveWelcomeRedirect (lib)', () => {
	test('[W1] session=null → redirect-login', () => {
		expect(resolveWelcomeRedirect({ session: null, orgs: [] })).toEqual({
			kind: 'redirect-login',
		})
	})

	test('[W2] session.session=null → redirect-login', () => {
		expect(resolveWelcomeRedirect({ session: { session: null }, orgs: [] })).toEqual({
			kind: 'redirect-login',
		})
	})

	test('[W3] session={} (no session field) → redirect-login', () => {
		expect(resolveWelcomeRedirect({ session: {}, orgs: [] })).toEqual({
			kind: 'redirect-login',
		})
	})

	test('[W4] activeOrgId set → redirect-home (даже с orgs list)', () => {
		expect(
			resolveWelcomeRedirect({
				session: { session: { activeOrganizationId: 'org_X' } },
				orgs: [{ id: 'org_X', slug: 'something' }],
			}),
		).toEqual({ kind: 'redirect-home' })
	})

	test('[W5] no active + orgs=[] empty → render-form (true new-user)', () => {
		expect(
			resolveWelcomeRedirect({
				session: { session: { activeOrganizationId: null } },
				orgs: [],
			}),
		).toEqual({ kind: 'auto-create-org' })
	})

	test('[W6] no active + orgs=null (fetch failed) → render-form (fail-open)', () => {
		expect(
			resolveWelcomeRedirect({
				session: { session: { activeOrganizationId: undefined } },
				orgs: null,
			}),
		).toEqual({ kind: 'auto-create-org' })
	})

	test('[W7] no active + orgs=undefined → render-form (fail-open)', () => {
		expect(
			resolveWelcomeRedirect({
				session: { session: { activeOrganizationId: null } },
				orgs: undefined,
			}),
		).toEqual({ kind: 'auto-create-org' })
	})

	test('[W8] no active + orgs=[org_A] → set-active-and-redirect (RETURN-VISIT canon)', () => {
		expect(
			resolveWelcomeRedirect({
				session: { session: { activeOrganizationId: null } },
				orgs: [{ id: 'org_A', slug: 'alpha' }],
			}),
		).toEqual({ kind: 'set-active-and-redirect', orgId: 'org_A', orgSlug: 'alpha' })
	})

	test('[W9] no active + orgs=[org_A, org_B] → first org (deterministic)', () => {
		expect(
			resolveWelcomeRedirect({
				session: { session: { activeOrganizationId: null } },
				orgs: [
					{ id: 'org_A', slug: 'alpha' },
					{ id: 'org_B', slug: 'bravo' },
				],
			}),
		).toEqual({ kind: 'set-active-and-redirect', orgId: 'org_A', orgSlug: 'alpha' })
	})

	test('[W10] adversarial: empty-slug org → passthrough (caller validates)', () => {
		expect(
			resolveWelcomeRedirect({
				session: { session: { activeOrganizationId: null } },
				orgs: [{ id: 'org_X', slug: '' }],
			}),
		).toEqual({ kind: 'set-active-and-redirect', orgId: 'org_X', orgSlug: '' })
	})
})
