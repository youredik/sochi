/**
 * Factory-level sanctions HARD-DISABLE — strict tests SF1-SF4 (M10 / A7.5.fix / D16).
 *
 * Defense-in-depth: orchestrator-level gate already blocks BCOM/EXP/ABN
 * in `evaluateSyncGate` (SYNC2). This test suite verifies the factory layer
 * BLOCKS registration entirely — sanctioned channel can never be wired,
 * even by accident.
 *
 * Re-enable trigger: sanctions lift + RKN re-notify + manual code change.
 */

import { describe, expect, it } from 'vitest'
import { sql } from '../../db/index.ts'
import { createChannelFactory, SanctionedChannelError } from './channel.factory.ts'

describe('Factory sanctions HARD-DISABLE — D16 (SF1-SF4)', () => {
	it('[SF1] registerAdapterFactory("BCOM", ...) throws SanctionedChannelError 451', () => {
		const f = createChannelFactory(sql, { enableDispatcher: false })
		expect(() =>
			f.registerAdapterFactory('BCOM', async () => {
				throw new Error('should not reach factory body')
			}),
		).toThrow(SanctionedChannelError)
	})

	it('[SF2] registerAdapterFactory("EXP", ...) throws — Expedia sanctioned', () => {
		const f = createChannelFactory(sql, { enableDispatcher: false })
		try {
			f.registerAdapterFactory('EXP', async () => {
				throw new Error('should not reach')
			})
			expect.fail('expected throw')
		} catch (err) {
			expect(err).toBeInstanceOf(SanctionedChannelError)
			expect((err as SanctionedChannelError).httpStatus).toBe(451)
			expect((err as Error).message).toContain('HARD-DISABLED')
		}
	})

	it('[SF3] registerAdapterFactory("ABN", ...) throws — Airbnb sanctioned', () => {
		const f = createChannelFactory(sql, { enableDispatcher: false })
		expect(() =>
			f.registerAdapterFactory('ABN', async () => {
				throw new Error('should not reach')
			}),
		).toThrow(/HARD-DISABLED/)
	})

	it('[SF4] registerHttpAttempt also blocks sanctioned channels (defense-in-depth)', () => {
		const f = createChannelFactory(sql, { enableDispatcher: false })
		expect(() =>
			f.registerHttpAttempt('BCOM', async () => ({ ok: true, httpStatus: 200 })),
		).toThrow(SanctionedChannelError)
	})

	it('[SF5] Non-sanctioned channels register successfully (TL/YT/ETG)', () => {
		const f = createChannelFactory(sql, { enableDispatcher: false })
		expect(() => f.registerAdapterFactory('TL', async () => ({}) as never)).not.toThrow()
		expect(() => f.registerAdapterFactory('YT', async () => ({}) as never)).not.toThrow()
		expect(() => f.registerAdapterFactory('ETG', async () => ({}) as never)).not.toThrow()
	})
})
