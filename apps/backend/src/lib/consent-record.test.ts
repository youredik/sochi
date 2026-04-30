/**
 * Strict tests для consent-record helper (M9.widget.4).
 *
 * Test matrix per `feedback_strict_tests.md`:
 *   ─── Insert path ──────────────────────────────────────────────
 *     [CR1] '152fz_pd' UI type → 'dpaAcceptance' canonical schema enum stored
 *     [CR2] '38fz_marketing' UI type → 'marketing' canonical schema enum stored
 *     [CR3] Both consents inserted в same call → 2 rows persist
 *     [CR4] Empty consents array → [] returned, no rows inserted (no-op)
 *
 *   ─── Adversarial (missing inputs) ─────────────────────────────
 *     [CR5] Missing guestId throws с descriptive error
 *     [CR6] Missing tenantId throws
 *     [CR7] Missing ipAddress throws
 *
 *   ─── Cross-tenant isolation ───────────────────────────────────
 *     [CR8] listConsentsForGuest from wrong tenant returns []
 *     [CR9] listConsentsForGuest filters by guestId — другие guests invisible
 *
 *   ─── Stored data fidelity ─────────────────────────────────────
 *     [CR10] textSnapshot exact wording stored (not template name)
 *     [CR11] consentVersion stored verbatim ('v1.0' / 'v1.1')
 *     [CR12] userAgent null handled через textOpt (no YDB null poison)
 */

import { newId } from '@horeca/shared'
import { afterAll, beforeAll, describe, expect, test } from 'vitest'
import { getTestSql, setupTestDb, teardownTestDb } from '../tests/db-setup.ts'
import { listConsentsForGuest, recordConsents } from './consent-record.ts'

