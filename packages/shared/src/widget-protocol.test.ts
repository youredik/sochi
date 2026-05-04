/**
 * `validateWidgetMessage` strict adversarial tests — V1-V18 (M9.widget.6 / А4.4).
 *
 * Drift defense canon: identical message shape required в both
 * `apps/widget-embed/src/iframe-fallback.ts` (parent side) and
 * `apps/frontend/src/lib/widget-iframe-bridge.ts` (child side, future M9.widget.6 closure).
 * If protocol shape diverges, this validator's contract guards.
 *
 * Per `feedback_strict_tests.md`:
 *   - exact-value asserts on each enum member
 *   - adversarial negative paths (forge / replay / oversize / wrong-type)
 *   - rejection returns null (NEVER throws on attacker-controllable input)
 */

import { describe, expect, it } from 'vitest'
import {
	validateWidgetMessage,
	WIDGET_PROTOCOL_NS,
	WIDGET_PROTOCOL_VERSION,
	WIDGET_RESIZE_HEIGHT_MAX,
	type WidgetMessage,
} from './widget-protocol.ts'

const validBase = {
	ns: WIDGET_PROTOCOL_NS,
	v: WIDGET_PROTOCOL_VERSION,
	nonce: 'a'.repeat(32),
	seq: 1,
}

describe('validateWidgetMessage — happy paths (each type)', () => {
	it('[V1] ready', () => {
		const out = validateWidgetMessage({ ...validBase, type: 'ready' })
		expect(out).not.toBeNull()
		expect((out as WidgetMessage).type).toBe('ready')
	})

	it('[V2] init с parentOrigin', () => {
		const out = validateWidgetMessage({
			...validBase,
			type: 'init',
			parentOrigin: 'https://hotel.ru',
		})
		expect(out).not.toBeNull()
	})

	it('[V3] resize с positive height ≤ MAX', () => {
		const out = validateWidgetMessage({ ...validBase, type: 'resize', height: 800 })
		expect(out).not.toBeNull()
	})

	it('[V4] navigate с https URL', () => {
		const out = validateWidgetMessage({
			...validBase,
			type: 'navigate',
			href: 'https://booking.sochi.app/portal',
		})
		expect(out).not.toBeNull()
	})

	it('[V5] booking-complete с bookingRef', () => {
		const out = validateWidgetMessage({
			...validBase,
			type: 'booking-complete',
			bookingRef: 'BK-12345',
		})
		expect(out).not.toBeNull()
	})

	it('[V6] error с code+message', () => {
		const out = validateWidgetMessage({
			...validBase,
			type: 'error',
			code: 'NETWORK',
			message: 'Connection lost',
		})
		expect(out).not.toBeNull()
	})
})

describe('validateWidgetMessage — adversarial rejections', () => {
	it('[V7] reject null', () => {
		expect(validateWidgetMessage(null)).toBeNull()
	})

	it('[V8] reject non-object (string)', () => {
		expect(validateWidgetMessage('attacker-payload')).toBeNull()
	})

	it('[V9] reject wrong ns (cross-channel namespace collision)', () => {
		expect(validateWidgetMessage({ ...validBase, ns: 'workos-widget', type: 'ready' })).toBeNull()
	})

	it('[V10] reject wrong protocol version (forward-incompat)', () => {
		expect(validateWidgetMessage({ ...validBase, v: 2, type: 'ready' })).toBeNull()
	})

	it('[V11] reject empty nonce', () => {
		expect(validateWidgetMessage({ ...validBase, nonce: '', type: 'ready' })).toBeNull()
	})

	it('[V12] reject overlong nonce (>64 chars; defends DoS на validator state)', () => {
		expect(validateWidgetMessage({ ...validBase, nonce: 'a'.repeat(65), type: 'ready' })).toBeNull()
	})

	it('[V13] reject negative seq (replay defense canon)', () => {
		expect(validateWidgetMessage({ ...validBase, seq: -1, type: 'ready' })).toBeNull()
	})

	it('[V14] reject non-integer seq (1.5 → reject)', () => {
		expect(validateWidgetMessage({ ...validBase, seq: 1.5, type: 'ready' })).toBeNull()
	})

	it('[V15] reject resize height > MAX (D33 4096 cap)', () => {
		expect(
			validateWidgetMessage({ ...validBase, type: 'resize', height: WIDGET_RESIZE_HEIGHT_MAX + 1 }),
		).toBeNull()
	})

	it('[V16] reject resize height negative', () => {
		expect(validateWidgetMessage({ ...validBase, type: 'resize', height: -10 })).toBeNull()
	})

	it('[V17] reject navigate с http:// (canonical https-only)', () => {
		expect(
			validateWidgetMessage({ ...validBase, type: 'navigate', href: 'http://insecure.ru' }),
		).toBeNull()
	})

	it('[V18] reject navigate с javascript: scheme (XSS canon)', () => {
		expect(
			validateWidgetMessage({
				...validBase,
				type: 'navigate',
				href: 'javascript:alert(1)',
			}),
		).toBeNull()
	})

	it('[V19] reject unknown type (forward-compat tightening)', () => {
		expect(validateWidgetMessage({ ...validBase, type: 'unknown-type' })).toBeNull()
	})

	it('[V20] reject booking-complete с empty bookingRef', () => {
		expect(
			validateWidgetMessage({ ...validBase, type: 'booking-complete', bookingRef: '' }),
		).toBeNull()
	})

	it('[V21] reject init без parentOrigin', () => {
		expect(validateWidgetMessage({ ...validBase, type: 'init' })).toBeNull()
	})

	it('[V22] reject error без code', () => {
		expect(validateWidgetMessage({ ...validBase, type: 'error', message: 'incomplete' })).toBeNull()
	})
})
