/**
 * Strict unit tests для createShutdownHandler.
 *
 * Pins the drain-safe SIGTERM teardown canon (2026-05-30 rewrite):
 *   beginDraining → sleep(drainDelay) → stopApp → server.close (awaited) +
 *   closeIdleConnections → closeDriver → exit(0).
 *
 * Any regression к the old «server.close() fire-and-forget then closeDriver()»
 * race (which produced «Channel has been shut down» 500s during YC revision
 * deploys) breaks here, not в a flaky prod drain.
 */

import { describe, expect, mock, test } from 'bun:test'
import { createShutdownHandler, type ShutdownDeps } from './shutdown.ts'

interface LoggedEntry {
	obj: Record<string, unknown>
	msg?: string | undefined
}

function makeDeps(
	overrides: Partial<ShutdownDeps> & { callOrder?: string[]; closeCallsCallback?: boolean } = {},
): ShutdownDeps & { callOrder: string[] } {
	const callOrder = overrides.callOrder ?? []
	// By default server.close fires its callback synchronously (all connections
	// closed) so closeServer resolves via the «closed» branch, not the timeout.
	const closeCallsCallback = overrides.closeCallsCallback ?? true
	return {
		callOrder,
		server: overrides.server ?? {
			close: (cb?: (err?: Error) => void) => {
				callOrder.push('server.close')
				if (closeCallsCallback) cb?.()
			},
			closeIdleConnections: () => {
				callOrder.push('closeIdleConnections')
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
		beginDraining:
			overrides.beginDraining ??
			(() => {
				callOrder.push('beginDraining')
			}),
		drainDelayMs: overrides.drainDelayMs ?? 4000,
		serverCloseTimeoutMs: overrides.serverCloseTimeoutMs ?? 8000,
		// Instant sleep — records the requested ms so order/duration is assertable
		// without real timers. `closed` (sync callback) wins the race over this.
		sleep:
			overrides.sleep ??
			((ms: number) => {
				callOrder.push(`sleep(${ms})`)
				return Promise.resolve()
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

describe('createShutdownHandler — drain-safe teardown order', () => {
	test('full canonical sequence pinned', async () => {
		const deps = makeDeps()
		const shutdown = createShutdownHandler(deps)
		await expect(shutdown('SIGTERM')).rejects.toThrow('test-exit-marker')
		expect(deps.callOrder).toEqual([
			'beginDraining',
			'sleep(4000)',
			'stopApp',
			'server.close',
			'closeIdleConnections',
			'sleep(8000)',
			'closeDriver',
			'exit(0)',
		])
	})

	test('beginDraining runs FIRST — before the pre-drain sleep + everything else', async () => {
		const deps = makeDeps()
		const shutdown = createShutdownHandler(deps)
		await expect(shutdown('SIGTERM')).rejects.toThrow('test-exit-marker')
		expect(deps.callOrder[0]).toBe('beginDraining')
		// Pre-drain sleep happens before CDC drain (stopApp).
		expect(deps.callOrder.indexOf('sleep(4000)')).toBeLessThan(deps.callOrder.indexOf('stopApp'))
	})

	test('closeDriver runs AFTER server.close (no in-flight query can hit a dead driver)', async () => {
		const deps = makeDeps()
		const shutdown = createShutdownHandler(deps)
		await expect(shutdown('SIGTERM')).rejects.toThrow('test-exit-marker')
		expect(deps.callOrder.indexOf('server.close')).toBeLessThan(
			deps.callOrder.indexOf('closeDriver'),
		)
	})

	test('server.close is AWAITED — closeDriver waits for the close callback', async () => {
		const callOrder: string[] = []
		// server.close fires its callback asynchronously (in-flight drain takes time).
		const deps = makeDeps({
			callOrder,
			server: {
				close: (cb?: (err?: Error) => void) => {
					callOrder.push('server.close:start')
					setTimeout(() => {
						callOrder.push('server.close:done')
						cb?.()
					}, 20)
				},
				closeIdleConnections: () => callOrder.push('closeIdleConnections'),
			},
		})
		const shutdown = createShutdownHandler(deps)
		await expect(shutdown('SIGTERM')).rejects.toThrow('test-exit-marker')
		// closeDriver MUST come after the async close callback resolved.
		expect(callOrder.indexOf('server.close:done')).toBeLessThan(callOrder.indexOf('closeDriver'))
	})

	test('drainDelayMs=0 skips the pre-drain sleep (test/dev fast path)', async () => {
		const deps = makeDeps({ drainDelayMs: 0 })
		const shutdown = createShutdownHandler(deps)
		await expect(shutdown('SIGTERM')).rejects.toThrow('test-exit-marker')
		expect(deps.callOrder).not.toContain('sleep(0)')
		expect(deps.callOrder[0]).toBe('beginDraining')
		expect(deps.callOrder[1]).toBe('stopApp')
	})

	test('exit called once with code 0', async () => {
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

describe('createShutdownHandler — server.close timeout bound', () => {
	test('server.close that never settles → forced after serverCloseTimeoutMs + logged', async () => {
		const loggedErrors: LoggedEntry[] = []
		const callOrder: string[] = []
		const deps = makeDeps({
			callOrder,
			closeCallsCallback: false, // close callback NEVER fires (wedged socket)
			logger: {
				info: () => undefined,
				error: (obj, msg) => loggedErrors.push({ obj, msg }),
			},
		})
		const shutdown = createShutdownHandler(deps)
		await expect(shutdown('SIGTERM')).rejects.toThrow('test-exit-marker')
		// Timeout sleep wins the race → still proceeds к closeDriver + exit.
		expect(callOrder).toContain('closeDriver')
		expect(callOrder).toContain('exit(0)')
		const timeoutLog = loggedErrors.find((e) => /server.close exceeded timeout/.test(e.msg ?? ''))
		expect(timeoutLog?.msg).toContain('forcing driver close')
		expect(timeoutLog?.obj.timeoutMs).toBe(8000)
	})
})

describe('createShutdownHandler — re-entry guard', () => {
	test('second signal during slow drain = no-op (YC/ALB redelivery defense)', async () => {
		let stopAppCalls = 0
		const deps = makeDeps({
			stopApp: (async () => {
				stopAppCalls += 1
				await new Promise((r) => setTimeout(r, 20))
			}) as ShutdownDeps['stopApp'],
			// Real-ish sleep so the second signal arrives mid-drain.
			sleep: ((ms: number) =>
				new Promise<void>((r) => setTimeout(r, Math.min(ms, 10)))) as ShutdownDeps['sleep'],
		})
		const shutdown = createShutdownHandler(deps)
		const p1 = shutdown('SIGTERM').catch(() => undefined)
		const p2 = shutdown('SIGTERM').catch(() => undefined)
		await Promise.all([p1, p2])
		expect(stopAppCalls).toBe(1)
		expect(deps.callOrder.filter((c) => c === 'closeDriver')).toHaveLength(1)
	})
})

describe('createShutdownHandler — failure-mode robustness', () => {
	test('stopApp throw → logged + teardown still completes (no hang past grace budget)', async () => {
		const loggedErrors: LoggedEntry[] = []
		const deps = makeDeps({
			logger: {
				info: () => undefined,
				error: (obj, msg) => loggedErrors.push({ obj, msg }),
			},
			stopApp: (async () => {
				throw new Error('CDC consumer drain failed')
			}) as ShutdownDeps['stopApp'],
		})
		const shutdown = createShutdownHandler(deps)
		await expect(shutdown('SIGTERM')).rejects.toThrow('test-exit-marker')
		// Driver still closed + clean exit despite stopApp failure.
		expect(deps.callOrder).toContain('server.close')
		expect(deps.callOrder).toContain('closeDriver')
		expect(deps.callOrder).toContain('exit(0)')
		expect(deps.callOrder).not.toContain('stopApp')
		const stopAppErr = loggedErrors.find((e) => /stopApp failed/.test(e.msg ?? ''))
		expect((stopAppErr?.obj.err as Error).message).toBe('CDC consumer drain failed')
	})

	test('logs signal label + drainDelayMs on entry (operator audit)', async () => {
		const loggedInfo: LoggedEntry[] = []
		const deps = makeDeps({
			logger: {
				info: (obj, msg) => loggedInfo.push({ obj, msg }),
				error: () => undefined,
			},
		})
		const shutdown = createShutdownHandler(deps)
		await expect(shutdown('SIGTERM')).rejects.toThrow('test-exit-marker')
		expect(loggedInfo[0]?.obj.signal).toBe('SIGTERM')
		expect(loggedInfo[0]?.obj.drainDelayMs).toBe(4000)
		expect(loggedInfo[0]?.msg).toMatch(/Shutting down/)
	})
})
