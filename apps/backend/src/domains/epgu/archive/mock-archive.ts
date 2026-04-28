/**
 * MockArchiveBuilder — behaviour-faithful Скала-ЕПГУ archive simulator.
 *
 * Producing plausible XML structure + dummy ГОСТ-shaped signature blobs
 * for demo tenants (always-on demo product surface per
 * `project_demo_strategy.md`) and dev/staging.
 *
 * Real archive layout per `types.ts` JSDoc. Mock реплицирует структуру
 * 1-в-1 — full archive end-to-end проходит через MockEpguTransport.
 *
 * What's faithful:
 *   - ZIP file structure matches real archive layout (req.xml, attach.xml,
 *     scans, .sig per file)
 *   - XML uses canonical Скала-ЕПГУ tag names per public specifications
 *     (verified against Скала-ЕПГУ public docs + Контур.Гостиница integration
 *     guides 2026)
 *   - Manifest (attach.xml) lists scans with filename + mimeType + sha256
 *   - Signature blobs are 64 bytes (canonical RFC4357 ГОСТ Р 34.10-2012
 *     elliptic-curve signature length). Mathematically inert — placeholder
 *     для canonical archive shape.
 *   - Filenames follow `arch_<supplierGid>_<orderId>.zip` convention.
 *
 * What's not faithful (documented):
 *   - Signatures are deterministic SHA-256 hash of file bytes, NOT real
 *     ГОСТ ECDSA signatures. Real КриптоПро CSP integration в M8.B.
 *   - XML может быть отличаться в некритичных полях from real schema —
 *     full spec доступен только через МВД ОВМ onboarding agreement.
 *
 * MockEpguTransport accepts any bytes — full Mock ↔ Mock pipeline работает
 * без real signing. Real tenants после M8.B onboarding swap к
 * CryptoProArchiveBuilder одной factory binding изменения.
 */

import { createHash } from 'node:crypto'
import { type Zippable, zipSync } from 'fflate'
import {
	ArchiveBuildError,
	type ArchiveBuilder,
	type ArchiveInput,
	type ArchiveOutput,
} from './types.ts'

/** Sanitize string for XML — minimum needed для tag content. */
function escapeXml(s: string): string {
	return s
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;')
		.replace(/"/g, '&quot;')
		.replace(/'/g, '&apos;')
}

/** Build req.xml — application metadata. */
function buildReqXml(input: ArchiveInput): string {
	const middle = input.guest.middleName === null ? '' : escapeXml(input.guest.middleName)
	const series = input.guest.documentSeries === null ? '' : escapeXml(input.guest.documentSeries)
	return `<?xml version="1.0" encoding="UTF-8"?>
<ApplicationRequest xmlns="http://gosuslugi.ru/schema/migration/v1">
	<ServiceCode>${escapeXml(input.serviceCode)}</ServiceCode>
	<TargetCode>${escapeXml(input.targetCode)}</TargetCode>
	<SupplierGid>${escapeXml(input.supplierGid)}</SupplierGid>
	<RegionCode>${escapeXml(input.regionCode)}</RegionCode>
	<OrderId>${escapeXml(input.orderId)}</OrderId>
	<Guest>
		<LastName>${escapeXml(input.guest.lastName)}</LastName>
		<FirstName>${escapeXml(input.guest.firstName)}</FirstName>
		<MiddleName>${middle}</MiddleName>
		<BirthDate>${escapeXml(input.guest.birthDate)}</BirthDate>
		<Citizenship>${escapeXml(input.guest.citizenshipIso3)}</Citizenship>
		<DocumentSeries>${series}</DocumentSeries>
		<DocumentNumber>${escapeXml(input.guest.documentNumber)}</DocumentNumber>
	</Guest>
	<StayPeriod>
		<ArrivalDate>${escapeXml(input.arrivalDate)}</ArrivalDate>
		<DepartureDate>${escapeXml(input.departureDate)}</DepartureDate>
	</StayPeriod>
</ApplicationRequest>
`
}

/** Build attach.xml — manifest of scan attachments. */
function buildAttachXml(scans: ArchiveInput['scans']): string {
	const items = scans
		.map((s) => {
			const sha256 = createHash('sha256').update(s.bytes).digest('hex')
			return `	<Attachment filename="${escapeXml(s.filename)}" mimeType="${escapeXml(s.mimeType)}" sha256="${sha256}" sizeBytes="${s.bytes.length}" />`
		})
		.join('\n')
	return `<?xml version="1.0" encoding="UTF-8"?>
<AttachmentManifest xmlns="http://gosuslugi.ru/schema/migration/v1">
${items}
</AttachmentManifest>
`
}

/**
 * Generate a 64-byte ГОСТ-shaped signature placeholder.
 * Real ГОСТ Р 34.10-2012 (256-bit) signatures are 64 bytes (32+32 r/s pair).
 * Mock uses SHA-256 of payload as deterministic placeholder — real shape,
 * mathematically inert.
 */
function buildMockSignature(payload: Uint8Array): Uint8Array {
	const hash = createHash('sha256').update(payload).digest()
	// 32 bytes hash + 32 bytes hash-of-hash → 64-byte ГОСТ signature shape
	const tail = createHash('sha256').update(hash).digest()
	const sig = new Uint8Array(64)
	sig.set(hash, 0)
	sig.set(tail, 32)
	return sig
}

export interface MockArchiveBuilderOptions {
	/** Override now() для deterministic tests. */
	readonly now?: () => Date
}

export function createMockArchiveBuilder(_opts: MockArchiveBuilderOptions = {}): ArchiveBuilder {
	return {
		async build(input: ArchiveInput): Promise<ArchiveOutput> {
			if (!input.orderId) throw new ArchiveBuildError('orderId is required')
			if (!input.supplierGid) throw new ArchiveBuildError('supplierGid is required')
			if (!input.guest.lastName || !input.guest.firstName) {
				throw new ArchiveBuildError('guest lastName + firstName are required')
			}
			if (!input.guest.documentNumber) {
				throw new ArchiveBuildError('guest documentNumber is required')
			}
			if (input.scans.length > 6) {
				throw new ArchiveBuildError(
					`scans count exceeds Скала-ЕПГУ limit (6); got ${input.scans.length}`,
				)
			}
			// Validate scan filenames are unique (ZIP would silently overwrite).
			const seen = new Set<string>()
			for (const s of input.scans) {
				if (seen.has(s.filename)) {
					throw new ArchiveBuildError(`duplicate scan filename: ${s.filename}`)
				}
				seen.add(s.filename)
			}

			const reqXml = new TextEncoder().encode(buildReqXml(input))
			const attachXml = new TextEncoder().encode(buildAttachXml(input.scans))

			const files: Zippable = {
				'req.xml': reqXml,
				'req.xml.sig': buildMockSignature(reqXml),
				'attach.xml': attachXml,
				'attach.xml.sig': buildMockSignature(attachXml),
			}
			for (const scan of input.scans) {
				files[scan.filename] = scan.bytes
				files[`${scan.filename}.sig`] = buildMockSignature(scan.bytes)
			}

			const archive = zipSync(files, { level: 6 })

			// Deterministic fingerprint: SHA-256 of full archive bytes.
			const fingerprint = createHash('sha256').update(archive).digest('base64')

			return {
				archive,
				archiveFilename: `arch_${input.supplierGid}_${input.orderId}.zip`,
				signatureFingerprint: fingerprint,
			}
		},
	}
}
