/**
 * Validate passport `expirationDate` against today AND booking checkOut window.
 *
 * **Why this matters** (per `project_passport_scan_canon_2026_05_22.md` P0 #3,
 * Round 8 P1-3 closeout):
 *   ЕПГУ rejects миграционная регистрация если документ истекает ДО окончания
 *   брони — passport must be valid throughout the entire stay window.
 *   Pre-Round-8 dialog compared expiry to `today` only → guest passport
 *   expiring 2026-06-15 with stay until 2026-06-25 passed scan, then crashed
 *   downstream регистрация (109-ФЗ ст.22 ч.3 + ПП РФ № 9 от 15.01.2007).
 *
 * **3-branch outcome:**
 *   - `expiry < today` → red banner «Документ истёк YYYY-MM-DD» (no stay needed)
 *   - `expiry < checkOut` → red banner «Документ истекает в период проживания»
 *     (with formatted DD.MM.YYYY checkout date inline)
 *   - `expiry >= checkOut` → ok (guest passport covers entire stay)
 *
 * **Pure function discipline** (per Round 7 v3 «pure-function module isolation
 * для test imports» canon): no closures, no React state — bun:test can import
 * directly. Caller injects `todayIso` for deterministic testing (otherwise
 * `new Date().toISOString().slice(0, 10)` at call site).
 *
 * **String-comparison rationale**: ISO YYYY-MM-DD strings sort
 * lexicographically === chronologically — no `new Date()` parsing needed,
 * avoids timezone drift bugs (Sochi UTC+3 vs server UTC was a Round 4 trap).
 */

export interface ValidateExpiryInput {
	/** Expiry as ISO YYYY-MM-DD. Caller normalizes DD.MM.YYYY → ISO upstream. */
	expiryIso: string
	/** Today as ISO YYYY-MM-DD. Inject for deterministic tests. */
	todayIso: string
	/**
	 * Booking checkout as ISO YYYY-MM-DD. `null` = caller has no booking
	 * context (e.g. rescan-section opened before booking link); helper
	 * degrades gracefully to today-only check.
	 */
	checkOutIso: string | null
}

export type ValidateExpiryResult = { ok: true; error?: undefined } | { ok: false; error: string }

/** YYYY-MM-DD strict ISO date pattern. */
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/

function isoToDdmmyyyy(iso: string): string {
	const match = iso.match(/^(\d{4})-(\d{2})-(\d{2})$/)
	if (match === null) return iso
	return `${match[3]}.${match[2]}.${match[1]}`
}

export function validateExpiryAgainstStay(input: ValidateExpiryInput): ValidateExpiryResult {
	const { expiryIso, todayIso, checkOutIso } = input

	// Invariant: expiryIso must be ISO. Caller's `normalizeDate()` ensures this
	// upstream — but defense-in-depth here for direct callers (tests, future
	// callers that forget to normalize).
	if (!ISO_DATE_RE.test(expiryIso)) {
		return { ok: false, error: 'Срок действия — некорректная дата' }
	}

	// String comparison works because ISO YYYY-MM-DD sorts chronologically.
	// expiry < today → already expired regardless of stay window.
	if (expiryIso < todayIso) {
		return {
			ok: false,
			error: `Документ истёк ${expiryIso}. Гость должен предъявить действующий документ.`,
		}
	}

	// No booking context → today-only check passes (caller degraded path).
	// Defense-in-depth: also degrade on malformed checkOutIso rather than
	// crash — surfaces no false-positive but does not block save.
	if (checkOutIso === null || !ISO_DATE_RE.test(checkOutIso)) {
		return { ok: true }
	}

	// Expiry strictly before checkOut → expires during stay.
	// Boundary expiry === checkOut treated as OK (last stay day covered).
	if (expiryIso < checkOutIso) {
		const checkOutRu = isoToDdmmyyyy(checkOutIso)
		return {
			ok: false,
			error: `Документ истекает в период проживания. Гость должен предъявить документ, действующий до конца брони (до ${checkOutRu}).`,
		}
	}

	return { ok: true }
}
