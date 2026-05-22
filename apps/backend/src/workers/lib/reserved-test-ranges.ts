/**
 * Reserved-for-testing recipient ranges — IANA + ITU-T canon.
 *
 * Outbound adapters (email, sms, future channels) MUST consult this module
 * before forwarding к real upstream providers. Recipients within these
 * reserved ranges are **guaranteed never deliverable** in real-world DNS /
 * telco networks — sending к ним:
 *
 *   1. ВСЕГДА hard-bounces / message rejected → MTA reputation damage
 *   2. Жжёт provider quota gratuitously (наблюдалось 2026-05-22:
 *      demo seed × N container restarts = 160+ Postbox writes / 200 daily
 *      free tier → 100% quota burn → real users locked out)
 *   3. Может попасть в анти-spam / anti-abuse blocklists у некоторых
 *      receivers, накапливая negative reputation на sender domain
 *
 * Single source of truth для defense-in-depth — все outbound adapters
 * (`DemoInboxAdapter`, `PostboxAdapter`, future SMS-live etc) consume
 * these predicates symmetrically. Test fixtures для unit/e2e должны
 * использовать ИМЕННО этот reserved space, чтобы prod paths гарантированно
 * не отправляли реальные writes.
 *
 * Architecture canon `[[outbound_side_effect_discipline_2026_05_22]]`.
 *
 * Sources:
 *   - RFC 2606 (BCP 32) — Reserved Top Level DNS Names (`*.test`, `*.example`,
 *     `*.invalid`, `*.localhost`; `example.com`, `example.net`, `example.org`)
 *     https://tools.ietf.org/html/rfc2606
 *   - RFC 6761 — Special-Use Domain Names (formal `*.localhost`, etc)
 *     https://tools.ietf.org/html/rfc6761
 *   - ITU-T E.164.3 — Numbering plan testing ranges:
 *     `+99899x...` (E.164.3 §6.1 fictitious test numbers)
 *   - North-American Numbering Plan reserved-fictitious blocks
 *     `+1 (XXX) 555-01XX` (NANP test range)
 *   - Russian numbering plan reserved-for-test:
 *     `+7 000` (Россвязь reserved block — never assigned к operator)
 */

/**
 * RFC 2606 (BCP 32) + RFC 6761 reserved-for-testing domain detection.
 *
 * Returns `true` for addresses chained к reserved domains:
 *   - Exact second-level: `example.com`, `example.net`, `example.org`
 *   - Reserved TLDs: `.test`, `.example`, `.invalid`, `.localhost`
 *
 * Case-insensitive + whitespace-tolerant. `false` for malformed inputs
 * (no `@` sign, empty domain part etc).
 */
export function isReservedTestDomain(email: string): boolean {
	const at = email.lastIndexOf('@')
	if (at === -1) return false
	const domain = email
		.slice(at + 1)
		.trim()
		.toLowerCase()
	if (domain === '') return false
	// Exact second-level matches per RFC 2606 §3.
	if (domain === 'example.com' || domain === 'example.net' || domain === 'example.org') {
		return true
	}
	// Reserved TLDs per RFC 2606 §2 + RFC 6761 §6.3.
	// Matches как точный domain (e.g. `localhost`) ИЛИ suffix (e.g. `foo.test`).
	const reservedTlds = ['test', 'example', 'invalid', 'localhost']
	for (const tld of reservedTlds) {
		if (domain === tld || domain.endsWith(`.${tld}`)) return true
	}
	return false
}

/**
 * ITU-T E.164.3 + national-plan reserved-fictitious phone range detection.
 *
 * Returns `true` for phones в reserved-for-testing ranges, which are
 * guaranteed never assigned к real subscriber:
 *
 *   - **ITU-T E.164.3 §6.1**: `+99899xxxxxx...` international test prefix
 *     (15-digit fictitious numbers reserved за ITU-T)
 *   - **NANP reserved-fictitious**: `+1 XXX 555 0100..0199` (North-American
 *     numbering plan canonical test block per ATIS-0300076)
 *   - **Russian (Россвязь) reserved**: `+7 000` prefix — никогда не
 *     назначался operator'у, deliberately fictitious test space
 *
 * Input normalized к E.164 form (`+...`) before matching. Pass через
 * `normalizePhoneE164` upstream if не уверен в форме. Liberal whitespace +
 * separator (`-`, ` `, `(`, `)`) tolerance — strips before comparison.
 *
 * Note: `+0` / `+999` ranges (general future-reserved) **NOT** included —
 * могут быть assigned в будущем. Только канонические test ranges trip.
 */
export function isReservedTestPhone(phone: string): boolean {
	// Strip всё кроме `+` и digits — tolerates spaces, hyphens, parens.
	const cleaned = phone.replace(/[^+\d]/g, '')
	if (cleaned === '') return false
	// Strip leading `+` если present — match вне зависимости от form.
	const digits = cleaned.startsWith('+') ? cleaned.slice(1) : cleaned
	if (digits.length === 0) return false

	// ITU-T E.164.3 §6.1 — `99899` prefix for fictitious test numbers.
	if (digits.startsWith('99899')) return true

	// Russian Россвязь reserved — `7 000` prefix (никогда не назначался).
	if (digits.startsWith('7000')) return true

	// NANP `+1 XXX 555 0100-0199` test block — country=1, area code X, NXX=555,
	// line=01XX. Match form: `1` + 3 digits + `555` + `01` + 2 digits.
	if (digits.length === 11 && digits.startsWith('1') && digits.slice(4, 9) === '55501') {
		return true
	}

	return false
}
