import { parseDaDataParty } from '@horeca/shared'
import { zValidator } from '@hono/zod-validator'
import { Hono } from 'hono'
import { z } from 'zod'
import type { AppEnv } from '../../factory.ts'
import { logger } from '../../logger.ts'
import { authMiddleware } from '../../middleware/auth.ts'
import { tenantMiddleware } from '../../middleware/tenant.ts'
import type { DaDataAdapter } from './dadata/types.ts'

/**
 * Onboarding identity-lookup routes — currently just `POST /onboarding/find-by-inn`,
 * mounted under `/api/v1`. The endpoint wraps the DaData adapter so the
 * frontend wizard sees a uniform sochi-shaped response regardless of
 * mock-vs-live binding (per `[[behaviour_faithful_mock_canon]]`).
 *
 * Auth: requires session + active org. The wizard always runs after signup
 * + org-create, so the user is authenticated when this endpoint is called.
 *
 * Response shape:
 *   - 200 + `{data: party}`  — found (mock or live)
 *   - 200 + `{data: null}`   — not found OR adapter fail-soft (UI handles both
 *                              with the same "fill in manually" affordance)
 *   - 400                    — invalid ИНН shape (zod rejects non-10/12 digits)
 *   - 401                    — no session
 *
 * The inner factory is exported separately so route-tests can mount it
 * behind `stubAuthMiddleware` from `tests/setup.ts` without going through
 * real Better Auth. Mirrors the property-content / compliance pattern.
 */
const findByInnBody = z.object({
	inn: z.string().regex(/^(\d{10}|\d{12})$/, 'Expected RU ИНН (10 or 12 digits)'),
})

/** Inner — handlers only, no auth/tenant middleware. Used by route tests. */
export function createIdentityRoutesInner(adapter: DaDataAdapter) {
	return new Hono<AppEnv>().post(
		'/onboarding/find-by-inn',
		zValidator('json', findByInnBody),
		async (c) => {
			const { inn } = c.req.valid('json')
			const party = await adapter.findByInn(inn)
			if (party === null) {
				return c.json({ data: null }, 200)
			}
			// Strict-schema validation at the trust boundary (P4 hardening
			// 2026-05-13): adapters may produce technically-typed values that
			// fail the harder DaDataParty contract (e.g. ОГРН length wrong
			// for legalForm). Fail-soft к `{ data: null }` — UI offers manual
			// override the same way as «not found». Bad upstream surfaces as
			// a warn-log для observability.
			const validated = parseDaDataParty(party)
			if (validated === null) {
				logger.warn(
					{ inn, raw: party },
					'DaData adapter returned party that failed daDataPartySchema — fail-soft to null',
				)
				return c.json({ data: null }, 200)
			}
			return c.json({ data: validated }, 200)
		},
	)
}

/** Outer — production wiring with auth + tenant gates. Mounted in app.ts. */
export function createIdentityRoutes(adapter: DaDataAdapter) {
	return new Hono<AppEnv>()
		.use('*', authMiddleware(), tenantMiddleware())
		.route('/', createIdentityRoutesInner(adapter))
}
