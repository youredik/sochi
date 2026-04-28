import { typeid } from 'typeid-js'

/**
 * TypeID prefixes for all entity types in the system.
 * Keep alphabetized. Max 63 chars, lowercase ASCII.
 */
export const ID_PREFIXES = {
	user: 'usr',
	session: 'ses',
	account: 'acc',
	verification: 'vrf',
	organization: 'org',
	member: 'mbr',
	invitation: 'inv',
	property: 'prop',
	roomType: 'rmt',
	room: 'room',
	ratePlan: 'rp',
	booking: 'book',
	guest: 'gst',
	activity: 'act',
	job: 'job',
	webhook: 'wh',
	migrationReport: 'mvd',
	consent: 'cns',
	// Payment domain (M6, 2026-04-25 — see project_payment_domain_canonical.md)
	folio: 'fol',
	folioLine: 'fln',
	payment: 'pay',
	refund: 'ref',
	receipt: 'rcp',
	dispute: 'dsp',
	routingRule: 'rrl',
	paymentWebhookEvent: 'pwe',
	// Notification outbox (M6.5B, 2026-04-25)
	notification: 'ntf',
	// M8.A.0 — property content authoring (media + addons).
	media: 'med',
	addon: 'addn',
	// M8.A — ЕПГУ + AI passport + RKL (миграционный учёт МВД).
	guestDocument: 'gdoc',
	migrationRegistration: 'mreg',
	rklHistory: 'rkl',
	passportOcrAudit: 'ocra',
	// M9.5 Phase D — Better Auth passkey plugin (WebAuthn).
	passkey: 'pk',
} as const

export type EntityKind = keyof typeof ID_PREFIXES
type TypedId<K extends EntityKind> = `${(typeof ID_PREFIXES)[K]}_${string}`

/**
 * Generate a new typed ID for an entity kind.
 * Returns a string in the form `{prefix}_{26-char base32}`.
 */
export function newId<K extends EntityKind>(kind: K): TypedId<K> {
	return typeid(ID_PREFIXES[kind]).toString() as TypedId<K>
}
