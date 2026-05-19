/**
 * Strict unit tests для createShutdownHandler (B7 race-fix, 2026-05-19).
 *
 * Empirically verifies the SIGTERM teardown order canon. Previous codepath had
 * a fire-and-forget `void stopApp()` racing с `process.exit(0)` — these tests
 * pin the await sequence so any future regression к the race breaks here, not
 * in a flaky k8s drain.
 */

import { describe, expect, mock, test } from 'bun:test'
import { createShutdownHandler, type ShutdownDeps } from './shutdown.ts'

interface LoggedEntry {
	obj: Record<string, unknown>
	msg?: string | undefined
}

function makeDeps(
	overrides: Partial<ShutdownDeps> & { callOrder?: string[] } = {},
): ShutdownDeps & {
	callOrder: string[]
} {
	const callOrder = overrides.callOrder ?? []
	return {
		callOrder,
		server: overrides.server ?? {
			close: () => {
				callOrder.push('server.close')
			},
		},
		closeDriver:
			overrides.closeDriver ??
			(async () => {
				callOrder.push('closeDriver')
			}),
		stopApp:
			overrides.stopApp ??
			(async () => {
				callOrder.push('stopApp')
			}),
		exit:
			overrides.exit ??
			(((code: number) => {
				callOrder.push(`exit(${code})`)
				throw new Error('test-exit-marker')
			}) as never),
		logger: overrides.logger ?? {
			info: () => undefined,
			error: () => undefined,
		},
	}
}

describe('createShutdownHandler — canonical teardown order', () => {
	test('stopApp awaited BEFORE server.close + closeDriver + exit', async () => {
		const deps = makeDeps()
		const shutdown = createShutdownHandler(deps)
		await expect(shutdown('SIGTERM')).rejects.toThrow('test-exit-marker')
		// Canon order pinned: stopApp drains CDC FIRST, then server stops
		// accepting new requests, then driver closed, then process exits.
		expect(deps.callOrder).toEqual(['stopApp', 'server.close', 'closeDriver', 'exit(0)'])
	})

	test('async stopApp delays subsequent steps (not fire-and-forget)', async () => {
		const deps = makeDeps()
		// Simulate slow stopApp — server.close MUST wait, not race.
		deps.stopApp = (async () => {
			await new Promise((r) => setTimeout(r, 30))
			deps.callOrder.push('stopApp')
		}) as ShutdownDeps['stopApp']
		const shutdown = createShutdownHandler(deps)
		const start = Date.now()
		await expect(shutdown('SIGTERM')).rejects.toThrow('test-exit-marker')
		// Total time ≥ 30ms (stopApp delay) — server.close did not run before stopApp.
		expect(Date.now() - start).toBeGreaterThanOrEqual(25)
		expect(deps.callOrder[0]).toBe('stopApp')
		expect(deps.callOrder[1]).toBe('server.close')
	})

	test('exit called with code 0 (clean shutdown)', async () => {
		const deps = makeDeps()
		const exitSpy = mock<(code: number) => never>(((code: number) => {
			deps.callOrder.push(`exit(${code})`)
			throw new Error('test-exit-marker')
		}) as never)
		deps.exit = exitSpy as unknown as (code: number) => never
		const shutdown = createShutdownHandler(deps)
		await expect(shutdown('SIGTERM')).rejects.toThrow('test-exit-marker')
		expect(exitSpy).toHaveBeenCalledTimes(1)
		expect(exitSpy.mock.calls[0]?.[0]).toBe(0)
	})
})

describe('createShutdownHandler — shuttingDown re-entry guard', () => {
	test('second invocation = no-op (k8s/ALB redelivery defense)', async () => {
		const deps = makeDeps()
		// Slow stopApp so second call arrives during first execution.
		let stopAppCalls = 0
		deps.stopApp = (async () => {
			stopAppCalls += 1
			await new Promise((r) => setTimeout(r, 20))
			deps.callOrder.push('stopApp')
		}) as ShutdownDeps['stopApp']
		const shutdown = createShutdownHandler(deps)
		const p1 = shutdown('SIGTERM').catch(() => undefined)
		const p2 = shutdown('SIGTERM').catch(() => undefined)
		await Promise.all([p1, p2])
		// Only ONE stopApp invocation despite two signal deliveries.
		expect(stopAppCalls).toBe(1)
		// callOrder reflects single teardown sequence.
		expect(deps.callOrder.filter((c) => c === 'server.close')).toHaveLength(1)
		expect(deps.callOrder.filter((c) => c === 'closeDriver')).toHaveLength(1)
		expect(deps.callOrder.filter((c) => c === 'exit(0)')).toHaveLength(1)
	})

	test('different signals (SIGINT then SIGTERM) still collapsed by guard', async () => {
		const deps = makeDeps()
		let stopAppCalls = 0
		deps.stopApp = (async () => {
			stopAppCalls += 1
			await new Promise((r) => setTimeout(r, 20))
			deps.callOrder.push('stopApp')
		}) as ShutdownDeps['stopApp']
		const shutdown = createShutdownHandler(deps)
		const p1 = shutdown('SIGINT').catch(() => undefined)
		const p2 = shutdown('SIGTERM').catch(() => undefined)
		await Promise.all([p1, p2])
		expect(stopAppCalls).toBe(1)
	})
})

describe('createShutdownHandler — failure-mode robustness', () => {
	test('stopApp throw → logged + shutdown continues (no process hang)', async () => {
		const deps = makeDeps()
		const loggedErrors: LoggedEntry[] = []
		deps.logger = {
			info: () => undefined,
			error: (obj: Record<string, unknown>, msg?: string) => {
				loggedErrors.push({ obj, msg })
			},
		}
		deps.stopApp = (async () => {
			throw new Error('CDC consumer drain failed')
		}) as ShutdownDeps['stopApp']
		const shutdown = createShutdownHandler(deps)
		await expect(shutdown('SIGTERM')).rejects.toThrow('test-exit-marker')
		// stopApp failure must NOT block server.close + closeDriver + exit —
		// otherwise process hangs past terminationGracePeriodSeconds → SIGKILL.
		expect(deps.callOrder).toEqual(['server.close', 'closeDriver', 'exit(0)'])
		// And error MUST be logged via structured logger.error.
		expect(loggedErrors).toHaveLength(1)
		expect((loggedErrors[0]?.obj.err as Error).message).toBe('CDC consumer drain failed')
		expect(loggedErrors[0]?.msg).toMatch(/stopApp failed/)
	})

	test('shutdown logs signal label на entry (operator audit)', async () => {
		const deps = makeDeps()
		const loggedInfo: LoggedEntry[] = []
		deps.logger = {
			info: (obj: Record<string, unknown>, msg?: string) => {
				loggedInfo.push({ obj, msg })
			},
			error: () => undefined,
		}
		const shutdown = createShutdownHandler(deps)
		await expect(shutdown('SIGTERM')).rejects.toThrow('test-exit-marker')
		expect(loggedInfo[0]?.obj.signal).toBe('SIGTERM')
		expect(loggedInfo[0]?.msg).toMatch(/Shutting down/)
	})
})
