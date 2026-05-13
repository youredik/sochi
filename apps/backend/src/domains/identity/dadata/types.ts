/**
 * DaData findById/party adapter contract.
 *
 * The onboarding wizard auto-fills hotel-organization metadata from a single
 * ИНН input. Mock returns a canonical Сочи demo dataset (demo tenants); real
 * implementation hits the DaData REST API which is the de-facto standard
 * source-of-truth for RU legal entity lookup (10k req/day on the free tier,
 * sufficient for SMB onboarding volume).
 *
 * Adapter is fail-soft: real-impl errors (timeout, non-2xx, malformed JSON,
 * network) return `null`. The wizard falls back to manual entry, so a
 * provider blip never blocks user onboarding.
 */

/** Tax regime (система налогообложения) — drives downstream fiscal flow. */
export type TaxRegime =
	| 'USN_DOHODY' // УСН 6% (доходы)
	| 'USN_DOHODY_RASHODY' // УСН 15% (доходы минус расходы)
	| 'NPD' // НПД (самозанятые), 4-6%
	| 'OSNO' // ОСНО (общая, с НДС)
	| 'AUSN_DOHODY' // АУСН доходы, 8%
	| 'AUSN_DOHODY_RASHODY' // АУСН доходы-расходы, 20%
	| 'UNKNOWN'

/** Legal-entity registration status (DaData `state.status`). */
export type PartyStatus = 'ACTIVE' | 'LIQUIDATING' | 'LIQUIDATED' | 'REORGANIZING' | 'UNKNOWN'

/** Legal form. ЮЛ vs ИП distinction matters for downstream RU compliance. */
export type LegalForm = 'LEGAL' | 'INDIVIDUAL'

/**
 * Canonical RU legal-entity profile. Schema stays adapter-agnostic so the
 * onboarding service code is identical against mock + live.
 */
export interface DaDataParty {
	/** 10-digit (ЮЛ) or 12-digit (ИП/самозанятый) tax ID. */
	readonly inn: string
	/** ОГРН/ОГРНИП (state registration number); `null` if not yet assigned. */
	readonly ogrn: string | null
	/** Display name: `ООО "Ромашка"` / `ИП Иванов И.И.` */
	readonly name: string
	/** Юр.лицо (ООО/АО) vs ИП/самозанятый. */
	readonly legalForm: LegalForm
	/** Full formatted address (single line). */
	readonly address: string
	/** City segment (e.g. `Сочи`, `Адлер`, `Красная Поляна`, `Москва`). */
	readonly city: string
	/** Inferred tax regime — `UNKNOWN` if DaData didn't surface a value. */
	readonly taxRegime: TaxRegime
	/** Operational state — refuse onboarding for `LIQUIDATED`/`LIQUIDATING`. */
	readonly status: PartyStatus
}

/**
 * The single capability of the DaData adapter: lookup by ИНН. Returns
 * `null` when DaData has no record (unknown ИНН) OR when the adapter
 * failed fail-softly. The route layer distinguishes via response shape:
 * `{ data: party | null }` carries «not found / soft fail» semantics
 * uniformly; the UI then offers manual override.
 */
export interface DaDataAdapter {
	findByInn(inn: string): Promise<DaDataParty | null>
}
