/**
 * Stub for the direct ГОСТ TLS channel to gosuslugi.ru.
 *
 * M8.0 prep: interface fully wired, methods throw `EpguTransportNotImplementedError`
 * at call time. Real impl in M8.A — uses КриптоПро CSP, ГОСТ Р 34.10-2012
 * certificates, and the SMEV4 wrapper documented in plans/research/epgu-rkl.md §2.
 *
 * The point of this stub is to let `app.ts` wiring AND adapter registry
 * registration happen now (M8.0), so when M8.A lands the only edit needed
 * is `createGostTlsTransport` body — no public API changes.
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

export interface GostTlsTransportOptions {
	/**
	 * Production endpoint base. Sandbox — see SVCDEV beta.
	 */
	readonly endpoint: string
	/**
	 * Path or PEM contents of the КЭП (УКЭП) certificate. Real impl will
	 * validate it during construction; stub stores and ignores.
	 */
	readonly certificate: string
	/**
	 * `supplierGid` issued by МВД at the «Соглашение об информационном
	 * взаимодействии» step (research/epgu-rkl.md §7).
	 */
	readonly supplierGid: string
}

export function createGostTlsTransport(_opts: GostTlsTransportOptions): EpguTransport {
	return {
		channel: 'gost-tls',
		async reserveOrder(_req: EpguOrderRequest): Promise<EpguOrderResponse> {
			throw new EpguTransportNotImplementedError('gost-tls', 'reserveOrder')
		},
		async pushArchive(_req: EpguPushRequest): Promise<EpguPushResponse> {
			throw new EpguTransportNotImplementedError('gost-tls', 'pushArchive')
		},
		async getStatus(_req: EpguStatusRequest): Promise<EpguStatusResponse> {
			throw new EpguTransportNotImplementedError('gost-tls', 'getStatus')
		},
	}
}
