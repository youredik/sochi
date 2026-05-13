import { logger } from '../../../logger.ts'
import type { DaDataAdapter, DaDataParty, LegalForm, PartyStatus, TaxRegime } from './types.ts'

/**
 * Real DaData REST adapter — `suggestions.dadata.ru/suggestions/api/4_1/rs/findById/party`.
 *
 * Free tier ceiling: 10_000 calls/day, ≤30 rps per token. Sochi SMB volume
 * (≤200 onboardings/day projected for 12-month window) fits comfortably.
 *
 * Fail-soft posture: timeout / network error / non-2xx / unparsable JSON →
 * return `null` + warn-log. The onboarding UI surfaces "не нашли — заполните
 * вручную" so a transient DaData outage never blocks signup.
 *
 * Privacy: log only the first 6 digits of the ИНН — enough for diagnostic
 * geo prefix lookup (e.g. `2320` = Краснодарский край), insufficient for
 * re-identification.
 */

const ENDPOINT = 'https://suggestions.dadata.ru/suggestions/api/4_1/rs/findById/party'
const DEFAULT_TIMEOUT_MS = 3_000

export interface RealDaDataOptions {
	readonly apiKey: string
	/** Override for tests; defaults to global `fetch`. */
	readonly fetchImpl?: typeof fetch
	/** Override for tests; defaults to `DEFAULT_TIMEOUT_MS`. */
	readonly timeoutMs?: number
}

/**
 * Subset of the DaData response we read. The full schema is large and
 * unstable — narrowing protects against silent breakage when DaData adds
 * fields. Fields ARE typed as `unknown` for fields we don't drill into.
 */
interface DaDataApiSuggestion {
	readonly value?: unknown
	readonly data?: {
		readonly inn?: unknown
		readonly ogrn?: unknown
		readonly opf?: { readonly short?: unknown; readonly full?: unknown }
		readonly name?: { readonly full_with_opf?: unknown; readonly short_with_opf?: unknown }
		readonly type?: unknown
		readonly state?: { readonly status?: unknown }
		readonly address?: {
			readonly value?: unknown
			readonly data?: {
				readonly city?: unknown
				readonly city_with_type?: unknown
				readonly settlement_with_type?: unknown
			}
		}
		readonly tax_system?: unknown
	}
}

interface DaDataApiResponse {
	readonly suggestions?: ReadonlyArray<DaDataApiSuggestion>
}

function parseLegalForm(type: unknown): LegalForm {
	return type === 'INDIVIDUAL' ? 'INDIVIDUAL' : 'LEGAL'
}

function parseStatus(raw: unknown): PartyStatus {
	if (raw === 'ACTIVE' || raw === 'LIQUIDATING' || raw === 'LIQUIDATED' || raw === 'REORGANIZING') {
		return raw
	}
	return 'UNKNOWN'
}

function parseTaxRegime(raw: unknown): TaxRegime {
	if (typeof raw !== 'string') return 'UNKNOWN'
	const upper = raw.toUpperCase()
	if (upper.includes('NPD') || upper.includes('НПД')) return 'NPD'
	if (upper.includes('USN_INCOME_OUTCOME') || upper.includes('USN_REVENUE_LESS_EXPENSE')) {
		return 'USN_DOHODY_RASHODY'
	}
	if (upper.includes('USN')) return 'USN_DOHODY'
	if (upper.includes('AUSN_INCOME_OUTCOME')) return 'AUSN_DOHODY_RASHODY'
	if (upper.includes('AUSN')) return 'AUSN_DOHODY'
	// DaData sometimes returns `OSNO` (long form) and `OSN` (short) for the
	// общая система налогообложения — the canonical sochi enum uses `'OSN'`
	// per `tenant-compliance.ts`, normalize both upstream spellings here.
	if (upper.includes('OSNO') || upper.includes('OSN')) return 'OSN'
	if (upper.includes('PSN')) return 'PSN'
	return 'UNKNOWN'
}

function pickString(...candidates: unknown[]): string {
	for (const c of candidates) {
		if (typeof c === 'string' && c.length > 0) return c
	}
	return ''
}

function mapSuggestion(s: DaDataApiSuggestion): DaDataParty | null {
	const d = s.data
	if (!d) return null
	const inn = typeof d.inn === 'string' ? d.inn : ''
	if (inn.length === 0) return null
	const name = pickString(d.name?.short_with_opf, d.name?.full_with_opf, s.value)
	if (name.length === 0) return null
	const address = pickString(d.address?.value)
	const city = pickString(
		d.address?.data?.city,
		d.address?.data?.city_with_type,
		d.address?.data?.settlement_with_type,
	)
	return {
		inn,
		ogrn: typeof d.ogrn === 'string' ? d.ogrn : null,
		name,
		legalForm: parseLegalForm(d.type),
		address,
		city,
		taxRegime: parseTaxRegime(d.tax_system),
		status: parseStatus(d.state?.status),
	}
}

export function createRealDaData(opts: RealDaDataOptions): DaDataAdapter {
	const fetchImpl = opts.fetchImpl ?? globalThis.fetch
	const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS

	return {
		async findByInn(inn) {
			const innPrefix = inn.slice(0, 6)
			const controller = new AbortController()
			const timer = setTimeout(() => controller.abort(), timeoutMs)
			try {
				const res = await fetchImpl(ENDPOINT, {
					method: 'POST',
					signal: controller.signal,
					headers: {
						'Content-Type': 'application/json',
						Accept: 'application/json',
						Authorization: `Token ${opts.apiKey}`,
					},
					body: JSON.stringify({ query: inn, count: 1 }),
				})
				if (!res.ok) {
					logger.warn({ innPrefix, status: res.status }, 'DaData non-2xx — fail-soft')
					return null
				}
				const json = (await res.json()) as DaDataApiResponse
				const first = json.suggestions?.[0]
				if (!first) return null
				return mapSuggestion(first)
			} catch (err) {
				logger.warn(
					{ innPrefix, err: err instanceof Error ? err.message : String(err) },
					'DaData lookup failed — fail-soft',
				)
				return null
			} finally {
				clearTimeout(timer)
			}
		},
	}
}
