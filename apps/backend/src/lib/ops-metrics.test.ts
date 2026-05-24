/**
 * Strict unit tests для OpsMetricsBuffer + emitPassportScanMetric.
 *
 * Test matrix:
 *   [B1] push 1 event → size=1, drain returns event
 *   [B2] push at capacity → drop oldest + droppedCount increments
 *   [B3] drain partial с limit → returns slice, buffer retains rest
 *   [B4] drain больше чем size → returns всё доступное
 *   [B5] labels frozen — caller mutation после push не affects buffer
 *   [B6] capacity 0 / negative throws RangeError
 *   [B7] custom now() seam stamps ts deterministically
 *   [P1] emitPassportScanMetric base shape — name + labels + value
 *   [P2] emitPassportScanMetric rklStatus optional — omitted когда undefined
 *   [P3] emitPassportScanMetric labels low-cardinality — outcome/identityMethod/apiModel only
 */
import { describe, expect, test } from 'bun:test'
import {
	emitPassportScanMetric,
	OpsMetricsBuffer,
	opsMetricsBuffer,
	passportScanCostKopecks,
} from './ops-metrics.ts'

describe('OpsMetricsBuffer — ring semantics', () => {
	test('[B1] push 1 event → size=1, drain returns event', () => {
		const buf = new OpsMetricsBuffer({ capacity: 10, now: () => 1_000_000 })
		buf.push({ name: 'test.counter', labels: { outcome: 'success' }, value: 1 })
		expect(buf.size).toBe(1)
		const drained = buf.drain()
		expect(drained.length).toBe(1)
		expect(drained[0]?.name).toBe('test.counter')
		expect(drained[0]?.value).toBe(1)
		expect(drained[0]?.ts).toBe(1_000_000)
		expect(buf.size).toBe(0) // drained
	})

	test('[B2] push at capacity → drop oldest + droppedCount increments', () => {
		const buf = new OpsMetricsBuffer({ capacity: 2, now: () => 0 })
		buf.push({ name: 'a', labels: {}, value: 1 })
		buf.push({ name: 'b', labels: {}, value: 2 })
		buf.push({ name: 'c', labels: {}, value: 3 }) // drops 'a'
		expect(buf.size).toBe(2)
		expect(buf.droppedCount).toBe(1)
		const drained = buf.drain()
		expect(drained.map((e) => e.name)).toEqual(['b', 'c'])
	})

	test('[B3] drain partial с limit → returns slice, buffer retains rest', () => {
		const buf = new OpsMetricsBuffer({ capacity: 10, now: () => 0 })
		buf.push({ name: 'a', labels: {}, value: 1 })
		buf.push({ name: 'b', labels: {}, value: 2 })
		buf.push({ name: 'c', labels: {}, value: 3 })
		const drained = buf.drain(2)
		expect(drained.map((e) => e.name)).toEqual(['a', 'b'])
		expect(buf.size).toBe(1)
		expect(buf.peek()?.name).toBe('c')
	})

	test('[B4] drain больше чем size → returns всё доступное', () => {
		const buf = new OpsMetricsBuffer({ capacity: 10, now: () => 0 })
		buf.push({ name: 'a', labels: {}, value: 1 })
		const drained = buf.drain(100)
		expect(drained.length).toBe(1)
	})

	test('[B5] labels frozen — caller mutation после push не affects buffer', () => {
		const buf = new OpsMetricsBuffer({ capacity: 10, now: () => 0 })
		const mutableLabels = { outcome: 'success' }
		buf.push({ name: 'test', labels: mutableLabels, value: 1 })
		mutableLabels.outcome = 'mutated' // adversarial post-push mutation
		const drained = buf.drain()
		expect(drained[0]?.labels.outcome).toBe('success')
	})

	test('[B6] capacity 0 / negative throws RangeError', () => {
		expect(() => new OpsMetricsBuffer({ capacity: 0 })).toThrow(RangeError)
		expect(() => new OpsMetricsBuffer({ capacity: -1 })).toThrow(RangeError)
		expect(() => new OpsMetricsBuffer({ capacity: 1.5 })).toThrow(RangeError)
	})

	test('[B7] custom now() seam stamps ts deterministically', () => {
		let tick = 100
		const now = () => {
			tick += 50
			return tick
		}
		const buf = new OpsMetricsBuffer({ capacity: 10, now })
		buf.push({ name: 'a', labels: {}, value: 1 })
		buf.push({ name: 'b', labels: {}, value: 2 })
		const drained = buf.drain()
		expect(drained[0]?.ts).toBe(150)
		expect(drained[1]?.ts).toBe(200)
	})
})

