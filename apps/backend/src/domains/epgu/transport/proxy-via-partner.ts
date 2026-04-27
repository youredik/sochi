/**
 * Stub for the «via partner» channel — submission through a paid intermediary
 * like Скала-ЕПГУ, Контур.ФМС, or similar.
 *
 * This is the easiest entry for an SMB hotel without its own ЭЦП: the partner
 * holds the certificate + соглашение with МВД, hotel just hands them the
 * payload. Real impl in M8.A targets Скала-ЕПГУ as the primary partner per
 * project_epgu_integration_pending.md memory.
 *
 * Different partners have different APIs but all expose the same conceptual
 * shape (reserve → push → poll). The interface boundary is identical.
 */
import {
	type EpguOrderRequest,
	type EpguOrderResponse,
	type EpguPushRequest,
	type EpguPushResponse,
	type EpguStatusRequest,
	type EpguStatusResponse,
	type EpguTransport,
	EpguTransportNotImplementedError,
} from './types.ts'

export interface ProxyViaPartnerTransportOptions {
	readonly partner: 'skala-epgu' | 'kontur-fms' | 'saby-resident'
	readonly endpoint: string
	readonly apiKey: string
}

export function createProxyViaPartnerTransport(
	opts: ProxyViaPartnerTransportOptions,
): EpguTransport {
	void opts // referenced via the partner's wire impl in M8.A
	return {
		channel: 'proxy-via-partner',
		async reserveOrder(_req: EpguOrderRequest): Promise<EpguOrderResponse> {
			throw new EpguTransportNotImplementedError('proxy-via-partner', 'reserveOrder')
		},
		async pushArchive(_req: EpguPushRequest): Promise<EpguPushResponse> {
			throw new EpguTransportNotImplementedError('proxy-via-partner', 'pushArchive')
		},
		async getStatus(_req: EpguStatusRequest): Promise<EpguStatusResponse> {
			throw new EpguTransportNotImplementedError('proxy-via-partner', 'getStatus')
		},
	}
}
