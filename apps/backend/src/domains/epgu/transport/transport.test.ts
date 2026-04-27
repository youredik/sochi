/**
 * Stub-transport contract tests.
 *
 * These are deliberately light — the stubs throw on every method. The tests
 * lock down the public-API shape so an accidental signature change in M8.A
 * (when real impls land) is caught immediately. They also verify the
 * `channel` discriminator is correctly set.
 */
import { describe, expect, it } from 'vitest'
import {
	createGostTlsTransport,
	createProxyViaPartnerTransport,
	createSvoksTransport,
	type EpguChannel,
	type EpguTransport,
	EpguTransportNotImplementedError,
} from './index.ts'

const SAMPLE_ORDER = {
	serviceCode: '10000103652',
	targetCode: '-1000444103652',
	regionCode: '88cd27e2-6a8a-4421-9718-719a28a0a088',
} as const

const SAMPLE_PUSH = {
	orderId: 'order-1',
	archive: new Uint8Array([0x50, 0x4b, 0x03, 0x04]), // ZIP magic
	archiveFilename: 'arch_ip_10000103652.zip',
	meta: { region: '45', serviceCode: '10000103652', targetCode: '-1000444103652' },
} as const

describe('EpguTransport stubs', () => {
	const cases: Array<{ channel: EpguChannel; build: () => EpguTransport }> = [
		{
			channel: 'gost-tls',
			build: () =>
				createGostTlsTransport({
					endpoint: 'https://www.gosuslugi.ru',
					certificate: 'PEM',
					supplierGid: '5200000008002021',
				}),
		},
		{
			channel: 'svoks',
			build: () =>
				createSvoksTransport({
					endpoint: 'https://svoks.gosuslugi.ru',
					clientId: 'CLIENT',
					oauthScope: 'epgu.hotel.read',
					certificate: 'PEM',
				}),
		},
		{
			channel: 'proxy-via-partner',
			build: () =>
				createProxyViaPartnerTransport({
					partner: 'skala-epgu',
					endpoint: 'https://api.skala-epgu.ru',
					apiKey: 'key',
				}),
		},
	]

	for (const { channel, build } of cases) {
		describe(`channel=${channel}`, () => {
			it('exposes the configured channel discriminator', () => {
				expect(build().channel).toBe(channel)
			})

			it('reserveOrder throws EpguTransportNotImplementedError with channel + method', async () => {
				const t = build()
				try {
					await t.reserveOrder(SAMPLE_ORDER)
					expect.fail('should have thrown')
				} catch (err) {
					expect(err).toBeInstanceOf(EpguTransportNotImplementedError)
					expect((err as Error).name).toBe('EpguTransportNotImplementedError')
					expect((err as Error).message).toContain(channel)
					expect((err as Error).message).toContain('reserveOrder')
					expect((err as Error).message).toContain('M8.A')
				}
			})

			it('pushArchive throws with channel + method', async () => {
				const t = build()
				await expect(t.pushArchive(SAMPLE_PUSH)).rejects.toBeInstanceOf(
					EpguTransportNotImplementedError,
				)
				try {
					await t.pushArchive(SAMPLE_PUSH)
				} catch (err) {
					expect((err as Error).message).toContain(channel)
					expect((err as Error).message).toContain('pushArchive')
				}
			})

			it('getStatus throws with channel + method', async () => {
				const t = build()
				await expect(t.getStatus({ orderId: 'order-1' })).rejects.toBeInstanceOf(
					EpguTransportNotImplementedError,
				)
				try {
					await t.getStatus({ orderId: 'order-1' })
				} catch (err) {
					expect((err as Error).message).toContain(channel)
					expect((err as Error).message).toContain('getStatus')
				}
			})
		})
	}

	it('error message instructs the reader to look at M8.A wiring', async () => {
		const t = createGostTlsTransport({
			endpoint: 'x',
			certificate: 'x',
			supplierGid: 'x',
		})
		try {
			await t.reserveOrder(SAMPLE_ORDER)
			expect.fail()
		} catch (err) {
			expect((err as Error).message).toMatch(/wires up in M8\.A/)
		}
	})
})
