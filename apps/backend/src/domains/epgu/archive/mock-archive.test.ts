/**
 * MockArchiveBuilder — strict tests.
 *
 * **Pre-done audit checklist:**
 *
 *   Structure (ZIP roundtrip via fflate.unzipSync):
 *     [S1] archive contains req.xml + req.xml.sig + attach.xml + attach.xml.sig
 *     [S2] each scan produces 2 entries: file + .sig
 *     [S3] empty scans list → archive has only req/attach + 2 sigs (4 entries)
 *     [S4] full 6 scans → 4 + 12 = 16 entries
 *
 *   XML correctness (parse req.xml + attach.xml):
 *     [X1] req.xml contains all input metadata fields
 *     [X2] req.xml escapes XML special chars in user-provided strings
 *     [X3] attach.xml lists each scan with filename / mimeType / sha256 / sizeBytes
 *     [X4] sha256 в attach.xml matches actual scan bytes hash
 *     [X5] middleName=null → empty MiddleName tag (NOT "null" string)
 *     [X6] documentSeries=null → empty DocumentSeries tag
 *
 *   Signature shape (ГОСТ Р 34.10-2012 placeholder):
 *     [G1] every .sig is exactly 64 bytes (canonical ГОСТ-256 signature length)
 *     [G2] same payload → same signature (deterministic via SHA-256 chain)
 *     [G3] different payload → different signature (collision-resistant by SHA-256)
 *
 *   Filename convention:
 *     [F1] archiveFilename = `arch_<supplierGid>_<orderId>.zip`
 *
 *   Fingerprint (audit):
 *     [P1] signatureFingerprint = base64 SHA-256 of archive bytes
 *     [P2] same input → same fingerprint (deterministic)
 *     [P3] different orderId → different fingerprint
 *
 *   Validation (ArchiveBuildError):
 *     [V1] missing orderId → throws
 *     [V2] missing supplierGid → throws
 *     [V3] missing guest.lastName → throws
 *     [V4] missing guest.firstName → throws
 *     [V5] missing guest.documentNumber → throws
 *     [V6] scans.length > 6 → throws (Скала-ЕПГУ limit)
 *     [V7] duplicate scan filenames → throws (ZIP overwrite trap)
 */
import { unzipSync } from 'fflate'
import { describe, expect, test } from 'vitest'
import { createMockArchiveBuilder } from './mock-archive.ts'
import type { ArchiveInput } from './types.ts'

function baseInput(overrides: Partial<ArchiveInput> = {}): ArchiveInput {
	return {
		orderId: 'order-test-123',
		serviceCode: '10000103652',
		targetCode: '-1000444103652',
		supplierGid: 'supplier-XYZ',
		regionCode: 'fias-region-sochi',
		guest: {
			lastName: 'Иванов',
			firstName: 'Иван',
			middleName: 'Иванович',
			birthDate: '1990-05-10',
			citizenshipIso3: 'rus',
			documentSeries: '4608',
			documentNumber: '123456',
		},
		arrivalDate: '2026-05-10',
		departureDate: '2026-05-15',
		scans: [],
		...overrides,
	}
}

const builder = createMockArchiveBuilder()

function makeScan(filename: string, mimeType: string, content: string) {
	return { filename, mimeType, bytes: new TextEncoder().encode(content) }
}

describe('MockArchiveBuilder — structure', () => {
	test('[S1] archive contains req.xml + sig + attach.xml + sig', async () => {
		const out = await builder.build(baseInput())
		const entries = unzipSync(out.archive)
		expect(Object.keys(entries).sort()).toEqual([
			'attach.xml',
			'attach.xml.sig',
			'req.xml',
			'req.xml.sig',
		])
	})

	test('[S2] each scan → 2 entries (file + .sig)', async () => {
		const out = await builder.build(
			baseInput({
				scans: [makeScan('scan_passport_main.jpg', 'image/jpeg', 'BYTES1')],
			}),
		)
		const entries = unzipSync(out.archive)
		expect(entries['scan_passport_main.jpg']).toBeDefined()
		expect(entries['scan_passport_main.jpg.sig']).toBeDefined()
	})

	test('[S3] empty scans → 4 entries (req/attach + 2 sigs)', async () => {
		const out = await builder.build(baseInput({ scans: [] }))
		const entries = unzipSync(out.archive)
		expect(Object.keys(entries)).toHaveLength(4)
	})

	test('[S4] 6 scans → 16 entries (4 base + 12 = 6*2)', async () => {
		const out = await builder.build(
			baseInput({
				scans: [
					makeScan('scan_passport_main.jpg', 'image/jpeg', 'A'),
					makeScan('scan_passport_reg.jpg', 'image/jpeg', 'B'),
					makeScan('scan_visa.jpg', 'image/jpeg', 'C'),
					makeScan('scan_migration_card.jpg', 'image/jpeg', 'D'),
					makeScan('scan_consent.pdf', 'application/pdf', 'E'),
					makeScan('scan_extra.jpg', 'image/jpeg', 'F'),
				],
			}),
		)
		const entries = unzipSync(out.archive)
		expect(Object.keys(entries)).toHaveLength(16)
	})
})

