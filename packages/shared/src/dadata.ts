/**
 * DaData identity-lookup wire types. Backend's adapter and frontend's
 * onboarding wizard both speak this shape — keeping the DTO в shared keeps
 * the contract verified by typecheck on both sides без двойной поддержки.
 *
 * `TaxRegime` is re-used from `tenant-compliance.ts` (the canonical RU tax
 * regime enum) plus `UNKNOWN` for the «DaData didn't surface a value»
 * branch — onboarding fills this in later via the compliance wizard.
 */
import type { TaxRegime } from './tenant-compliance.ts'

export type { TaxRegime } from './tenant-compliance.ts'

/** Legal-entity registration status (DaData `state.status`). */
export type PartyStatus = 'ACTIVE' | 'LIQUIDATING' | 'LIQUIDATED' | 'REORGANIZING' | 'UNKNOWN'

/** Legal form. ЮЛ vs ИП distinction matters for downstream RU compliance. */
export type LegalForm = 'LEGAL' | 'INDIVIDUAL'

/**
 * Canonical RU legal-entity profile. Identical shape across mock + live
 * DaData adapters so the onboarding service code stays adapter-agnostic.
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
	/** Inferred tax regime — `'UNKNOWN'` if DaData didn't surface a value. */
	readonly taxRegime: TaxRegime
	/** Operational state — refuse onboarding for `LIQUIDATED`/`LIQUIDATING`. */
	readonly status: PartyStatus
}
