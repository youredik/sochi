/**
 * CloudEvents 1.0.2 envelope helpers — strict tests CE1-CE6 (M10 / A7.1 / D11).
 *
 * Per plan §5: «6 CE tests (envelope shape / idempotency tuple / replay window /
 * malformed reject / extension attribute parsing / NO signature extension confirmed)».
 *
 * Strict-test canon: exact-value asserts, adversarial malformed inputs,
 * version-pinning enforcement.
 */

import { describe, expect, it } from 'bun:test'
import {
	buildCloudEvent,
	buildEventType,
	buildSourceUrn,
	idempotencyTuple,
	parseCloudEvent,
} from './cloud-events.ts'

describe('buildCloudEvent — canonical envelope shape', () => {
	it('[CE1] required fields baked in; specversion=1.0 forced', () => {
		const event = buildCloudEvent({
			id: '01HQR3BAS6DZNK4ZB1TY9D2J7M',
			source: 'urn:sochi:channel:TL:tenant:demo-sirius',
			type: 'app.sochi.channel.booking.created.v1',
			data: { bookingId: 'b-001' },
		})
		expect(event.id).toBe('01HQR3BAS6DZNK4ZB1TY9D2J7M')
		expect(event.source).toBe('urn:sochi:channel:TL:tenant:demo-sirius')
		expect(event.type).toBe('app.sochi.channel.booking.created.v1')
		expect(event.specversion).toBe('1.0')
		expect(event.datacontenttype).toBe('application/json')
		expect(event.data).toEqual({ bookingId: 'b-001' })
		expect(event.time).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/)
	})

	it('[CE1.b] empty id / source / type → throw', () => {
		expect(() => buildCloudEvent({ id: '', source: 's', type: 't' })).toThrow(/id required/)
		expect(() => buildCloudEvent({ id: 'i', source: '', type: 't' })).toThrow(/source required/)
		expect(() => buildCloudEvent({ id: 'i', source: 's', type: '' })).toThrow(/type required/)
	})
})

describe('idempotencyTuple — universal (source, id) dedup key', () => {
	it('[CE2] returns exact (source, id) tuple', () => {
		const event = buildCloudEvent({
			id: 'evt-123',
			source: 'urn:sochi:channel:TL:tenant:abc',
			type: 'app.sochi.channel.booking.created.v1',
		})
		expect(idempotencyTuple(event)).toEqual({
			source: 'urn:sochi:channel:TL:tenant:abc',
			id: 'evt-123',
		})
	})

	it('[CE2.b] picks ONLY source + id, ignores other fields', () => {
		const event = buildCloudEvent({
			id: 'evt-456',
			source: 'urn:test',
			type: 'app.test.x',
			subject: 'should-be-ignored',
			data: { secret: 'should-be-ignored' },
		})
		const tuple = idempotencyTuple(event)
		expect(Object.keys(tuple).sort()).toEqual(['id', 'source'])
		expect(tuple.id).toBe('evt-456')
		expect(tuple.source).toBe('urn:test')
	})
})

describe('parseCloudEvent — adversarial inbound validation', () => {
	it('[CE3] valid envelope → parsed event', () => {
		const raw = {
			specversion: '1.0',
			id: 'i',
			source: 's',
			type: 't',
			data: { ok: true },
		}
		const event = parseCloudEvent(raw)
		expect(event).not.toBeNull()
		expect(event?.id).toBe('i')
		expect(event?.data).toEqual({ ok: true })
	})

	it('[CE3.b] specversion=0.3 (legacy) → null (we pin 1.0 only)', () => {
		expect(parseCloudEvent({ specversion: '0.3', id: 'i', source: 's', type: 't' })).toBeNull()
	})

	it('[CE3.c] specversion=2.0 (hypothetical future) → null (explicit pin)', () => {
		expect(parseCloudEvent({ specversion: '2.0', id: 'i', source: 's', type: 't' })).toBeNull()
	})

	it('[CE3.d] missing required fields → null', () => {
		expect(parseCloudEvent({ specversion: '1.0' })).toBeNull()
		expect(parseCloudEvent({ specversion: '1.0', id: '' })).toBeNull()
		expect(parseCloudEvent({ specversion: '1.0', id: 'i', source: '' })).toBeNull()
		expect(parseCloudEvent({ specversion: '1.0', id: 'i', source: 's', type: '' })).toBeNull()
	})

	it('[CE3.e] non-object payload → null (defensive)', () => {
		expect(parseCloudEvent(null)).toBeNull()
		expect(parseCloudEvent('not-an-object')).toBeNull()
		expect(parseCloudEvent(42)).toBeNull()
		expect(parseCloudEvent([])).toBeNull()
	})
})

describe('buildSourceUrn / buildEventType — canonical naming', () => {
	it('[CE4] source URN format `urn:sochi:channel:{code}:tenant:{orgId}`', () => {
		expect(buildSourceUrn({ channelCode: 'TL', organizationId: 'demo-sirius' })).toBe(
			'urn:sochi:channel:TL:tenant:demo-sirius',
		)
		expect(buildSourceUrn({ channelCode: 'YT', organizationId: 'org_abc' })).toBe(
			'urn:sochi:channel:YT:tenant:org_abc',
		)
		expect(buildSourceUrn({ channelCode: 'ETG', organizationId: 'org_xyz' })).toBe(
			'urn:sochi:channel:ETG:tenant:org_xyz',
		)
	})

	it('[CE4.b] event type format `app.sochi.channel.{entity}.{action}.{version}`', () => {
		expect(buildEventType({ entity: 'booking', action: 'created' })).toBe(
			'app.sochi.channel.booking.created.v1',
		)
		expect(buildEventType({ entity: 'rate', action: 'updated', version: 'v2' })).toBe(
			'app.sochi.channel.rate.updated.v2',
		)
		expect(buildEventType({ entity: 'inventory', action: 'pushed' })).toBe(
			'app.sochi.channel.inventory.pushed.v1',
		)
	})
})

describe('CE 1.0.2 has NO signature extension (D25.b honest documentation)', () => {
	it('[CE5] envelope does NOT carry signature field — verified by parseCloudEvent ignoring it', () => {
		// This test documents the gap (CE issue #703 still open Apr 2026):
		// CE 1.0.2 spec defines NO standardized signature attribute. Any signature
		// MUST be transmitted via separate header (Standard Webhooks scheme), not
		// inside the envelope.
		const raw = {
			specversion: '1.0',
			id: 'i',
			source: 's',
			type: 't',
			signature: 'fake-sig-v1', // intentional — not a CE field
		}
		const event = parseCloudEvent(raw)
		expect(event).not.toBeNull()
		// Parsed event has NO `signature` field — only canonical CE attributes.
		expect((event as unknown as Record<string, unknown>).signature).toBeUndefined()
	})
})

describe('CE round-trip via JSON serialization', () => {
	it('[CE6] build → JSON.stringify → parse → equivalent shape', () => {
		const original = buildCloudEvent({
			id: 'evt-rt',
			source: 'urn:sochi:test',
			type: 'app.sochi.test.x',
			data: { foo: 'bar', cyrillic: 'тест', emoji: '🏨' },
		})
		const json = JSON.stringify(original)
		const parsed = parseCloudEvent(JSON.parse(json))
		expect(parsed).not.toBeNull()
		expect(parsed?.id).toBe(original.id)
		expect(parsed?.source).toBe(original.source)
		expect(parsed?.type).toBe(original.type)
		expect(parsed?.data).toEqual(original.data)
	})
})
