/**
 * Strict tests for the resilience policies. Per `feedback_strict_tests.md`:
 *
 *   - exact-value asserts (call counts, error types, error messages);
 *   - adversarial paths (timeout race, retry abort, circuit half-open probe);
 *   - immutable-field checks via test seams (deterministic clock + jitter +
 *     setTimeout) instead of vi.useFakeTimers (which interacts badly with
 *     `Promise.race` against real timeouts).
 */
import { describe, expect, it, vi } from 'vitest'
import {
	CircuitOpenError,
	circuitBreakerPolicy,
	composePolicies,
	type Policy,
	retryPolicy,
	TimeoutError,
	timeoutPolicy,
} from './index.ts'

// ---------------------------------------------------------------------------
// timeoutPolicy
// ---------------------------------------------------------------------------

describe('timeoutPolicy', () => {
	it('returns the result if the operation resolves in time', async () => {
		const policy = timeoutPolicy(50)
		const result = await policy.execute(async () => 'ok')
		expect(result).toBe('ok')
	})

	it('throws TimeoutError when operation exceeds timeout', async () => {
		const policy = timeoutPolicy(20)
		const start = Date.now()
		await expect(
			policy.execute(() => new Promise((resolve) => setTimeout(() => resolve('late'), 200))),
		).rejects.toBeInstanceOf(TimeoutError)
		const elapsed = Date.now() - start
		// Should fire well before the 200ms slow op completes
		expect(elapsed).toBeLessThan(150)
	})

	it('TimeoutError carries the configured timeoutMs', async () => {
		const policy = timeoutPolicy(33)
		try {
			await policy.execute(() => new Promise((r) => setTimeout(r, 200)))
			expect.fail('should have thrown')
		} catch (err) {
			expect(err).toBeInstanceOf(TimeoutError)
			expect((err as TimeoutError).timeoutMs).toBe(33)
			expect((err as TimeoutError).message).toBe('Operation timed out after 33ms')
		}
	})

	it('propagates the original error if op rejects before timeout', async () => {
		const policy = timeoutPolicy(50)
		await expect(policy.execute(async () => Promise.reject(new Error('boom')))).rejects.toThrow(
			'boom',
		)
	})

	it('rejects construction with non-positive timeoutMs', () => {
		expect(() => timeoutPolicy(0)).toThrowError(/must be > 0/)
		expect(() => timeoutPolicy(-1)).toThrowError(/must be > 0/)
		expect(() => timeoutPolicy(Number.NaN)).toThrowError(/must be > 0/)
	})
})

// ---------------------------------------------------------------------------
// retryPolicy
// ---------------------------------------------------------------------------

