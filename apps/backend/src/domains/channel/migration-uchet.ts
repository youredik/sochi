/**
 * МВД миграционный учёт canonical refusal — M10 / A7.5 / D20.
 *
 * Per `plans/m10_canonical.md` D20:
 *   "ALWAYS hotel-side, never via channel adapter — channel just supplies
 *    guest PII. Госпошлина 500 ₽ since 27 Jan 2026 (PP №44)."
 *
 * Channels (TL/YT/ETG) provide guest data to PMS, but PMS performs миграционный
 * учёт independently через ЕПГУ flow (M8.A.5 domain). This module documents +
 * enforces that boundary at the channel layer:
 *
 *   - Channel webhook arrives с guest PII
 *   - PMS persists the booking record (own activity log)
 *   - PMS triggers `migrationRegistration` enqueue per existing M8.A.5 logic
 *   - **NO migration registration delegated to channel adapter** — даже если
 *     channel claims to support it, PMS rejects the delegation
 *
 * Pure function helpers: `assertNoChannelMigrationDelegation` throws if a
 * caller (mistakenly) tries to delegate. Tested via 3 МВД tests.
 */

const GOSPOSHLINA_500_RUB_MICROS = 500_000_000n // 500 ₽ в micros (Int64)
const GOSPOSHLINA_EFFECTIVE_DATE = '2026-01-27' // PP №44 от 23.01.2026

export class ChannelMigrationDelegationError extends Error {
	readonly httpStatus = 422
	constructor(channelId: string, reason: string) {
		super(
			`Channel '${channelId}' MUST NOT delegate миграционный учёт к channel adapter — ` +
				`always hotel-side per D20 + 109-ФЗ. Reason: ${reason}`,
		)
		this.name = 'ChannelMigrationDelegationError'
	}
}

/**
 * Reject any attempt to delegate migration registration к channel adapter.
 * Called from channel inbox handlers when payload contains migration-claim
 * fields (e.g. `migrationRegistrationId`, `epguSubmittedAt`).
 *
 * @throws ChannelMigrationDelegationError
 */
export function assertNoChannelMigrationDelegation(input: {
	readonly channelId: string
	readonly payload: Record<string, unknown>
}): void {
	const claimFields = ['migrationRegistrationId', 'epguSubmittedAt', 'epguStatusCode']
	const claimed = claimFields.find((f) => input.payload[f] !== undefined)
	if (claimed !== undefined) {
		throw new ChannelMigrationDelegationError(
			input.channelId,
			`payload contains '${claimed}' — channels do not perform миграционный учёт`,
		)
	}
}

/**
 * Citizenship-based migration registration branching.
 *
 * Per 109-ФЗ ст. 20 ч. 2 (gov RU updates 2026):
 *   - RU citizen: registration NOT required if родственник; otherwise simple
 *     temporary registration (regular cycle).
 *   - Foreign national: МВД миграционный учёт via ЕПГУ obligatory; госпошлина
 *     500 ₽ per PP №44 (effective 27 Jan 2026).
 */
export type CitizenshipKind = 'ru_citizen_родственник' | 'ru_citizen_other' | 'foreign'

export interface MigrationRegistrationRequirement {
	readonly required: boolean
	readonly route: 'epgu' | 'simple_registration' | 'none'
	readonly gosposhlinaMicros: bigint | null
	readonly effectiveSinceUtc: string | null
}

export function deriveMigrationRequirement(input: {
	readonly citizenship: CitizenshipKind
}): MigrationRegistrationRequirement {
	switch (input.citizenship) {
		case 'foreign':
			return {
				required: true,
				route: 'epgu',
				gosposhlinaMicros: GOSPOSHLINA_500_RUB_MICROS,
				effectiveSinceUtc: GOSPOSHLINA_EFFECTIVE_DATE,
			}
		case 'ru_citizen_other':
			return {
				required: true,
				route: 'simple_registration',
				gosposhlinaMicros: null, // gratis для RU citizen
				effectiveSinceUtc: null,
			}
		case 'ru_citizen_родственник':
			return {
				required: false,
				route: 'none',
				gosposhlinaMicros: null,
				effectiveSinceUtc: null,
			}
	}
}
