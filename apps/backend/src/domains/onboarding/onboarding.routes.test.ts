/**
 * Onboarding routes (`POST /onboarding/inventory`) — strict route tests.
 *
 * Pre-done audit:
 *   [H1] valid 10-room input → 201 + { data: { propertyId, roomTypeId, ratePlanId, roomIds[10], avgPriceRub } }
 *   [H2] rooms=1 (minimum) → 201 + roomIds.length === 1
 *   [H3] rooms=200 (cap) → 201 + roomIds.length === 200
 *   [V1] rooms=0 → 400
 *   [V2] rooms=201 (over cap) → 400
 *   [V3] avgPriceRub < 0 → 400
 *   [V4] avgPriceRub > 1_000_000 (over cap) → 400
 *   [V5] missing property.name → 400
 *   [V6] city not in enum → 400
 *   [V7] tourismTaxRateBps > 500 (over cap) → 400
 *   [V8] empty body → 400
 *   [F1] service throws → handler surfaces 5xx (no swallowing)
 *
 * Service is mocked — the real-DB happy path is covered by
 * `onboarding.service.db.test.ts`. Route layer responsibility is request
 * shape + envelope; mocking keeps these tests millisecond-fast and
 * deterministic.
 */
import { describe, expect, it } from 'bun:test'
import { onError } from '../../errors/on-error.ts'
import { createTestRouter, expectJson, type TestContext } from '../../tests/setup.ts'
import type { OnboardingFactory } from './onboarding.factory.ts'
import { createOnboardingRoutesInner } from './onboarding.routes.ts'
import type {
	CreateInventoryInput,
	CreateInventoryResult,
	OnboardingService,
} from './onboarding.service.ts'

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

function buildApp(service: OnboardingService) {
	const factory: OnboardingFactory = { service }
	return createTestRouter(CTX).route('/', createOnboardingRoutesInner(factory)).onError(onError)
}

function fakeResult(rooms: number): CreateInventoryResult {
	return {
		propertyId: 'property_fake',
		roomTypeId: 'roomType_fake',
		ratePlanId: 'ratePlan_fake',
		roomIds: Array.from({ length: rooms }, (_, i) => `room_${i}`),
	}
}

function happyService(captured?: { value: CreateInventoryInput | null }): OnboardingService {
	return {
		async createInventory(_tenantId, input) {
			if (captured) captured.value = input
			return fakeResult(input.rooms)
		},
	}
}

async function post(
	app: ReturnType<typeof buildApp>,
	body: unknown,
	headers: Record<string, string> = {},
): Promise<Response> {
	return app.request('/onboarding/inventory', {
		method: 'POST',
		headers: { 'Content-Type': 'application/json', ...headers },
		body: JSON.stringify(body),
	})
}

const validInput = {
	property: {
		name: 'Гостиница «Демо-Сириус»',
		address: '354340, г. Сочи, Имеретинская низменность, д. 1',
		city: 'Sochi',
		timezone: 'Europe/Moscow',
		tourismTaxRateBps: 200,
	},
	rooms: 10,
	avgPriceRub: 3500,
}

describe('POST /onboarding/inventory — happy paths', () => {
	it('[H1] valid 10-room input → 201 + full data envelope', async () => {
		const app = buildApp(happyService())
		const res = await post(app, validInput)
		expect(res.status).toBe(201)
		const body = await expectJson<{
			data: {
				propertyId: string
				roomTypeId: string
				ratePlanId: string
				roomIds: string[]
				avgPriceRub: number
			}
		}>(res)
		expect(body.data.propertyId).toBe('property_fake')
		expect(body.data.roomTypeId).toBe('roomType_fake')
		expect(body.data.ratePlanId).toBe('ratePlan_fake')
		expect(body.data.roomIds.length).toBe(10)
		expect(body.data.avgPriceRub).toBe(3500)
	})

	it('[H2] rooms=1 → 201 + roomIds.length === 1', async () => {
		const app = buildApp(happyService())
		const res = await post(app, { ...validInput, rooms: 1 })
		expect(res.status).toBe(201)
		const body = await expectJson<{ data: { roomIds: string[] } }>(res)
		expect(body.data.roomIds.length).toBe(1)
	})

	it('[H3] rooms=200 (cap) → 201 + roomIds.length === 200', async () => {
		const app = buildApp(happyService())
		const res = await post(app, { ...validInput, rooms: 200 })
		expect(res.status).toBe(201)
		const body = await expectJson<{ data: { roomIds: string[] } }>(res)
		expect(body.data.roomIds.length).toBe(200)
	})

	it('[H4] service receives normalized input (tenantId stripped — handler passes via c.var)', async () => {
		const captured: { value: CreateInventoryInput | null } = { value: null }
		const app = buildApp(happyService(captured))
		await post(app, validInput)
		expect(captured.value).not.toBe(null)
		expect(captured.value?.property.name).toBe(validInput.property.name)
		expect(captured.value?.property.city).toBe('Sochi')
		expect(captured.value?.property.tourismTaxRateBps).toBe(200)
		expect(captured.value?.rooms).toBe(10)
		expect(captured.value?.avgPriceRub).toBe(3500)
	})
})

describe('POST /onboarding/inventory — validation rejects', () => {
	it('[V1] rooms=0 → 400', async () => {
		const res = await post(buildApp(happyService()), { ...validInput, rooms: 0 })
		expect(res.status).toBe(400)
	})

	it('[V2] rooms=201 (over cap) → 400', async () => {
		const res = await post(buildApp(happyService()), { ...validInput, rooms: 201 })
		expect(res.status).toBe(400)
	})

	it('[V3] avgPriceRub < 0 → 400', async () => {
		const res = await post(buildApp(happyService()), { ...validInput, avgPriceRub: -1 })
		expect(res.status).toBe(400)
	})

	it('[V4] avgPriceRub > 1_000_000 → 400', async () => {
		const res = await post(buildApp(happyService()), { ...validInput, avgPriceRub: 1_000_001 })
		expect(res.status).toBe(400)
	})

	it('[V5] property.name missing → 400', async () => {
		const res = await post(buildApp(happyService()), {
			...validInput,
			property: { ...validInput.property, name: '' },
		})
		expect(res.status).toBe(400)
	})

	it('[V6] city not in enum → 400', async () => {
		const res = await post(buildApp(happyService()), {
			...validInput,
			property: { ...validInput.property, city: 'Москва' },
		})
		expect(res.status).toBe(400)
	})

	it('[V7] tourismTaxRateBps > 500 → 400', async () => {
		const res = await post(buildApp(happyService()), {
			...validInput,
			property: { ...validInput.property, tourismTaxRateBps: 501 },
		})
		expect(res.status).toBe(400)
	})

	it('[V8] empty body → 400', async () => {
		const res = await post(buildApp(happyService()), {})
		expect(res.status).toBe(400)
	})
})

describe('POST /onboarding/inventory — error propagation', () => {
	it('[F1] service throws → handler surfaces 5xx (not silenced)', async () => {
		const failService: OnboardingService = {
			async createInventory() {
				throw new Error('YDB write failure')
			},
		}
		const res = await post(buildApp(failService), validInput)
		expect(res.status).toBeGreaterThanOrEqual(500)
		expect(res.status).toBeLessThan(600)
	})
})
