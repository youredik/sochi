/**
 * `resolveLandingRedirect()` — strict tests per `feedback_strict_tests.md`.
 *
 * Invariants under test:
 *   - I1 Fail-open: любой null/missing input не bounce'ит к /login, рендерит landing
 *   - I2 Auth-aware: session + activeOrg + match → exact redirect с правильным slug
 *   - I3 /o-select fallback: session valid но org-resolution невозможен
 *   - I4 Slug-passthrough: redirect возвращает ИХ slug as-is (no derivation)
 *
 * Test matrix:
 *   ─── I1 fail-open (render landing) ────────────────────────────
 *     [LR1] session=null → null
 *     [LR2] session={} (no .session field) → null
 *     [LR3] session.session=null → null
 *     [LR7] activeOrgId set + orgs=null (fetch failed) → null
 *     [LR8] activeOrgId set + orgs=undefined → null
 *
 *   ─── I3 /o-select (missing/invalid activeOrgId) ───────────────
 *     [LR4] activeOrgId=undefined → /o-select
 *     [LR5] activeOrgId=null → /o-select
 *     [LR6] activeOrgId="" → /o-select
 *     [LR9] empty orgs list → /o-select
 *     [LR10] orgs не содержат activeOrgId → /o-select
 *
 *   ─── I2 happy path ─────────────────────────────────────────────
 *     [LR11] orgs[0] match → /o/$slug
 *     [LR12] orgs[2] match (mid-list) → /o/$slug
 *
 *   ─── I4 adversarial ───────────────────────────────────────────
 *     [LR13] orgs[slug] is anything → return as-is (no derivation)
 *     [LR14] empty-string slug passes through (caller validates)
 *
 * Output shape pinned strictly: `null` или exact-equality object.
 * No toBeDefined/toBeTruthy/toBeFalsy — per weak_assertions=0 ratchet.
 */

import { describe, expect, test } from 'bun:test'
import { resolveLandingRedirect } from './landing-redirect.ts'

describe('resolveLandingRedirect (lib)', () => {
	test('[LR1] session=null → null (render landing)', () => {
		expect(resolveLandingRedirect({ session: null, orgs: [] })).toEqual(null)
	})

	test('[LR2] session={} (no .session field) → null', () => {
		expect(resolveLandingRedirect({ session: {}, orgs: [] })).toEqual(null)
	})

	test('[LR3] session.session=null → null', () => {
		expect(resolveLandingRedirect({ session: { session: null }, orgs: [] })).toEqual(null)
	})

	test('[LR4] activeOrgId=undefined → /o-select', () => {
		expect(
			resolveLandingRedirect({
				session: { session: { activeOrganizationId: undefined } },
				orgs: [],
			}),
		).toEqual({ to: '/o-select' })
	})

	test('[LR5] activeOrgId=null → /o-select', () => {
		expect(
			resolveLandingRedirect({
				session: { session: { activeOrganizationId: null } },
				orgs: [],
			}),
		).toEqual({ to: '/o-select' })
	})

	test('[LR6] activeOrgId="" (empty string) → /o-select', () => {
		expect(
			resolveLandingRedirect({
				session: { session: { activeOrganizationId: '' } },
				orgs: [],
			}),
		).toEqual({ to: '/o-select' })
	})

	test('[LR7] activeOrgId valid + orgs=null → null (fail-open)', () => {
		expect(
			resolveLandingRedirect({
				session: { session: { activeOrganizationId: 'org_1' } },
				orgs: null,
			}),
		).toEqual(null)
	})

	test('[LR8] activeOrgId valid + orgs=undefined → null (fail-open)', () => {
		expect(
			resolveLandingRedirect({
				session: { session: { activeOrganizationId: 'org_1' } },
				orgs: undefined,
			}),
		).toEqual(null)
	})

	test('[LR9] empty orgs list → /o-select', () => {
		expect(
			resolveLandingRedirect({
				session: { session: { activeOrganizationId: 'org_1' } },
				orgs: [],
			}),
		).toEqual({ to: '/o-select' })
	})

	test('[LR10] orgs не содержат activeOrgId → /o-select', () => {
		expect(
			resolveLandingRedirect({
				session: { session: { activeOrganizationId: 'org_X' } },
				orgs: [
					{ id: 'org_A', slug: 'alpha' },
					{ id: 'org_B', slug: 'bravo' },
				],
			}),
		).toEqual({ to: '/o-select' })
	})

	test('[LR11] orgs[0] match → /o/$orgSlug с exact slug', () => {
		expect(
			resolveLandingRedirect({
				session: { session: { activeOrganizationId: 'org_A' } },
				orgs: [{ id: 'org_A', slug: 'alpha' }],
			}),
		).toEqual({ to: '/o/$orgSlug', params: { orgSlug: 'alpha' } })
	})

	test('[LR12] orgs[2] match (mid-list) → /o/$orgSlug exact', () => {
		expect(
			resolveLandingRedirect({
				session: { session: { activeOrganizationId: 'org_C' } },
				orgs: [
					{ id: 'org_A', slug: 'alpha' },
					{ id: 'org_B', slug: 'bravo' },
					{ id: 'org_C', slug: 'charlie' },
				],
			}),
		).toEqual({ to: '/o/$orgSlug', params: { orgSlug: 'charlie' } })
	})

	test('[LR13] adversarial: slug is anything — passthrough as-is (no derivation)', () => {
		// Function MUST использовать slug из orgs list as-is, не derive из id
		expect(
			resolveLandingRedirect({
				session: { session: { activeOrganizationId: 'org_demo_sirius_v2' } },
				orgs: [{ id: 'org_demo_sirius_v2', slug: 'completely-different-slug-XYZ-123' }],
			}),
		).toEqual({
			to: '/o/$orgSlug',
			params: { orgSlug: 'completely-different-slug-XYZ-123' },
		})
	})

	test('[LR14] adversarial: empty-string slug passes through (caller validates)', () => {
		// Empty slug — caller responsibility (route-level zod / router validation)
		expect(
			resolveLandingRedirect({
				session: { session: { activeOrganizationId: 'org_X' } },
				orgs: [{ id: 'org_X', slug: '' }],
			}),
		).toEqual({ to: '/o/$orgSlug', params: { orgSlug: '' } })
	})
})