describe('MockArchiveBuilder — XML correctness', () => {
	function decodeXml(bytes: Uint8Array): string {
		return new TextDecoder().decode(bytes)
	}

	test('[X1] req.xml contains all input metadata', async () => {
		const out = await builder.build(baseInput())
		const entries = unzipSync(out.archive)
		const reqXml = decodeXml(entries['req.xml']!)
		expect(reqXml).toContain('<ServiceCode>10000103652</ServiceCode>')
		expect(reqXml).toContain('<TargetCode>-1000444103652</TargetCode>')
		expect(reqXml).toContain('<SupplierGid>supplier-XYZ</SupplierGid>')
		expect(reqXml).toContain('<RegionCode>fias-region-sochi</RegionCode>')
		expect(reqXml).toContain('<OrderId>order-test-123</OrderId>')
		expect(reqXml).toContain('<LastName>Иванов</LastName>')
		expect(reqXml).toContain('<FirstName>Иван</FirstName>')
		expect(reqXml).toContain('<MiddleName>Иванович</MiddleName>')
		expect(reqXml).toContain('<BirthDate>1990-05-10</BirthDate>')
		expect(reqXml).toContain('<Citizenship>rus</Citizenship>')
		expect(reqXml).toContain('<DocumentSeries>4608</DocumentSeries>')
		expect(reqXml).toContain('<DocumentNumber>123456</DocumentNumber>')
		expect(reqXml).toContain('<ArrivalDate>2026-05-10</ArrivalDate>')
		expect(reqXml).toContain('<DepartureDate>2026-05-15</DepartureDate>')
	})

	test('[X2] XML escapes special chars in user input', async () => {
		const out = await builder.build(
			baseInput({
				guest: {
					lastName: '<Smith&Jones>',
					firstName: 'Jean"Paul',
					middleName: "O'Hara",
					birthDate: '1990-05-10',
					citizenshipIso3: 'usa',
					documentSeries: null,
					documentNumber: '123',
				},
			}),
		)
		const entries = unzipSync(out.archive)
		const reqXml = decodeXml(entries['req.xml']!)
		expect(reqXml).toContain('&lt;Smith&amp;Jones&gt;')
		expect(reqXml).toContain('Jean&quot;Paul')
		expect(reqXml).toContain('O&apos;Hara')
	})

	test('[X3] attach.xml lists each scan with all metadata', async () => {
		const out = await builder.build(
			baseInput({
				scans: [
					makeScan('scan_visa.jpg', 'image/jpeg', 'BYTES1'),
					makeScan('scan_consent.pdf', 'application/pdf', 'BYTES22'),
				],
			}),
		)
		const entries = unzipSync(out.archive)
		const attach = decodeXml(entries['attach.xml']!)
		expect(attach).toContain('filename="scan_visa.jpg"')
		expect(attach).toContain('mimeType="image/jpeg"')
		expect(attach).toContain('sizeBytes="6"')
		expect(attach).toContain('filename="scan_consent.pdf"')
		expect(attach).toContain('mimeType="application/pdf"')
		expect(attach).toContain('sizeBytes="7"')
	})

	test('[X4] sha256 в attach.xml matches actual scan bytes', async () => {
		const out = await builder.build(
			baseInput({
				scans: [makeScan('scan.jpg', 'image/jpeg', 'hello')],
			}),
		)
		const entries = unzipSync(out.archive)
		const attach = decodeXml(entries['attach.xml']!)
		// SHA-256 of 'hello' = 2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824
		expect(attach).toContain(
			'sha256="2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824"',
		)
	})

	test('[X5] middleName=null → empty MiddleName tag', async () => {
		const out = await builder.build(
			baseInput({
				guest: {
					lastName: 'Иванов',
					firstName: 'Иван',
					middleName: null,
					birthDate: '1990-05-10',
					citizenshipIso3: 'rus',
					documentSeries: '4608',
					documentNumber: '123456',
				},
			}),
		)
		const entries = unzipSync(out.archive)
		const reqXml = decodeXml(entries['req.xml']!)
		expect(reqXml).toContain('<MiddleName></MiddleName>')
		expect(reqXml).not.toContain('null')
	})

	test('[X6] documentSeries=null → empty DocumentSeries tag', async () => {
		const out = await builder.build(
			baseInput({
				guest: {
					lastName: 'Smith',
					firstName: 'John',
					middleName: null,
					birthDate: '1990-01-01',
					citizenshipIso3: 'usa',
					documentSeries: null,
					documentNumber: 'PA1234567',
				},
			}),
		)
		const entries = unzipSync(out.archive)
		const reqXml = decodeXml(entries['req.xml']!)
		expect(reqXml).toContain('<DocumentSeries></DocumentSeries>')
	})
})

