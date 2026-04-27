import { beforeEach, describe, expect, it } from 'vitest'
import {
	__resetAdapterRegistry,
	assertProductionReady,
	getAdapter,
	listAdapters,
	registerAdapter,
} from './registry.ts'

describe('adapter registry', () => {
	beforeEach(() => __resetAdapterRegistry())

	describe('registerAdapter + listAdapters + getAdapter', () => {
		it('registers a single adapter and lists it', () => {
			registerAdapter({
				name: 'payment.stub',
				category: 'payment',
				mode: 'mock',
				description: 'In-process payment stub',
			})
			const all = listAdapters()
			expect(all).toHaveLength(1)
			expect(all[0]).toEqual({
				name: 'payment.stub',
				category: 'payment',
				mode: 'mock',
				description: 'In-process payment stub',
			})
		})

		it('preserves insertion order across multiple registrations', () => {
			registerAdapter({
				name: 'payment.stub',
				category: 'payment',
				mode: 'mock',
				description: 'a',
			})
			registerAdapter({ name: 'epgu.stub', category: 'epgu', mode: 'mock', description: 'b' })
			registerAdapter({ name: 'fiscal.stub', category: 'fiscal', mode: 'mock', description: 'c' })
			expect(listAdapters().map((a) => a.name)).toEqual([
				'payment.stub',
				'epgu.stub',
				'fiscal.stub',
			])
		})

		it('listAdapters returns a frozen array (defensive)', () => {
			registerAdapter({ name: 'a', category: 'payment', mode: 'mock', description: 'x' })
			const list = listAdapters()
			expect(Object.isFrozen(list)).toBe(true)
		})

		it('throws on duplicate registration with descriptive message', () => {
			registerAdapter({ name: 'payment.stub', category: 'payment', mode: 'mock', description: 'x' })
			expect(() =>
				registerAdapter({
					name: 'payment.stub',
					category: 'payment',
					mode: 'live',
					description: 'y',
				}),
			).toThrowError(
				"Adapter already registered: 'payment.stub' (existing mode=mock, new mode=live). " +
					'Each adapter must be registered exactly once at startup.',
			)
		})

		it('getAdapter returns the registered metadata', () => {
			registerAdapter({
				name: 'payment.stub',
				category: 'payment',
				mode: 'mock',
				description: 'x',
				providerVersion: 'v3',
			})
			expect(getAdapter('payment.stub')).toEqual({
				name: 'payment.stub',
				category: 'payment',
				mode: 'mock',
				description: 'x',
				providerVersion: 'v3',
			})
		})

		it('getAdapter returns undefined for unknown name', () => {
			expect(getAdapter('unknown')).toBeUndefined()
		})

		it('__resetAdapterRegistry clears all registrations', () => {
			registerAdapter({ name: 'a', category: 'payment', mode: 'mock', description: 'x' })
			__resetAdapterRegistry()
			expect(listAdapters()).toHaveLength(0)
		})
	})

	describe('assertProductionReady', () => {
		it('passes when no adapters are registered', () => {
			expect(() => assertProductionReady()).not.toThrow()
		})

		it('passes when all adapters are live', () => {
			registerAdapter({ name: 'a', category: 'payment', mode: 'live', description: 'x' })
			registerAdapter({ name: 'b', category: 'epgu', mode: 'live', description: 'y' })
			expect(() => assertProductionReady()).not.toThrow()
		})

		it('throws when a single adapter is mock', () => {
			registerAdapter({ name: 'payment.stub', category: 'payment', mode: 'mock', description: 'x' })
			expect(() => assertProductionReady()).toThrowError(
				/Refusing to start.*1 adapter\(s\) not in 'live' mode:.*payment\.stub.*mode=mock/s,
			)
		})

		it('throws when a single adapter is sandbox (sandbox in prod = config bug)', () => {
			registerAdapter({
				name: 'payment.yookassa',
				category: 'payment',
				mode: 'sandbox',
				description: 'x',
			})
			expect(() => assertProductionReady()).toThrowError(
				/Refusing to start.*payment\.yookassa.*mode=sandbox/s,
			)
		})

		it('lists ALL offenders (not just the first) in error message', () => {
			registerAdapter({ name: 'a', category: 'payment', mode: 'mock', description: 'x' })
			registerAdapter({ name: 'b', category: 'epgu', mode: 'sandbox', description: 'y' })
			registerAdapter({ name: 'c', category: 'fiscal', mode: 'live', description: 'z' })
			let caught: Error | undefined
			try {
				assertProductionReady()
			} catch (e) {
				caught = e as Error
			}
			expect(caught).toBeDefined()
			expect(caught!.message).toContain('2 adapter(s)')
			expect(caught!.message).toContain('a (category=payment, mode=mock)')
			expect(caught!.message).toContain('b (category=epgu, mode=sandbox)')
			// `c` is live → must NOT appear in the offender list
			expect(caught!.message).not.toContain('c (category=')
		})

		it('respects permittedMockAdapters whitelist for mock mode', () => {
			registerAdapter({ name: 'epgu.stub', category: 'epgu', mode: 'mock', description: 'x' })
			expect(() => assertProductionReady({ permittedMockAdapters: ['epgu.stub'] })).not.toThrow()
		})

		it('respects permittedMockAdapters whitelist for sandbox mode (e.g. transition)', () => {
			registerAdapter({
				name: 'payment.yookassa',
				category: 'payment',
				mode: 'sandbox',
				description: 'x',
			})
			expect(() =>
				assertProductionReady({ permittedMockAdapters: ['payment.yookassa'] }),
			).not.toThrow()
		})

		it('throws when whitelist covers SOME but not all offenders', () => {
			registerAdapter({ name: 'epgu.stub', category: 'epgu', mode: 'mock', description: 'x' })
			registerAdapter({
				name: 'payment.stub',
				category: 'payment',
				mode: 'mock',
				description: 'y',
			})
			let caught: Error | undefined
			try {
				assertProductionReady({ permittedMockAdapters: ['epgu.stub'] })
			} catch (e) {
				caught = e as Error
			}
			expect(caught).toBeDefined()
			// Whitelisted name MUST NOT appear in offender list
			expect(caught!.message).toContain('payment.stub')
			expect(caught!.message).not.toContain('- epgu.stub (category=')
			expect(caught!.message).toContain('1 adapter(s)')
		})

		it('empty whitelist behaves identically to no whitelist param', () => {
			registerAdapter({ name: 'a', category: 'payment', mode: 'mock', description: 'x' })
			const fn1 = () => assertProductionReady({})
			const fn2 = () => assertProductionReady({ permittedMockAdapters: [] })
			const fn3 = () => assertProductionReady()
			expect(fn1).toThrow()
			expect(fn2).toThrow()
			expect(fn3).toThrow()
		})

		it('whitelist with non-existent adapter name does not change behavior', () => {
			// Non-existent whitelist entries are silently ignored — they neither
			// fail validation nor become "phantom registrations". This keeps the
			// whitelist hot-list-friendly: ops can pre-add names anticipating
			// future regressions without false alerts.
			registerAdapter({ name: 'a', category: 'payment', mode: 'live', description: 'x' })
			expect(() =>
				assertProductionReady({ permittedMockAdapters: ['ghost.adapter', 'another.ghost'] }),
			).not.toThrow()
		})
	})
})
