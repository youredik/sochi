/**
 * DaData identity-lookup wire types. Backend's adapter and frontend's
 * onboarding wizard both speak this shape — keeping the DTO в shared keeps
 * the contract verified by typecheck on both sides без двойной поддержки.
 *
 * `TaxRegime` is re-used from `tenant-compliance.ts` (the canonical RU tax
 * regime enum) plus `UNKNOWN` for the «DaData didn't surface a value»
 * branch — onboarding fills this in later via the compliance wizard.
 *
 * **Runtime validation** (P4 2026-05-13): the `daDataPartySchema` Zod
 * schema enforces the wire contract at API edges. ОГРН follows a strict
 * length-by-legal-form rule mandated by Russian Tax Code:
 *   - ЮЛ (ООО/АО) → ОГРН = exactly 13 digits
 *   - ИП          → ОГРНИП = exactly 15 digits
 *   - null         → entity hasn't received state registration yet
 *
 * The schema's `.superRefine()` enforces the cross-field consistency
 * (legalForm `LEGAL` ↔ 13d, `INDIVIDUAL` ↔ 15d) so mock test fixtures и
 * real DaData responses both have to obey the same harder contract. Pure
 * regex unions can't express this — a `LEGAL` party with a 15-digit ogrn
 * is plausible at the field level but invalid as a tuple.
 */
import { z } from 'zod'
import { taxRegimeSchema } from './tenant-compliance.ts'

export type { TaxRegime } from './tenant-compliance.ts'

/** Legal-entity registration status (DaData `state.status`). */
export const partyStatusValues = [
	'ACTIVE',
	'LIQUIDATING',
	'LIQUIDATED',
	'REORGANIZING',
	'UNKNOWN',
] as const
export const partyStatusSchema = z.enum(partyStatusValues)
export type PartyStatus = z.infer<typeof partyStatusSchema>

/** Legal form. ЮЛ vs ИП distinction matters for downstream RU compliance. */
export const legalFormValues = ['LEGAL', 'INDIVIDUAL'] as const
export const legalFormSchema = z.enum(legalFormValues)
export type LegalForm = z.infer<typeof legalFormSchema>

/**
 * Extended `TaxRegime` schema that also accepts the `'UNKNOWN'` sentinel —
 * `tenant-compliance.ts`'s base enum already includes UNKNOWN, but exporting
 * a dedicated alias keeps the dadata-side import-site readable.
 */
const daDataTaxRegimeSchema = taxRegimeSchema

/**
 * Canonical RU legal-entity profile. Identical shape across mock + live
 * DaData adapters so the onboarding service code stays adapter-agnostic.
 *
 * Runtime-validated by `daDataPartySchema`. Use that schema (not the
 * type-only interface) at every API edge where untrusted JSON enters the
 * system — route handlers, real-DaData mapper, frontend response parser.
 */
export interface DaDataParty {
	/** 10-digit (ЮЛ) or 12-digit (ИП/самозанятый) tax ID. */
	readonly inn: string
	/** ОГРН (13d ЮЛ) or ОГРНИП (15d ИП); `null` if not yet assigned. */
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
	readonly taxRegime: import('./tenant-compliance.ts').TaxRegime
	/** Operational state — refuse onboarding for `LIQUIDATED`/`LIQUIDATING`. */
	readonly status: PartyStatus
}

/**
 * Runtime schema for `DaDataParty`. Use at the trust boundary.
 *
 * Refinement enforces RU Tax Code (ст. 1474 ГК + 129-ФЗ от 08.08.2001
 * «О государственной регистрации юридических лиц…»): ОГРН для ЮЛ — 13
 * цифр, ОГРНИП для ИП — 15 цифр. `null` discharged separately above.
 */
export const daDataPartySchema = z
	.object({
		inn: z.string().regex(/^(\d{10}|\d{12})$/, 'ИНН: ровно 10 или 12 цифр'),
		ogrn: z.union([
			z.string().regex(/^\d{13}$/, 'ОГРН: ровно 13 цифр'),
			z.string().regex(/^\d{15}$/, 'ОГРНИП: ровно 15 цифр'),
			z.null(),
		]),
		name: z.string().min(1, 'Название обязательно'),
		legalForm: legalFormSchema,
		address: z.string().min(1, 'Адрес обязателен'),
		city: z.string().min(1, 'Город обязателен'),
		taxRegime: daDataTaxRegimeSchema,
		status: partyStatusSchema,
	})
	.superRefine((data, ctx) => {
		if (data.ogrn === null) return
		// LEGAL (ЮЛ) must have ОГРН ровно 13 цифр; INDIVIDUAL (ИП) — 15.
		if (data.legalForm === 'LEGAL' && data.ogrn.length !== 13) {
			ctx.addIssue({
				code: 'custom',
				path: ['ogrn'],
				message: `ЮЛ должен иметь ОГРН из 13 цифр, получено ${data.ogrn.length}`,
			})
		}
		if (data.legalForm === 'INDIVIDUAL' && data.ogrn.length !== 15) {
			ctx.addIssue({
				code: 'custom',
				path: ['ogrn'],
				message: `ИП должен иметь ОГРНИП из 15 цифр, получено ${data.ogrn.length}`,
			})
		}
	})

/**
 * Parse-or-null helper для adapter call-sites. Returns the validated party
 * on success, `null` on schema failure (mirroring the «adapter fail-soft»
 * canon — bad upstream data surfaces as the same UI fallback as «not found»
 * rather than crashing the wizard). Logging is the caller's responsibility.
 */
export function parseDaDataParty(input: unknown): DaDataParty | null {
	const result = daDataPartySchema.safeParse(input)
	return result.success ? result.data : null
}
