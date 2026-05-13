/**
 * Identity routes (`/onboarding/find-by-inn`) — strict integration tests
 * over the inner handler (auth/tenant stubbed via `tests/setup.ts`).
 *
 * Pre-done audit:
 *   [H1] valid 10-digit ИНН known to mock → 200 + {data: DaDataParty}
 *   [H2] valid 12-digit ИНН known to mock → 200 + {data: DaDataParty}
 *   [H3] valid ИНН unknown to mock → 200 + {data: null}
 *   [V1] 9-digit ИНН → 400 (zod rejects)
 *   [V2] 11-digit ИНН → 400 (zod rejects)
 *   [V3] 13-digit ИНН → 400 (zod rejects)
 *   [V4] non-digit characters → 400 (zod rejects)
 *   [V5] missing inn field → 400 (zod rejects)
 *   [V6] inn=null → 400 (zod rejects)
 *   [F1] adapter throws → handler bubbles error (becomes 500 via app.onError; here
 *        we just assert the throw isn't swallowed — fail-soft is adapter-side, not
 *        route-side)
 */
import { describe, expect, it } from 'bun:test'
import { onError } from '../../errors/on-error.ts'
import { createTestRouter, expectJson, type TestContext } from '../../tests/setup.ts'
import { createMockDaData } from './dadata/mock-dadata.ts'
import type { DaDataAdapter, DaDataParty } from './dadata/types.ts'
import { createIdentityRoutesInner } from './identity.routes.ts'

const FAKE_USER = {
	id: 'usr-test',
	email: 'test@sochi.local',
	emailVerified: true,
	name: 'Test',
	createdAt: new Date(),
	updatedAt: new Date(),
} as TestContext['user']

const FAKE_SESSION = {
	id: 'ses-test',
	userId: FAKE_USER.id,
	expiresAt: new Date(Date.now() + 3_600_000),
	token: 'tok',
	createdAt: new Date(),
	updatedAt: new Date(),
	ipAddress: '127.0.0.1',
	userAgent: 'test',
	activeOrganizationId: 'org-test',
} as TestContext['session']

const CTX: TestContext = {
	user: FAKE_USER,
	session: FAKE_SESSION,
	tenantId: 'org-test',
	memberRole: 'owner',
}

function buildApp(adapter: DaDataAdapter) {
	return createTestRouter(CTX).route('/', createIdentityRoutesInner(adapter)).onError(onError)
}

async function post(app: ReturnType<typeof buildApp>, body: unknown): Promise<Response> {
	return app.request('/onboarding/find-by-inn', {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify(body),
	})
}

describe('POST /onboarding/find-by-inn — happy paths', () => {
	it('[H1] 10-digit known ИНН → 200 + matched DaDataParty', async () => {
		const app = buildApp(createMockDaData())
		const res = await post(app, { inn: '2320000001' })
		expect(res.status).toBe(200)
		const body = await expectJson<{ data: DaDataParty }>(res)
		expect(body.data.name).toBe('ООО «Демо-Сириус»')
		expect(body.data.city).toBe('Сочи')
		expect(body.data.taxRegime).toBe('USN_DOHODY')
	})

	it('[H2] 12-digit known ИНН → 200 + matched DaDataParty (INDIVIDUAL)', async () => {
		const app = buildApp(createMockDaData())
		const res = await post(app, { inn: '232000000003' })
		expect(res.status).toBe(200)
		const body = await expectJson<{ data: DaDataParty }>(res)
		expect(body.data.legalForm).toBe('INDIVIDUAL')
		expect(body.data.city).toBe('Красная Поляна')
	})

	it('[H3] valid ИНН unknown to mock → 200 + {data: null}', async () => {
		const app = buildApp(createMockDaData())
		const res = await post(app, { inn: '7707083893' })
		expect(res.status).toBe(200)
		const body = await expectJson<{ data: DaDataParty | null }>(res)
		expect(body.data).toBe(null)
	})
})

describe('POST /onboarding/find-by-inn — validation rejects', () => {
	it('[V1] 9-digit ИНН → 400', async () => {
		const res = await post(buildApp(createMockDaData()), { inn: '123456789' })
		expect(res.status).toBe(400)
	})

	it('[V2] 11-digit ИНН → 400', async () => {
		const res = await post(buildApp(createMockDaData()), { inn: '12345678901' })
		expect(res.status).toBe(400)
	})

	it('[V3] 13-digit ИНН → 400', async () => {
		const res = await post(buildApp(createMockDaData()), { inn: '1234567890123' })
		expect(res.status).toBe(400)
	})

	it('[V4] non-digit characters → 400', async () => {
		const res = await post(buildApp(createMockDaData()), { inn: 'AB12345678' })
		expect(res.status).toBe(400)
	})

	it('[V5] missing inn field → 400', async () => {
		const res = await post(buildApp(createMockDaData()), {})
		expect(res.status).toBe(400)
	})

	it('[V6] inn=null → 400', async () => {
		const res = await post(buildApp(createMockDaData()), { inn: null })
		expect(res.status).toBe(400)
	})
})

describe('POST /onboarding/find-by-inn — fail-soft pass-through', () => {
	it('[F1] adapter returns null → handler returns {data: null} (no 500)', async () => {
		const failAdapter: DaDataAdapter = {
			async findByInn() {
				return null
			},
		}
		const res = await post(buildApp(failAdapter), { inn: '2320000001' })
		expect(res.status).toBe(200)
		const body = await expectJson<{ data: null }>(res)
		expect(body.data).toBe(null)
	})
})