describe('MockArchiveBuilder — signature shape', () => {
	test('[G1] every .sig is exactly 64 bytes (ГОСТ Р 34.10-2012 256-bit length)', async () => {
		const out = await builder.build(
			baseInput({
				scans: [
					makeScan('scan_a.jpg', 'image/jpeg', 'A'),
					makeScan('scan_b.jpg', 'image/jpeg', 'B'),
				],
			}),
		)
		const entries = unzipSync(out.archive)
		for (const [name, bytes] of Object.entries(entries)) {
			if (name.endsWith('.sig')) {
				expect(bytes.length).toBe(64)
			}
		}
	})

	test('[G2] same payload → same signature (deterministic)', async () => {
		const out1 = await builder.build(baseInput())
		const out2 = await builder.build(baseInput())
		const sig1 = unzipSync(out1.archive)['req.xml.sig']!
		const sig2 = unzipSync(out2.archive)['req.xml.sig']!
		expect(Array.from(sig1)).toEqual(Array.from(sig2))
	})

	test('[G3] different payload → different signature', async () => {
		const out1 = await builder.build(baseInput({ orderId: 'A' }))
		const out2 = await builder.build(baseInput({ orderId: 'B' }))
		const sig1 = unzipSync(out1.archive)['req.xml.sig']!
		const sig2 = unzipSync(out2.archive)['req.xml.sig']!
		expect(Array.from(sig1)).not.toEqual(Array.from(sig2))
	})
})

describe('MockArchiveBuilder — filename + fingerprint', () => {
	test('[F1] archiveFilename = arch_<supplierGid>_<orderId>.zip', async () => {
		const out = await builder.build(baseInput({ supplierGid: 'sup-001', orderId: 'ord-XYZ' }))
		expect(out.archiveFilename).toBe('arch_sup-001_ord-XYZ.zip')
	})

	test('[P1] fingerprint = base64 SHA-256 of archive bytes', async () => {
		const out = await builder.build(baseInput())
		expect(out.signatureFingerprint).toMatch(/^[A-Za-z0-9+/]+=*$/)
		expect(out.signatureFingerprint.length).toBeGreaterThan(40) // base64 SHA-256 ~ 44 chars
	})

	test('[P2] same input → same fingerprint (deterministic)', async () => {
		const a = await builder.build(baseInput())
		const b = await builder.build(baseInput())
		expect(a.signatureFingerprint).toBe(b.signatureFingerprint)
	})

	test('[P3] different orderId → different fingerprint', async () => {
		const a = await builder.build(baseInput({ orderId: 'A' }))
		const b = await builder.build(baseInput({ orderId: 'B' }))
		expect(a.signatureFingerprint).not.toBe(b.signatureFingerprint)
	})
})

describe('MockArchiveBuilder — validation', () => {
	test('[V1] missing orderId → throws', async () => {
		await expect(builder.build(baseInput({ orderId: '' }))).rejects.toThrow(/orderId/)
	})

	test('[V2] missing supplierGid → throws', async () => {
		await expect(builder.build(baseInput({ supplierGid: '' }))).rejects.toThrow(/supplierGid/)
	})

	test('[V3] missing guest.lastName → throws', async () => {
		await expect(
			builder.build(
				baseInput({
					guest: {
						lastName: '',
						firstName: 'Иван',
						middleName: null,
						birthDate: '1990-01-01',
						citizenshipIso3: 'rus',
						documentSeries: null,
						documentNumber: '1',
					},
				}),
			),
		).rejects.toThrow(/lastName/)
	})

	test('[V4] missing guest.firstName → throws', async () => {
		await expect(
			builder.build(
				baseInput({
					guest: {
						lastName: 'Иванов',
						firstName: '',
						middleName: null,
						birthDate: '1990-01-01',
						citizenshipIso3: 'rus',
						documentSeries: null,
						documentNumber: '1',
					},
				}),
			),
		).rejects.toThrow(/firstName/)
	})

	test('[V5] missing guest.documentNumber → throws', async () => {
		await expect(
			builder.build(
				baseInput({
					guest: {
						lastName: 'Иванов',
						firstName: 'Иван',
						middleName: null,
						birthDate: '1990-01-01',
						citizenshipIso3: 'rus',
						documentSeries: null,
						documentNumber: '',
					},
				}),
			),
		).rejects.toThrow(/documentNumber/)
	})

	test('[V6] scans.length > 6 → throws', async () => {
		const seven = Array.from({ length: 7 }, (_, i) =>
			makeScan(`scan_${i}.jpg`, 'image/jpeg', `B${i}`),
		)
		await expect(builder.build(baseInput({ scans: seven }))).rejects.toThrow(/exceeds.*limit/)
	})

	test('[V7] duplicate scan filenames → throws', async () => {
		await expect(
			builder.build(
				baseInput({
					scans: [
						makeScan('scan_dup.jpg', 'image/jpeg', 'A'),
						makeScan('scan_dup.jpg', 'image/jpeg', 'B'),
					],
				}),
			),
		).rejects.toThrow(/duplicate.*scan_dup/)
	})
})
