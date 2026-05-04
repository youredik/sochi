/**
 * CloudEvents 1.0.2 envelope helpers — M10 / A7.1 / D11.
 *
 * Per `plans/m10_canonical.md` §2:
 *   - D11: Inbound webhook envelope = CloudEvents 1.0.2 (universal idempotency
 *          tuple `(source, id)`). Pin `cloudevents@10.0.0`.
 *   - D25.b: CE 1.0.2 has NO signature extension (issue #703 still open Apr 2026).
 *          Sign opaque envelope bytes via Standard Webhooks scheme separately.
 *
 * Used by: inbox.ts (UNIQUE(source, eventId) idempotent receive), channel-manager
 * adapters when emitting events upstream.
 *
 * Canonical envelope shape (CE 1.0.2 spec §3.1):
 *   - REQUIRED: id, source, type, specversion='1.0'
 *   - OPTIONAL: subject, time, datacontenttype, dataschema, data
 *   - EXTENSIONS: any additional attribute prefixed (no formal naming spec)
 *
 * @see https://github.com/cloudevents/spec/blob/v1.0.2/cloudevents/spec.md
 */

import { CloudEvent } from 'cloudevents'

/**
 * Required + commonly-used CE envelope fields для нашего use case.
 * Strict TS shape ensures all inbound webhooks carry these fields.
 *
 * Field semantics:
 *   - `id`: globally unique per (source, type) tuple. UUID v4 canonical.
 *   - `source`: URI identifying event-origin context. Format
 *     `urn:sochi:channel:{channelCode}:tenant:{organizationId}` per
 *     project event-architecture canon.
 *   - `type`: reverse-DNS event type, e.g. `app.sochi.channel.booking.created.v1`.
 *   - `subject`: optional — for booking events, set к bookingId.
 *   - `time`: RFC 3339 ISO timestamp UTC.
 *   - `datacontenttype`: 'application/json' canonical.
 */
export interface SochiCloudEvent<TData = unknown> {
	readonly id: string
	readonly source: string
	readonly type: string
	readonly specversion: '1.0'
	readonly subject?: string
	readonly time?: string
	readonly datacontenttype?: string
	readonly data?: TData
}

/**
 * Build canonical CloudEvent envelope. Fills in `specversion='1.0'` automatically.
 * `time` defaults to current UTC if not provided.
 *
 * @throws if required fields missing or malformed.
 */
export function buildCloudEvent<TData>(input: {
	id: string
	source: string
	type: string
	subject?: string
	time?: string | Date
	datacontenttype?: string
	data?: TData
}): SochiCloudEvent<TData> {
	if (input.id.length === 0) throw new Error('CloudEvent: id required')
	if (input.source.length === 0) throw new Error('CloudEvent: source required')
	if (input.type.length === 0) throw new Error('CloudEvent: type required')

	const time =
		input.time === undefined
			? new Date().toISOString()
			: input.time instanceof Date
				? input.time.toISOString()
				: input.time

	const out: SochiCloudEvent<TData> = {
		id: input.id,
		source: input.source,
		type: input.type,
		specversion: '1.0',
		...(input.subject !== undefined ? { subject: input.subject } : {}),
		time,
		datacontenttype: input.datacontenttype ?? 'application/json',
		...(input.data !== undefined ? { data: input.data } : {}),
	}
	return out
}

/**
 * Idempotency tuple `(source, id)` — canonical universal dedup key per CE 1.0.2.
 * Used by inbox table UNIQUE constraint + cache lookup.
 */
export function idempotencyTuple(event: Pick<SochiCloudEvent, 'source' | 'id'>): {
	readonly source: string
	readonly id: string
} {
	return { source: event.source, id: event.id }
}

/**
 * Validate inbound envelope structurally. Returns parsed event OR null on
 * malformed input. Defensive against attacker-supplied payloads.
 *
 * Canonical 2026 envelope MUST have:
 *   - specversion === '1.0' (we reject 0.x and any future 2.x — explicit version pin)
 *   - id (non-empty string)
 *   - source (non-empty string, MAY be validated as URI form)
 *   - type (non-empty string, reverse-DNS canonical)
 *
 * Returns null for any validation failure — never throws (caller decides
 * 4xx response shape).
 */
export function parseCloudEvent(raw: unknown): SochiCloudEvent | null {
	if (raw === null || typeof raw !== 'object') return null
	const obj = raw as Record<string, unknown>
	if (obj.specversion !== '1.0') return null
	if (typeof obj.id !== 'string' || obj.id.length === 0) return null
	if (typeof obj.source !== 'string' || obj.source.length === 0) return null
	if (typeof obj.type !== 'string' || obj.type.length === 0) return null

	const writableResult: Record<string, unknown> = {
		id: obj.id,
		source: obj.source,
		type: obj.type,
		specversion: '1.0',
	}
	if (typeof obj.subject === 'string') writableResult.subject = obj.subject
	if (typeof obj.time === 'string') writableResult.time = obj.time
	if (typeof obj.datacontenttype === 'string') {
		writableResult.datacontenttype = obj.datacontenttype
	}
	if ('data' in obj) writableResult.data = obj.data
	return writableResult as unknown as SochiCloudEvent
}

/**
 * Canonical source URN format для нашей системы.
 * Format: `urn:sochi:channel:{channelCode}:tenant:{organizationId}`.
 *
 * Per project event-architecture canon. Channels emit с собственным channelCode
 * ('TL' / 'YT' / 'ETG'), tenant identifier matches organization.id.
 */
export function buildSourceUrn(input: { channelCode: string; organizationId: string }): string {
	return `urn:sochi:channel:${input.channelCode}:tenant:${input.organizationId}`
}

/**
 * Canonical type URN format для events emitted by our channel domain.
 * Format: `app.sochi.channel.{entity}.{action}.{version}`.
 * Example: `app.sochi.channel.booking.created.v1`.
 */
export function buildEventType(input: {
	entity: string
	action: string
	version?: string
}): string {
	const version = input.version ?? 'v1'
	return `app.sochi.channel.${input.entity}.${input.action}.${version}`
}

// `cloudevents` package import retained для type compatibility + future
// callers needing full SDK features (HTTP/Kafka bindings, extension attribute
// API). Our internal idempotency uses the slim `SochiCloudEvent` shape above.
// If a future adapter needs the SDK class, import directly: `import { CloudEvent } from 'cloudevents'`.
void CloudEvent
