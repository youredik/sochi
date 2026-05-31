/**
 * Webhook secret repo — strict integration tests WS1-WS6 (M10 / A7.1.fix).
 *
 * Requires local YDB. Tests:
 *   - rotate: new active inserted, existing active → previous (atomic)
 *   - listAccepted: returns active + previous, sorted active-first
 *   - expirePrevious: previous-with-expired-window → expired
 *   - generateMockSecret format
 */

import { afterAll, beforeAll, describe, expect, test } from 'vitest'

import { getTestSql, setupTestDb, teardownTestDb } from '../../tests/db-setup.ts'
import { createWebhookSecretRepo, generateMockSecret } from './webhook-secret.repo.ts'

const RUN_ID = Date.now().toString(36)
const CHANNEL = `TLws_${RUN_ID}`

describe('webhook secret repo', () => {
	let repo: ReturnType<typeof createWebhookSecretRepo>

	beforeAll(async () => {
		await setupTestDb()
		repo = createWebhookSecretRepo(getTestSql())
	})

	afterAll(async () => {
		const sql = getTestSql()
		await sql`DELETE FROM webhookSecret WHERE channelId = ${CHANNEL}`
		await teardownTestDb()
	})

	test('[WS1] generateMockSecret produces whsec_mock_<base64url> format', () => {
		const secret = generateMockSecret()
		expect(secret.startsWith('whsec_mock_')).toBe(true)
		// base64url payload uses [A-Za-z0-9_-]; 24 raw bytes → 32 chars.
		expect(secret.length).toBeGreaterThan('whsec_mock_'.length + 30)
		expect(/^whsec_mock_[A-Za-z0-9_-]+$/.test(secret)).toBe(true)
	})

	test('[WS2] rotate: first insert creates active row + 0 demoted', async () => {
		const result = await repo.rotate({
			channelId: CHANNEL,
			kid: 'kid_v1',
			secret: 'whsec_mock_v1aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
			previousExpiresAtMs: Date.now() + 48 * 60 * 60_000,
		})
		expect(result.demoted).toBe(0)
		const active = await repo.getByKid({ channelId: CHANNEL, kid: 'kid_v1' })
		expect(active?.status).toBe('active')
	})

	test('[WS3] rotate: second insert demotes previous active → previous (1 demoted)', async () => {
		const result = await repo.rotate({
			channelId: CHANNEL,
			kid: 'kid_v2',
			secret: 'whsec_mock_v2aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
			previousExpiresAtMs: Date.now() + 48 * 60 * 60_000,
		})
		expect(result.demoted).toBe(1)
		const v1 = await repo.getByKid({ channelId: CHANNEL, kid: 'kid_v1' })
		const v2 = await repo.getByKid({ channelId: CHANNEL, kid: 'kid_v2' })
		expect(v1?.status).toBe('previous')
		expect(v1?.expiresAt).not.toBeNull()
		expect(v2?.status).toBe('active')
		expect(v2?.expiresAt).toBeNull()
	})

	test('[WS4] listAccepted returns active + previous, active-first', async () => {
		const list = await repo.listAccepted(CHANNEL)
		expect(list.length).toBe(2)
		expect(list[0]?.status).toBe('active')
		expect(list[0]?.kid).toBe('kid_v2')
		expect(list[1]?.status).toBe('previous')
		expect(list[1]?.kid).toBe('kid_v1')
	})

	test('[WS5] expirePrevious flips expired-window previous → expired (excluded from listAccepted)', async () => {
		// First demote with a past expiresAt by manually rotating with old window.
		await repo.rotate({
			channelId: CHANNEL,
			kid: 'kid_v3',
			secret: 'whsec_mock_v3aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
			// expiresAt 1 ms ago → next call expires it.
			previousExpiresAtMs: Date.now() - 1,
		})
		const result = await repo.expirePrevious({ channelId: CHANNEL, nowMs: Date.now() })
		expect(result.expired).toBeGreaterThanOrEqual(1)
		const list = await repo.listAccepted(CHANNEL)
		// Only 'active' remains (expired excluded).
		expect(list.every((r) => r.status === 'active' || r.status === 'previous')).toBe(true)
		// kid_v2 was demoted on rotate→v3 with past window → now expired → not в list.
		expect(list.find((r) => r.kid === 'kid_v2')).toBeUndefined()
	})

	test('[WS6] getByKid returns null for unknown kid', async () => {
		const got = await repo.getByKid({ channelId: CHANNEL, kid: 'nonexistent' })
		expect(got).toBeNull()
	})
})
