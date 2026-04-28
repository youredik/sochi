/**
 * Vision routes — strict tests per `feedback_strict_tests.md`.
 *
 * Pre-done audit (paste-and-fill):
 *   RBAC × 3 ролей:
 *     [V-R1] staff POST scan → 200 (front-desk operator workflow,
 *            guest:update permission granted to staff)
 *     [V-R2] manager POST scan → 200
 *     [V-R3] owner POST scan → 200 + valid response shape
 *
 *   Validation (Zod boundary):
 *     [V-Z1] missing consent152fzAccepted → 400 (152-ФЗ legal gate)
 *     [V-Z2] consent152fzAccepted=false → 400 (literal-true expected)
 *     [V-Z3] empty imageBase64 → 400 (Zod min(1))
 *     [V-Z4] invalid mimeType → 400 (Zod enum)
 *     [V-Z5] base64 decodes to empty bytes → 400 (handler guard)
 */
import type { MemberRole } from '@horeca/shared'
import { describe, expect, test } from 'vitest'
import { onError } from '../../../errors/on-error.ts'
import { createTestRouter, type TestContext } from '../../../tests/setup.ts'
import { createMockVisionOcr } from './mock-vision.ts'
import { createVisionRoutesInner } from './vision.routes.ts'

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

function ctxFor(role: MemberRole): TestContext {
	return {
		user: FAKE_USER,
		session: FAKE_SESSION,
		tenantId: 'org-test',
		memberRole: role,
	}
}

function buildApp(role: MemberRole) {
	const adapter = createMockVisionOcr()
	const app = createTestRouter(ctxFor(role)).route('/api/v1', createVisionRoutesInner(adapter))
	app.onError(onError)
	return app
}

// 4-byte JPEG magic header — non-empty payload для passing handler guard.
const SAMPLE_BASE64 = Buffer.from(new Uint8Array([0xff, 0xd8, 0xff, 0xe0])).toString('base64')

describe('vision.routes — RBAC matrix', () => {
	test('[V-R1] staff POST scan → 200 (front-desk operator workflow)', async () => {
		const res = await buildApp('staff').request('/api/v1/passport/scan', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({
				imageBase64: SAMPLE_BASE64,
				mimeType: 'image/jpeg',
				consent152fzAccepted: true,
			}),
		})
		expect(res.status).toBe(200)
	})

	test('[V-R2] manager POST scan → 200', async () => {
		const res = await buildApp('manager').request('/api/v1/passport/scan', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({
				imageBase64: SAMPLE_BASE64,
				mimeType: 'image/jpeg',
				consent152fzAccepted: true,
			}),
		})
		expect(res.status).toBe(200)
	})

	test('[V-R3] owner POST scan → 200 + valid response shape', async () => {
		const res = await buildApp('owner').request('/api/v1/passport/scan', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({
				imageBase64: SAMPLE_BASE64,
				mimeType: 'image/jpeg',
				consent152fzAccepted: true,
			}),
		})
		expect(res.status).toBe(200)
		const body = (await res.json()) as {
			data: {
				detectedCountryIso3: string | null
				isCountryWhitelisted: boolean
				entities: unknown
				outcome: string
				latencyMs: number
				httpStatus: number
			}
		}
		expect(typeof body.data.outcome).toBe('string')
		expect(typeof body.data.latencyMs).toBe('number')
		expect(typeof body.data.httpStatus).toBe('number')
		expect(body.data.entities).toBeDefined()
	})
})

describe('vision.routes — validation', () => {
	test('[V-Z1] missing consent152fzAccepted → 400 (152-ФЗ legal gate)', async () => {
		const res = await buildApp('owner').request('/api/v1/passport/scan', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({
				imageBase64: SAMPLE_BASE64,
				mimeType: 'image/jpeg',
				// no consent152fzAccepted
			}),
		})
		expect(res.status).toBe(400)
	})

	test('[V-Z2] consent152fzAccepted=false → 400 (literal-true expected)', async () => {
		const res = await buildApp('owner').request('/api/v1/passport/scan', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({
				imageBase64: SAMPLE_BASE64,
				mimeType: 'image/jpeg',
				consent152fzAccepted: false,
			}),
		})
		expect(res.status).toBe(400)
	})

	test('[V-Z3] empty imageBase64 → 400', async () => {
		const res = await buildApp('owner').request('/api/v1/passport/scan', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({
				imageBase64: '',
				mimeType: 'image/jpeg',
				consent152fzAccepted: true,
			}),
		})
		expect(res.status).toBe(400)
	})

	test('[V-Z4] invalid mimeType → 400', async () => {
		const res = await buildApp('owner').request('/api/v1/passport/scan', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({
				imageBase64: SAMPLE_BASE64,
				mimeType: 'application/x-something-weird',
				consent152fzAccepted: true,
			}),
		})
		expect(res.status).toBe(400)
	})

	test('[V-Z5] base64 decodes to empty bytes → 400', async () => {
		const res = await buildApp('owner').request('/api/v1/passport/scan', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({
				// '=' is valid single base64 char that decodes to empty
				imageBase64: '=',
				mimeType: 'image/jpeg',
				consent152fzAccepted: true,
			}),
		})
		expect(res.status).toBe(400)
	})
})
