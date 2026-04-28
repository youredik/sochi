// =============================================================================
// EpguTransport — channel-agnostic interface for ЕПГУ submission
// =============================================================================
//
// «Спецификация API ЕПГУ. Сервисы миграционного и регистрационного учётов
// для гостиниц» v1.3 (gu-st.ru, 19.12.2022) is the canonical contract.
// See plans/research/epgu-rkl.md for the full picture.
//
// Three known transport channels (M8.0 prep): we declare them as a discriminated
// union of factory implementations now so when M8.A wires the actual ЕПГУ
// adapter, switching the transport requires no business-logic change.
//
//   1. GostTLS       — direct HTTPS to gosuslugi.ru with ГОСТ Р 34.10-2012
//                      certificate (КриптоПро CSP). Current canonical channel
//                      for hotels per Контур / TravelLine guides.
//   2. SVOKS         — Защищённая Сеть передачи Данных Органов Госвласти.
//                      Anticipated mandate for 2027 (NOT confirmed in any
//                      published act on 27.04.2026 — see wave4-2027-anticipated.md).
//                      Stub now, real impl when/if mandate confirms.
//   3. ProxyViaPartner — submission via Скала-ЕПГУ / Контур.ФМС / similar
//                      paid intermediary. Easiest legal entry for an SMB
//                      hotel (no own ЭЦП needed at the start).
//
// Each impl handles the full 2-phase submit + polling lifecycle of the ЕПГУ
// API. The application service only knows about the abstract `EpguTransport`
// interface — it can swap implementations per-tenant or per-environment via
// the factory.
//
// =============================================================================

/**
 * Identifier of the transport channel an EPGU adapter is using.
 * Surfaced in audit log + /api/health/adapters.
 */
export type EpguChannel = 'gost-tls' | 'svoks' | 'proxy-via-partner'

/**
 * Phase 1 of the 2-phase ЕПГУ submission protocol.
 * Reserves an `orderId` server-side. Throws on transport failure.
 *
 * Real impl: `POST /gu-smev-api/api/gusmev/order` (see research/epgu-rkl.md §2.2).
 */
export interface EpguOrderRequest {
	readonly serviceCode: string // e.g. '10000103652' for ИГ постановка
	readonly targetCode: string // e.g. '-1000444103652'
	readonly regionCode: string // ФИАС UUID
}

export interface EpguOrderResponse {
	readonly orderId: string
}

/**
 * Phase 2 of the 2-phase ЕПГУ submission. Pushes the multipart archive
 * (req.xml + attach.xml + scans + .sig signatures) to the previously
 * reserved `orderId`.
 *
 * Real impl: `POST /gu-smev-api/api/gusmev/push/chunked`.
 */
export interface EpguPushRequest {
	readonly orderId: string
	readonly archive: Uint8Array // ZIP bytes
	readonly archiveFilename: string // e.g. 'arch_ip_10000103652.zip'
	readonly meta: {
		readonly region: string
		readonly serviceCode: string
		readonly targetCode: string
	}
}

export interface EpguPushResponse {
	readonly orderId: string
	readonly accepted: boolean
}

/**
 * Status poll. Real impl: `POST /gu-smev-api/api/gusmev/order/{orderId}` or
 * `GET /gu-smev-api/api/gusmev/order/getOrdersStatus`. Status codes mirror
 * the ЕПГУ status enum (see research/epgu-rkl.md §3.1):
 *   0=draft, 1=registered, 2=sent_to_authority, 3=executed (final),
 *   4=refused (final), 5=send_error, 9=cancellation_pending,
 *   10=cancelled (final), 14=awaiting_info, 15=requires_correction,
 *   17=submitted, 21=acknowledged, 22=delivery_error, 24=processing_error.
 */
export interface EpguStatusRequest {
	readonly orderId: string
}

export interface EpguStatusResponse {
	readonly orderId: string
	readonly statusCode: number
	readonly isFinal: boolean
	readonly reasonRefuse?: string // free-text from ИС МВД on refused/error
}

/**
 * Cancellation request. Initiates withdrawal of a previously submitted
 * notification (e.g., after booking cancellation, RKL false-positive resolved).
 *
 * Real impl: `POST /gu-smev-api/api/gusmev/order/{orderId}/cancel` with reason.
 * Pre-conditions:
 *   - orderId должен быть submitted (statusCode=17/21) или intermediate
 *     (14/15) — finalized rows (3/4/10) уже не cancelable
 *   - operator должен иметь permissions на отзыв (legal action)
 *
 * Behaviour:
 *   - Server-side ЕПГУ принимает cancel request → row переходит в
 *     statusCode=9 (cancellation_pending) intermediate
 *   - Followup poll цикл eventually advances row → statusCode=10
 *     (cancelled, FINAL) либо обратно в submitted/refused если
 *     cancel rejected (rare race с in-flight processing)
 */
export interface EpguCancelRequest {
	readonly orderId: string
	/** Operator-provided reason text (free-form, RU). */
	readonly reason: string
}

export interface EpguCancelResponse {
	readonly orderId: string
	readonly accepted: boolean
	/** Resulting status (typically 9 — cancellation_pending). */
	readonly statusCode: number
}

/**
 * Channel-agnostic ЕПГУ transport interface. M8.A's adapter implements
 * the application-level service over this transport.
 */
export interface EpguTransport {
	/** Identifier of the channel — for audit + /api/health/adapters. */
	readonly channel: EpguChannel
	/** Reserve order ID (phase 1). */
	reserveOrder(req: EpguOrderRequest): Promise<EpguOrderResponse>
	/** Push the signed archive (phase 2). */
	pushArchive(req: EpguPushRequest): Promise<EpguPushResponse>
	/** Poll the current status. Caller decides cadence. */
	getStatus(req: EpguStatusRequest): Promise<EpguStatusResponse>
	/** Cancel a submitted notification (M8.A.5.cancel). */
	cancelOrder(req: EpguCancelRequest): Promise<EpguCancelResponse>
}

/**
 * Marker error for transport calls invoked before the implementation is
 * wired. M8.0 stubs throw this — replaced with real implementations in
 * M8.A. NOT a runtime error — its presence in `pnpm test` output indicates
 * an early regression where someone tried to actually CALL the transport
 * before the M8.A wiring landed.
 */
export class EpguTransportNotImplementedError extends Error {
	override readonly name = 'EpguTransportNotImplementedError'
	constructor(channel: EpguChannel, method: string) {
		super(`EpguTransport.${method} not implemented for channel '${channel}' — wires up in M8.A`)
	}
}