describe('consent-record', { tags: ['db'], timeout: 60_000 }, () => {
	beforeAll(async () => {
		await setupTestDb()
	})

	afterAll(async () => {
		await teardownTestDb()
	})

	test('[CR1] 152fz_pd UI type → dpaAcceptance canonical schema enum', async () => {
		const sql = getTestSql()
		const tenantId = newId('organization')
		const guestId = newId('guest')
		const now = new Date('2026-06-15T12:34:56Z')

		const ids = await recordConsents(sql, {
			tenantId,
			guestId,
			ipAddress: '192.168.1.1',
			userAgent: 'Mozilla/5.0 test',
			consents: [
				{
					type: '152fz_pd',
					textSnapshot: 'Я даю согласие на обработку персональных данных согласно 152-ФЗ',
					version: 'v1.0',
				},
			],
			grantedAt: now,
		})

		expect(ids).toHaveLength(1)
		const list = await listConsentsForGuest(sql, tenantId, guestId)
		expect(list).toHaveLength(1)
		expect(list[0]?.consentType).toBe('dpaAcceptance')
		expect(list[0]?.consentVersion).toBe('v1.0')
	})

	test('[CR2] 38fz_marketing UI type → marketing canonical schema enum', async () => {
		const sql = getTestSql()
		const tenantId = newId('organization')
		const guestId = newId('guest')

		await recordConsents(sql, {
			tenantId,
			guestId,
			ipAddress: '10.0.0.1',
			userAgent: null,
			consents: [
				{
					type: '38fz_marketing',
					textSnapshot: 'Я согласен получать рекламные рассылки на email',
					version: 'v1.0',
				},
			],
			grantedAt: new Date(),
		})

		const list = await listConsentsForGuest(sql, tenantId, guestId)
		expect(list).toHaveLength(1)
		expect(list[0]?.consentType).toBe('marketing')
	})

	test('[CR3] Both consents inserted в same call → 2 rows persist в order', async () => {
		const sql = getTestSql()
		const tenantId = newId('organization')
		const guestId = newId('guest')

		const ids = await recordConsents(sql, {
			tenantId,
			guestId,
			ipAddress: '127.0.0.1',
			userAgent: 'test',
			consents: [
				{ type: '152fz_pd', textSnapshot: '152-ФЗ text', version: 'v1.0' },
				{ type: '38fz_marketing', textSnapshot: '38-ФЗ marketing text', version: 'v1.0' },
			],
			grantedAt: new Date(),
		})

		expect(ids).toHaveLength(2)
		const list = await listConsentsForGuest(sql, tenantId, guestId)
		expect(list).toHaveLength(2)
		const types = list.map((r) => r.consentType).sort()
		expect(types).toEqual(['dpaAcceptance', 'marketing'])
	})

	test('[CR4] Empty consents array → no-op, returns []', async () => {
		const sql = getTestSql()
		const tenantId = newId('organization')
		const guestId = newId('guest')

		const ids = await recordConsents(sql, {
			tenantId,
			guestId,
			ipAddress: '127.0.0.1',
			userAgent: null,
			consents: [],
			grantedAt: new Date(),
		})

		expect(ids).toEqual([])
		const list = await listConsentsForGuest(sql, tenantId, guestId)
		expect(list).toHaveLength(0)
	})

	test('[CR5] Missing guestId throws', async () => {
		const sql = getTestSql()
		await expect(
			recordConsents(sql, {
				tenantId: newId('organization'),
				guestId: '',
				ipAddress: '127.0.0.1',
				userAgent: null,
				consents: [{ type: '152fz_pd', textSnapshot: 'text', version: 'v1.0' }],
				grantedAt: new Date(),
			}),
		).rejects.toThrowError(/guestId required/)
	})

	test('[CR6] Missing tenantId throws', async () => {
		const sql = getTestSql()
		await expect(
			recordConsents(sql, {
				tenantId: '',
				guestId: newId('guest'),
				ipAddress: '127.0.0.1',
				userAgent: null,
				consents: [{ type: '152fz_pd', textSnapshot: 'text', version: 'v1.0' }],
				grantedAt: new Date(),
			}),
		).rejects.toThrowError(/tenantId required/)
	})

	test('[CR7] Missing ipAddress throws', async () => {
		const sql = getTestSql()
		await expect(
			recordConsents(sql, {
				tenantId: newId('organization'),
				guestId: newId('guest'),
				ipAddress: '',
				userAgent: null,
				consents: [{ type: '152fz_pd', textSnapshot: 'text', version: 'v1.0' }],
				grantedAt: new Date(),
			}),
		).rejects.toThrowError(/ipAddress required/)
	})

	test('[CR8] cross-tenant: listConsentsForGuest from wrong tenant returns []', async () => {
		const sql = getTestSql()
		const tenantA = newId('organization')
		const tenantB = newId('organization')
		const guestId = newId('guest')

		await recordConsents(sql, {
			tenantId: tenantA,
			guestId,
			ipAddress: '127.0.0.1',
			userAgent: null,
			consents: [{ type: '152fz_pd', textSnapshot: 'text', version: 'v1.0' }],
			grantedAt: new Date(),
		})

		const fromB = await listConsentsForGuest(sql, tenantB, guestId)
		expect(fromB).toHaveLength(0)
		const fromA = await listConsentsForGuest(sql, tenantA, guestId)
		expect(fromA).toHaveLength(1)
	})

	test('[CR9] listConsentsForGuest filters by guestId — другие guests invisible', async () => {
		const sql = getTestSql()
		const tenantId = newId('organization')
		const guestA = newId('guest')
		const guestB = newId('guest')

		await recordConsents(sql, {
			tenantId,
			guestId: guestA,
			ipAddress: '127.0.0.1',
			userAgent: null,
			consents: [{ type: '152fz_pd', textSnapshot: 'A consent', version: 'v1.0' }],
			grantedAt: new Date(),
		})
		await recordConsents(sql, {
			tenantId,
			guestId: guestB,
			ipAddress: '127.0.0.1',
			userAgent: null,
			consents: [{ type: '152fz_pd', textSnapshot: 'B consent', version: 'v1.0' }],
			grantedAt: new Date(),
		})

		const fromA = await listConsentsForGuest(sql, tenantId, guestA)
		const fromB = await listConsentsForGuest(sql, tenantId, guestB)
		expect(fromA).toHaveLength(1)
		expect(fromA[0]?.textSnapshot).toBe('A consent')
		expect(fromB).toHaveLength(1)
		expect(fromB[0]?.textSnapshot).toBe('B consent')
	})

	test('[CR10] textSnapshot exact wording stored verbatim', async () => {
		const sql = getTestSql()
		const tenantId = newId('organization')
		const guestId = newId('guest')
		const exactText =
			'Я, нижеподписавшийся, даю согласие ООО "Сириус" на обработку персональных ' +
			'данных в целях исполнения договора оказания гостиничных услуг согласно ' +
			'требованиям 152-ФЗ "О персональных данных". Срок обработки: 3 года ' +
			'с момента выезда. Право отзыва: через личный кабинет.'

		await recordConsents(sql, {
			tenantId,
			guestId,
			ipAddress: '127.0.0.1',
			userAgent: null,
			consents: [{ type: '152fz_pd', textSnapshot: exactText, version: 'v1.0' }],
			grantedAt: new Date(),
		})

		const list = await listConsentsForGuest(sql, tenantId, guestId)
		expect(list[0]?.textSnapshot).toBe(exactText)
	})

	test('[CR11] consentVersion stored verbatim (v1.0 vs v1.1 traceability)', async () => {
		const sql = getTestSql()
		const tenantId = newId('organization')
		const guestId = newId('guest')

		await recordConsents(sql, {
			tenantId,
			guestId,
			ipAddress: '127.0.0.1',
			userAgent: null,
			consents: [
				{ type: '152fz_pd', textSnapshot: 'old version', version: 'v1.0' },
				{ type: '38fz_marketing', textSnapshot: 'new version', version: 'v1.1' },
			],
			grantedAt: new Date(),
		})

		const list = await listConsentsForGuest(sql, tenantId, guestId)
		const v10 = list.find((r) => r.consentType === 'dpaAcceptance')
		const v11 = list.find((r) => r.consentType === 'marketing')
		expect(v10?.consentVersion).toBe('v1.0')
		expect(v11?.consentVersion).toBe('v1.1')
	})

	test('[CR12] userAgent null handled через textOpt (no YDB null poison)', async () => {
		const sql = getTestSql()
		const tenantId = newId('organization')
		const guestId = newId('guest')

		// Should NOT throw "Null value at position N" YDB error
		const ids = await recordConsents(sql, {
			tenantId,
			guestId,
			ipAddress: '127.0.0.1',
			userAgent: null,
			consents: [{ type: '152fz_pd', textSnapshot: 'text', version: 'v1.0' }],
			grantedAt: new Date(),
		})

		expect(ids).toHaveLength(1)
	})
})
