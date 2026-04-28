/**
 * Stub for the СВОКС channel.
 *
 * Status (27.04.2026): mandate for hospitality NOT confirmed. The
 * NON-CONFIRMED 2027 anticipated change is scoped here — wave-4 research
 * could not find a published act mandating СВОКС-only by 2027.
 *
 * Why we declare the stub anyway: if Минцифры publishes the mandate
 * mid-roadmap, swap-in becomes a single-file change instead of an
 * interface refactor.
 */
import {
	type EpguCancelRequest,
	type EpguCancelResponse,
	type EpguOrderRequest,
	type EpguOrderResponse,
	type EpguPushRequest,
	type EpguPushResponse,
	type EpguStatusRequest,
	type EpguStatusResponse,
	type EpguTransport,
	EpguTransportNotImplementedError,
} from './types.ts'

export interface SvoksTransportOptions {
	readonly endpoint: string
	readonly clientId: string
	readonly oauthScope: string
	readonly certificate: string
}

export function createSvoksTransport(_opts: SvoksTransportOptions): EpguTransport {
	return {
		channel: 'svoks',
		async reserveOrder(_req: EpguOrderRequest): Promise<EpguOrderResponse> {
			throw new EpguTransportNotImplementedError('svoks', 'reserveOrder')
		},
		async pushArchive(_req: EpguPushRequest): Promise<EpguPushResponse> {
			throw new EpguTransportNotImplementedError('svoks', 'pushArchive')
		},
		async getStatus(_req: EpguStatusRequest): Promise<EpguStatusResponse> {
			throw new EpguTransportNotImplementedError('svoks', 'getStatus')
		},
		async cancelOrder(_req: EpguCancelRequest): Promise<EpguCancelResponse> {
			throw new EpguTransportNotImplementedError('svoks', 'cancelOrder')
		},
	}
}
