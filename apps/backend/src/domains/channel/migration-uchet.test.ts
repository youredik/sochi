/**
 * МВД миграционный учёт canonical refusal — strict tests MIG1-MIG3 (M10 / A7.5 / D20).
 *
 * Per plan §4 п.27 — 3 МВД tests:
 *   - MIG1: channel webhook → still hotel-side (delegation rejected)
 *   - MIG2: госпошлина 500 ₽ since 27 Jan 2026
 *   - MIG3: RU citizen vs foreigner branching
 */

import { describe, expect, it } from 'bun:test'
import {
	assertNoChannelMigrationDelegation,
	ChannelMigrationDelegationError,
	deriveMigrationRequirement,
} from './migration-uchet.ts'

describe('Migration учёт — D20 NEVER via channel (MIG1-MIG3)', () => {
	it('[MIG1] channel webhook payload с migrationRegistrationId → ChannelMigrationDelegationError 422', () => {
		expect(() =>
			assertNoChannelMigrationDelegation({
				channelId: 'TL',
				payload: { migrationRegistrationId: 'mvd-12345' },
			}),
		).toThrow(ChannelMigrationDelegationError)
	})

	it('[MIG1.b] payload с epguSubmittedAt → rejected', () => {
		let caught: ChannelMigrationDelegationError | undefined
		try {
			assertNoChannelMigrationDelegation({
				channelId: 'YT',
				payload: { epguSubmittedAt: '2026-05-04T12:00:00.000Z' },
			})
		} catch (err) {
			caught = err as ChannelMigrationDelegationError
		}
		expect(caught).toBeInstanceOf(ChannelMigrationDelegationError)
		expect(caught?.httpStatus).toBe(422)
		expect(caught?.message).toContain('epguSubmittedAt')
	})

	it('[MIG1.c] payload с epguStatusCode → rejected', () => {
		expect(() =>
			assertNoChannelMigrationDelegation({
				channelId: 'ETG',
				payload: { epguStatusCode: 17 },
			}),
		).toThrow(/epguStatusCode/)
	})

	it('[MIG1.d] clean payload без migration claims → no throw', () => {
		expect(() =>
			assertNoChannelMigrationDelegation({
				channelId: 'TL',
				payload: { firstName: 'Иван', lastName: 'Петров', email: 'ip@test.ru' },
			}),
		).not.toThrow()
	})

	it('[MIG2] foreign citizen requires epgu route + 500 RUB госпошлина since 27 Jan 2026', () => {
		const req = deriveMigrationRequirement({ citizenship: 'foreign' })
		expect(req.required).toBe(true)
		expect(req.route).toBe('epgu')
		expect(req.gosposhlinaMicros).toBe(500_000_000n) // 500 ₽ × 1M micros
		expect(req.effectiveSinceUtc).toBe('2026-01-27')
	})

	it('[MIG3] RU citizen non-родственник: simple_registration route, NO gosposhlina', () => {
		const req = deriveMigrationRequirement({ citizenship: 'ru_citizen_other' })
		expect(req.required).toBe(true)
		expect(req.route).toBe('simple_registration')
		expect(req.gosposhlinaMicros).toBeNull()
	})

	it('[MIG3.b] RU citizen родственник — registration NOT required', () => {
		const req = deriveMigrationRequirement({ citizenship: 'ru_citizen_родственник' })
		expect(req.required).toBe(false)
		expect(req.route).toBe('none')
		expect(req.gosposhlinaMicros).toBeNull()
	})
})