describe('retryPolicy', () => {
	it('returns success on first try without delay', async () => {
		const op = vi.fn(async () => 'ok')
		const delay = vi.fn(async () => undefined)
		const policy = retryPolicy({ attempts: 3, baseMs: 100, maxMs: 1000, delay })
		const result = await policy.execute(op)
		expect(result).toBe('ok')
		expect(op).toHaveBeenCalledTimes(1)
		expect(delay).not.toHaveBeenCalled()
	})

	it('retries up to `attempts` times then propagates last error', async () => {
		let calls = 0
		const op = vi.fn(async () => {
			calls += 1
			throw new Error(`fail-${calls}`)
		})
		const delay = vi.fn(async () => undefined)
		const policy = retryPolicy({
			attempts: 3,
			baseMs: 100,
			maxMs: 1000,
			delay,
			random: () => 0.5,
		})
		await expect(policy.execute(op)).rejects.toThrow('fail-3')
		expect(op).toHaveBeenCalledTimes(3)
		// Delays between attempts: between 1↔2 and 2↔3 = 2 delays, NOT 3
		expect(delay).toHaveBeenCalledTimes(2)
	})

	it('eventually succeeds — final attempt returns', async () => {
		let calls = 0
		const op = vi.fn(async () => {
			calls += 1
			if (calls < 3) throw new Error(`tmp-${calls}`)
			return 'recovered'
		})
		const policy = retryPolicy({
			attempts: 5,
			baseMs: 1,
			maxMs: 10,
			delay: async () => undefined,
			random: () => 0.5,
		})
		const result = await policy.execute(op)
		expect(result).toBe('recovered')
		expect(op).toHaveBeenCalledTimes(3)
	})

	it('exponential delays follow baseMs * 2^attempt with jitter ∈ [raw/2, raw)', async () => {
		const delays: number[] = []
		const policy = retryPolicy({
			attempts: 4,
			baseMs: 100,
			maxMs: 10_000,
			random: () => 0.5, // jitter centered → wait = raw/2 + 0.5 * raw/2 = raw * 0.75
			delay: async (ms) => {
				delays.push(ms)
			},
		})
		await expect(
			policy.execute(async () => {
				throw new Error('persistent')
			}),
		).rejects.toThrow('persistent')
		// raw[0]=100, raw[1]=200, raw[2]=400 — last attempt has no follow-up delay
		// wait = raw * 0.75 with our deterministic random=0.5
		expect(delays).toEqual([75, 150, 300])
	})

	it('respects maxMs cap on raw delay', async () => {
		const delays: number[] = []
		const policy = retryPolicy({
			attempts: 5,
			baseMs: 100,
			maxMs: 250,
			random: () => 0,
			delay: async (ms) => {
				delays.push(ms)
			},
		})
		await expect(
			policy.execute(async () => {
				throw new Error('x')
			}),
		).rejects.toThrow()
		// raw progression: 100, 200, 400→250, 800→250. wait = raw * 0.5 (random=0 → jitter=0).
		expect(delays).toEqual([50, 100, 125, 125])
	})

	it('shouldRetry=false aborts retries early (no delay) and propagates immediately', async () => {
		const op = vi.fn(async () => {
			throw new Error('400 bad request')
		})
		const delay = vi.fn(async () => undefined)
		const policy = retryPolicy({
			attempts: 5,
			baseMs: 100,
			maxMs: 1000,
			delay,
			shouldRetry: (err) => !String((err as Error).message).startsWith('400'),
		})
		await expect(policy.execute(op)).rejects.toThrow('400 bad request')
		expect(op).toHaveBeenCalledTimes(1)
		expect(delay).not.toHaveBeenCalled()
	})

	it('shouldRetry receives the actual error and 1-indexed attempt number', async () => {
		const captured: Array<{ msg: string; n: number }> = []
		const op = vi.fn(async () => {
			throw new Error(`fail-${op.mock.calls.length + 1}`)
		})
		await expect(
			retryPolicy({
				attempts: 3,
				baseMs: 1,
				maxMs: 10,
				delay: async () => undefined,
				shouldRetry: (err, n) => {
					captured.push({ msg: (err as Error).message, n })
					return true
				},
			}).execute(op),
		).rejects.toThrow()
		// shouldRetry called for attempts 1 and 2 only (NOT for the final attempt 3)
		expect(captured).toEqual([
			{ msg: 'fail-2', n: 1 },
			{ msg: 'fail-3', n: 2 },
		])
	})

	it('rejects construction with attempts < 1', () => {
		expect(() => retryPolicy({ attempts: 0, baseMs: 1, maxMs: 1 })).toThrowError(/positive integer/)
		expect(() => retryPolicy({ attempts: -1, baseMs: 1, maxMs: 1 })).toThrow()
	})

	it('rejects construction with maxMs < baseMs', () => {
		expect(() => retryPolicy({ attempts: 3, baseMs: 100, maxMs: 50 })).toThrowError(
			/maxMs must be >= baseMs/,
		)
	})
})

// ---------------------------------------------------------------------------
// circuitBreakerPolicy
// ---------------------------------------------------------------------------