describe('emitPassportScanMetric — convenience helper', () => {
	test('[P1] base shape — name + labels + value', () => {
		opsMetricsBuffer.drain() // clear singleton buffer for isolation
		emitPassportScanMetric({
			kind: 'attempts',
			outcome: 'success',
			identityMethod: 'passport_paper',
			apiModel: 'passport',
			value: 1,
		})
		const drained = opsMetricsBuffer.drain()
		expect(drained.length).toBe(1)
		expect(drained[0]?.name).toBe('passport_scan.attempts')
		expect(drained[0]?.labels.outcome).toBe('success')
		expect(drained[0]?.labels.identityMethod).toBe('passport_paper')
		expect(drained[0]?.labels.apiModel).toBe('passport')
		expect(drained[0]?.value).toBe(1)
	})

	test('[P2] rklStatus optional — omitted когда undefined', () => {
		opsMetricsBuffer.drain()
		emitPassportScanMetric({
			kind: 'attempts',
			outcome: 'success',
			identityMethod: 'passport_paper',
			apiModel: 'passport',
			value: 1,
		})
		const drained = opsMetricsBuffer.drain()
		expect('rklStatus' in (drained[0]?.labels ?? {})).toBe(false)
	})

	test('[P3] labels low-cardinality — outcome/identityMethod/apiModel only', () => {
		opsMetricsBuffer.drain()
		emitPassportScanMetric({
			kind: 'duration_ms',
			outcome: 'success',
			identityMethod: 'passport_zagran',
			apiModel: 'page',
			rklStatus: 'clean',
			value: 2150,
		})
		const drained = opsMetricsBuffer.drain()
		const labelKeys = Object.keys(drained[0]?.labels ?? {}).sort()
		expect(labelKeys).toEqual(['apiModel', 'identityMethod', 'outcome', 'rklStatus'])
		// CRITICAL: tenantId / guestId / imageHash MUST NOT appear (high cardinality + PII)
		expect(labelKeys.includes('tenantId')).toBe(false)
		expect(labelKeys.includes('guestId')).toBe(false)
	})

	test('[P4] all 4 kinds produce canonical names', () => {
		opsMetricsBuffer.drain()
		emitPassportScanMetric({
			kind: 'attempts',
			outcome: 'success',
			identityMethod: 'passport_paper',
			apiModel: 'passport',
			value: 1,
		})
		emitPassportScanMetric({
			kind: 'duration_ms',
			outcome: 'success',
			identityMethod: 'passport_paper',
			apiModel: 'passport',
			value: 2000,
		})
		emitPassportScanMetric({
			kind: 'cost_kopecks',
			outcome: 'success',
			identityMethod: 'passport_paper',
			apiModel: 'passport',
			value: 71, // 0.71 ₽ = 71 копеек
		})
		emitPassportScanMetric({
			kind: 'orphan_compensation_failed',
			outcome: 'api_error',
			identityMethod: 'passport_paper',
			apiModel: 'passport',
			value: 1,
		})
		const drained = opsMetricsBuffer.drain()
		expect(drained.map((e) => e.name)).toEqual([
			'passport_scan.attempts',
			'passport_scan.duration_ms',
			'passport_scan.cost_kopecks',
			'passport_scan.orphan_compensation_failed',
		])
	})

	test('[P5] passportScanCostKopecks — model-aware lookup canonical (2026-Q2 pricing)', () => {
		// Yandex Vision pricing per aistudio.yandex.ru/docs/ru/vision/pricing.html:
		//   Template docs (passport, driver-license-*): 0.71 ₽ = 71 копеек
		//   Text models (page, page-column-sort): 0.1321 ₽ ≈ 13 копеек
		// Sprint C+ Round 5 verification 2026-05-24: page corrected от 71 (Round 4 flat
		// assumption — overstated 5.4×) к 13 копеек per YC infra expert audit.
		expect(passportScanCostKopecks('passport')).toBe(71)
		expect(passportScanCostKopecks('page')).toBe(13)
		expect(passportScanCostKopecks('driver-license-front')).toBe(71)
		expect(passportScanCostKopecks('driver-license-back')).toBe(71)
	})

	test('[P6] passportScanCostKopecks — unknown model returns null (defensive)', () => {
		// Self-review P1.4: future Yandex models добавятся → null vs wrong number.
		// Caller checks для null и skips metric emission rather than burning cost
		// budget на wrong assumption.
		expect(passportScanCostKopecks('text')).toBeNull()
		expect(passportScanCostKopecks('unknown-future-model')).toBeNull()
		expect(passportScanCostKopecks('')).toBeNull()
	})
})

describe('OpsMetricsBuffer — overflow handling', () => {
	test('[O1] resetDroppedCount — counter clears for next monitoring cycle', () => {
		const buf = new OpsMetricsBuffer({ capacity: 2, now: () => 0 })
		buf.push({ name: 'a', labels: {}, value: 1 })
		buf.push({ name: 'b', labels: {}, value: 2 })
		buf.push({ name: 'c', labels: {}, value: 3 }) // drops 'a'
		expect(buf.droppedCount).toBe(1)
		buf.resetDroppedCount()
		expect(buf.droppedCount).toBe(0)
		// After reset, new drops re-accumulate from 0
		buf.push({ name: 'd', labels: {}, value: 4 }) // drops 'b'
		expect(buf.droppedCount).toBe(1)
	})
})
