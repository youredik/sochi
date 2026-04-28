/**
 * ЕПГУ archive interface — phase 2 payload builder для миграционного
 * учёта submission.
 *
 * ## Real-world archive structure (per Скала-ЕПГУ public docs)
 *
 *   archive_<orderId>.zip
 *   ├── req.xml                  # Application metadata (service code, target, tenant, guest)
 *   ├── req.xml.sig              # ГОСТ Р 34.10-2012 signature of req.xml
 *   ├── attach.xml               # Manifest of scan attachments (filename → mimeType + sha256)
 *   ├── attach.xml.sig           # ГОСТ signature of attach.xml
 *   ├── scan_passport_main.jpg   # Scan #1 (main spread)
 *   ├── scan_passport_main.jpg.sig
 *   ├── scan_passport_reg.jpg    # Scan #2 (registration page)
 *   ├── scan_passport_reg.jpg.sig
 *   ├── scan_visa.jpg            # Scan #3 (visa, if applicable)
 *   ├── scan_visa.jpg.sig
 *   ├── scan_migration_card.jpg  # Scan #4 (migration card)
 *   ├── scan_migration_card.jpg.sig
 *   ├── scan_consent.pdf         # 152-ФЗ ОПД consent
 *   ├── scan_consent.pdf.sig
 *   ├── scan_extra.jpg           # Optional 6th: дополнительный документ
 *   └── scan_extra.jpg.sig
 *
 * Каждый файл подписан ГОСТ Р 34.10-2012 detached signature (CMS / CAdES-BES).
 * Подпись делается ключом supplier'а (выдан МВД ОВМ при onboarding) над
 * SHA-256 hash содержимого файла.
 *
 * ## Two implementations
 *
 *   - **MockArchiveBuilder** (`mock-archive.ts`):
 *       Builds plausible XML structure + dummy ГОСТ-shaped signature blobs
 *       (64-байт RFC4357 elliptic-curve signature shape, but mathematically
 *       inert — placeholder for canonical layout). Used by demo тенантами
 *       навсегда (mode=demo → all integrations Mock per
 *       project_demo_strategy.md). Behaviour-faithful: real archive
 *       transport API accepts bytes, MockEpguTransport accepts bytes —
 *       Mock ↔ Mock end-to-end shipping not affected by absence of real
 *       КриптоПро integration.
 *   - **CryptoProArchiveBuilder** (M8.B post-onboarding):
 *       Real spec from МВД ОВМ multi-week onboarding agreement +
 *       КриптоПро CSP commercial license. Same interface; swap = factory binding.
 *
 * Why we don't ship real ГОСТ now (per
 * `feedback_empirical_mock_verification.md`):
 *   * ГОСТ Р 34.10-2012 в pure Node.js без КриптоПро = не существует
 *     (RusCryptoJS broken on macOS, OpenSSL GOST plugins системные).
 *   * Real Скала-ЕПГУ XML schema публично не доступна — full spec через
 *     МВД ОВМ partnership.
 *   * Demo tenants don't need real signing — payload отправляется в
 *     MockEpguTransport который не валидирует bytes.
 *   * Real tenants после M8.B onboarding получат КриптоПро integration
 *     одной factory swap.
 */

/** Per-scan input describing what's to be packaged in the archive. */
export interface ArchiveScan {
	/** Stable canonical filename (e.g. 'scan_passport_main.jpg'). */
	readonly filename: string
	/** MIME type — image/jpeg | image/png | application/pdf. */
	readonly mimeType: string
	/** Raw bytes of the scan. */
	readonly bytes: Uint8Array
}

/** Inputs the builder needs to assemble a complete archive. */
export interface ArchiveInput {
	/** ЕПГУ orderId from `reserveOrder` (phase 1). */
	readonly orderId: string
	/** Service identifier (e.g. '10000103652' для миграционного учёта). */
	readonly serviceCode: string
	/** Target identifier (sub-service, e.g. '-1000444103652'). */
	readonly targetCode: string
	/** Supplier GID — issued by МВД ОВМ at onboarding. */
	readonly supplierGid: string
	/** Property region ФИАС code. */
	readonly regionCode: string
	/** Guest passport / document data (structured fields, not raw scan). */
	readonly guest: {
		readonly lastName: string
		readonly firstName: string
		readonly middleName: string | null
		readonly birthDate: string // YYYY-MM-DD
		readonly citizenshipIso3: string // 'rus', 'kaz', etc.
		readonly documentSeries: string | null
		readonly documentNumber: string
	}
	/** Stay period. */
	readonly arrivalDate: string // YYYY-MM-DD
	readonly departureDate: string // YYYY-MM-DD
	/**
	 * Scan files. Real Скала-ЕПГУ submission requires up to 6 scans
	 * (passport main / passport reg / visa / migration card / consent /
	 * extra). MockArchiveBuilder accepts 0..N — empty allowed для
	 * archive-shape integration tests.
	 */
	readonly scans: readonly ArchiveScan[]
}

/** What the builder returns. */
export interface ArchiveOutput {
	/** ZIP bytes ready for `EpguTransport.pushArchive`. */
	readonly archive: Uint8Array
	/** Canonical filename (e.g. 'arch_supplier-XYZ_orderABC.zip'). */
	readonly archiveFilename: string
	/**
	 * Base64-encoded fingerprint of the signature bundle. Audit trail —
	 * stored on migrationRegistration.attemptsHistoryJson per-attempt for
	 * forensics. Real CryptoPro impl produces a real CADES-BES fingerprint;
	 * Mock produces a deterministic SHA-256 of the archive bytes.
	 */
	readonly signatureFingerprint: string
}

/** Pluggable archive builder — Mock or KriptoPro. */
export interface ArchiveBuilder {
	build(input: ArchiveInput): Promise<ArchiveOutput>
}

/** Thrown by builders for input validation failures. */
export class ArchiveBuildError extends Error {
	constructor(message: string) {
		super(message)
		this.name = 'ArchiveBuildError'
	}
}