describe('circuitBreakerPolicy', () => {
	it('passes through while closed', async () => {
		const policy = circuitBreakerPolicy({ failureThreshold: 3, resetAfterMs: 1_000 })
		expect(await policy.execute(async () => 'ok')).toBe('ok')
	})

	it('opens after `failureThreshold` consecutive failures and rejects fast', async () => {
		const policy = circuitBreakerPolicy({ failureThreshold: 2, resetAfterMs: 1_000 })
		const failingOp = vi.fn(async () => {
			throw new Error('upstream-down')
		})
		// First 2 fail → trip
		await expect(policy.execute(failingOp)).rejects.toThrow('upstream-down')
		await expect(policy.execute(failingOp)).rejects.toThrow('upstream-down')
		// Third call short-circuits — operation NOT invoked
		await expect(policy.execute(failingOp)).rejects.toBeInstanceOf(CircuitOpenError)
		expect(failingOp).toHaveBeenCalledTimes(2)
	})

	it('counter resets to 0 on success between failures', async () => {
		const policy = circuitBreakerPolicy({ failureThreshold: 3, resetAfterMs: 1_000 })
		const op = vi.fn(async () => {
			const n = op.mock.calls.length
			// Fail, fail, succeed, fail, fail — never reaches threshold of 3 consecutive
			if (n === 1 || n === 2 || n === 4 || n === 5) throw new Error('flaky')
			return 'ok'
		})
		await expect(policy.execute(op)).rejects.toThrow()
		await expect(policy.execute(op)).rejects.toThrow()
		expect(await policy.execute(op)).toBe('ok')
		await expect(policy.execute(op)).rejects.toThrow()
		await expect(policy.execute(op)).rejects.toThrow()
		// Circuit is still closed — counter reset on the success
		expect(op).toHaveBeenCalledTimes(5)
	})

	it('half-open probe: success → closes circuit', async () => {
		let now = 1_000_000
		const policy = circuitBreakerPolicy({
			failureThreshold: 1,
			resetAfterMs: 500,
			now: () => now,
		})
		await expect(
			policy.execute(async () => {
				throw new Error('boom')
			}),
		).rejects.toThrow('boom')
		// Within cooldown — open
		now += 100
		await expect(policy.execute(async () => 'should-not-reach')).rejects.toBeInstanceOf(
			CircuitOpenError,
		)
		// After cooldown — half-open, probe succeeds → closed
		now += 500
		expect(await policy.execute(async () => 'recovered')).toBe('recovered')
		// Closed again — subsequent calls flow through
		expect(await policy.execute(async () => 'next')).toBe('next')
	})

	it('half-open probe: failure → re-opens with full cooldown', async () => {
		let now = 1_000_000
		const policy = circuitBreakerPolicy({
			failureThreshold: 1,
			resetAfterMs: 500,
			now: () => now,
		})
		await expect(
			policy.execute(async () => {
				throw new Error('first-fail')
			}),
		).rejects.toThrow('first-fail')
		now += 600 // cooldown elapsed
		await expect(
			policy.execute(async () => {
				throw new Error('probe-fail')
			}),
		).rejects.toThrow('probe-fail')
		// Should be open again — no probe allowed for next 500ms
		now += 100
		await expect(policy.execute(async () => 'unreached')).rejects.toBeInstanceOf(CircuitOpenError)
		// New cooldown elapses → probe again
		now += 500
		expect(await policy.execute(async () => 'finally')).toBe('finally')
	})

	it('CircuitOpenError carries the resetAt timestamp', async () => {
		let now = 5_000
		const policy = circuitBreakerPolicy({
			failureThreshold: 1,
			resetAfterMs: 1_000,
			now: () => now,
		})
		await expect(
			policy.execute(async () => {
				throw new Error('x')
			}),
		).rejects.toThrow()
		now += 100
		try {
			await policy.execute(async () => 'unreached')
			expect.fail()
		} catch (err) {
			expect(err).toBeInstanceOf(CircuitOpenError)
			// openedAt was 5000, resetAfterMs 1000 → resetAt = 6000
			expect((err as CircuitOpenError).resetAt.getTime()).toBe(6_000)
		}
	})

	it('rejects construction with invalid options', () => {
		expect(() => circuitBreakerPolicy({ failureThreshold: 0, resetAfterMs: 1 })).toThrowError(
			/positive integer/,
		)
		expect(() => circuitBreakerPolicy({ failureThreshold: 1, resetAfterMs: -1 })).toThrowError(
			/resetAfterMs must be >= 0/,
		)
	})
})

// ---------------------------------------------------------------------------
// composePolicies
// ---------------------------------------------------------------------------

describe('composePolicies', () => {
	it('returns a no-op policy when no inputs', async () => {
		const policy = composePolicies()
		expect(await policy.execute(async () => 42)).toBe(42)
	})

	it('passes through a single policy', async () => {
		const policy = composePolicies(timeoutPolicy(50))
		expect(await policy.execute(async () => 'ok')).toBe('ok')
	})

	it('order: outer wraps inner — circuit + retry + timeout', async () => {
		// Construct: circuit (1 fail trips) → retry (3 attempts) → timeout (50ms)
		// Inner fn always throws fast (so timeout never fires).
		// Expectation: retry will run 3 attempts, all fail, propagating;
		// circuit sees those 3 failures as ONE composed call → counter=1 → trip on next.
		const op = vi.fn(async () => {
			throw new Error('upstream')
		})
		const policy = composePolicies(
			circuitBreakerPolicy({ failureThreshold: 1, resetAfterMs: 1_000 }),
			retryPolicy({
				attempts: 3,
				baseMs: 1,
				maxMs: 10,
				delay: async () => undefined,
				random: () => 0.5,
			}),
			timeoutPolicy(50),
		)
		await expect(policy.execute(op)).rejects.toThrow('upstream')
		expect(op).toHaveBeenCalledTimes(3) // retry consumed inside the circuit
		// Next call → circuit is now open (1 composed failure tripped it)
		await expect(policy.execute(op)).rejects.toBeInstanceOf(CircuitOpenError)
		expect(op).toHaveBeenCalledTimes(3) // not called again
	})

	it('records the result of inner-most policy on success', async () => {
		let executed = false
		const policy = composePolicies(
			retryPolicy({ attempts: 2, baseMs: 1, maxMs: 10, delay: async () => undefined }),
			timeoutPolicy(100),
		)
		const result = await policy.execute(async () => {
			executed = true
			return 'final-value'
		})
		expect(result).toBe('final-value')
		expect(executed).toBe(true)
	})

	it('passes the same Policy contract regardless of nesting', async () => {
		// The composed policy must be a regular Policy instance — assertable by type.
		const composed: Policy = composePolicies(timeoutPolicy(50))
		expect(typeof composed.execute).toBe('function')
	})
})
