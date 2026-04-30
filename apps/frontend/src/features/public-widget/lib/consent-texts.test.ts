/**
 * Strict tests для frozen consent texts (legal traceability).
 *
 *   [CT1] CONSENT_VERSION matches v<major>.<minor> shape
 *   [CT2] DPA_CONSENT_TEXT cites 152-ФЗ AND ФЗ-109 AND ФЗ-54
 *   [CT3] DPA_CONSENT_TEXT mentions all required parties (МВД, ФНС, оператор оплаты)
 *   [CT4] DPA_CONSENT_TEXT lists revocation procedure
 *   [CT5] MARKETING_CONSENT_TEXT cites 38-ФЗ ст. 18
 *   [CT6] MARKETING_CONSENT_TEXT lists opt-out methods
 *   [CT7] MARKETING_CONSENT_TEXT distinguished from DPA (separate-doc canon)
 *   [CT8] DPA NOT bundle marketing scope (substantively independent)
 *   [CT9] Both texts under 10000 chars (backend max validation)
 */

import { describe, expect, test } from 'vitest'
import { CONSENT_VERSION, DPA_CONSENT_TEXT, MARKETING_CONSENT_TEXT } from './consent-texts.ts'

describe('consent-texts — frozen v1.0', () => {
	test('[CT1] CONSENT_VERSION matches v<major>.<minor> shape', () => {
		expect(CONSENT_VERSION).toMatch(/^v\d+\.\d+$/)
		expect(CONSENT_VERSION).toBe('v1.0')
	})

	test('[CT2] DPA cites 152-ФЗ + ФЗ-109 + ФЗ-54', () => {
		expect(DPA_CONSENT_TEXT).toContain('152-ФЗ')
		expect(DPA_CONSENT_TEXT).toContain('ФЗ-109')
		expect(DPA_CONSENT_TEXT).toContain('ФЗ-54')
	})

	test('[CT3] DPA mentions МВД, ФНС, оператор оплаты, оператор почты', () => {
		expect(DPA_CONSENT_TEXT).toContain('МВД')
		expect(DPA_CONSENT_TEXT).toContain('ФНС')
		expect(DPA_CONSENT_TEXT).toMatch(/оператор\s+платёжной\s+системы/i)
		expect(DPA_CONSENT_TEXT).toMatch(/оператор\s+почтового\s+сервиса/i)
	})

	test('[CT4] DPA lists revocation procedure', () => {
		expect(DPA_CONSENT_TEXT).toMatch(/отозва(но|ть)/i)
		expect(DPA_CONSENT_TEXT).toMatch(/письменного\s+заявления/i)
	})

	test('[CT5] Marketing cites 38-ФЗ ст. 18', () => {
		expect(MARKETING_CONSENT_TEXT).toContain('38-ФЗ')
		expect(MARKETING_CONSENT_TEXT).toContain('ст. 18')
	})

	test('[CT6] Marketing lists opt-out methods (Отписаться + STOP)', () => {
		expect(MARKETING_CONSENT_TEXT).toContain('Отписаться')
		expect(MARKETING_CONSENT_TEXT).toMatch(/STOP/i)
	})

	test('[CT7] Marketing text distinguished from DPA (separate-doc canon)', () => {
		expect(MARKETING_CONSENT_TEXT).not.toBe(DPA_CONSENT_TEXT)
		// Marketing must not include 152-ФЗ basis (independent purpose)
		expect(MARKETING_CONSENT_TEXT).not.toContain('152-ФЗ')
		// DPA must not include 38-ФЗ marketing scope
		expect(DPA_CONSENT_TEXT).not.toContain('38-ФЗ')
	})

	test('[CT8] DPA does NOT bundle marketing scope', () => {
		expect(DPA_CONSENT_TEXT).not.toMatch(/маркетинг/i)
		expect(DPA_CONSENT_TEXT).not.toMatch(/реклам/i)
	})

	test('[CT9] Both texts under 10000 chars (backend max validation)', () => {
		expect(DPA_CONSENT_TEXT.length).toBeLessThan(10_000)
		expect(MARKETING_CONSENT_TEXT.length).toBeLessThan(10_000)
		// Sanity: above some minimum (catches accidental empty)
		expect(DPA_CONSENT_TEXT.length).toBeGreaterThan(500)
		expect(MARKETING_CONSENT_TEXT.length).toBeGreaterThan(200)
	})
})
