/**
 * Booking portal API helpers (M9.widget.5 / A3.4).
 *
 * Wraps backend endpoints от A3.1.b/c + A3.3:
 *   - GET  /api/public/booking/jwt/:jwt/render — magic-link verify (no consume)
 *   - POST /api/public/booking/jwt/:jwt/consume — consume + Set-Cookie
 *   - GET  /api/public/booking/guest-portal/:bookingId — booking details + cancel policy
 *   - POST /api/public/booking/guest-portal/:bookingId/cancel — cancel booking
 *
 * All calls use `credentials: 'include'` so __Host-guest_session cookie is sent
 * after consume (для guest-portal authenticated requests).
 */

const API_BASE = '/api/public/booking'

export interface MagicLinkRenderPayload {
	bookingId: string
	scope: 'view' | 'mutate'
	attemptsRemaining: number
	expiresAt: string
}

export interface MagicLinkConsumePayload {
	bookingId: string
	scope: 'view' | 'mutate'
}

export interface MagicLinkErrorPayload {
	error: {
		code:
			| 'MAGIC_LINK_INVALID'
			| 'MAGIC_LINK_EXPIRED'
			| 'MAGIC_LINK_FULLY_CONSUMED'
			| 'MAGIC_LINK_NOT_FOUND'
		message: string
	}
}

export type MagicLinkResult<T> =
	| { kind: 'ok'; data: T }
	| { kind: 'error'; status: number; code: MagicLinkErrorPayload['error']['code']; message: string }

export async function renderMagicLink(
	jwt: string,
): Promise<MagicLinkResult<MagicLinkRenderPayload>> {
	const res = await fetch(`${API_BASE}/jwt/${encodeURIComponent(jwt)}/render`, {
		method: 'GET',
		credentials: 'include',
	})
	const body = (await res.json()) as MagicLinkRenderPayload | MagicLinkErrorPayload
	if (!res.ok || 'error' in body) {
		const errPayload = body as MagicLinkErrorPayload
		return {
			kind: 'error',
			status: res.status,
			code: errPayload.error.code,
			message: errPayload.error.message,
		}
	}
	return { kind: 'ok', data: body }
}

export async function consumeMagicLink(
	jwt: string,
): Promise<MagicLinkResult<MagicLinkConsumePayload>> {
	const res = await fetch(`${API_BASE}/jwt/${encodeURIComponent(jwt)}/consume`, {
		method: 'POST',
		credentials: 'include',
	})
	const body = (await res.json()) as MagicLinkConsumePayload | MagicLinkErrorPayload
	if (!res.ok || 'error' in body) {
		const errPayload = body as MagicLinkErrorPayload
		return {
			kind: 'error',
			status: res.status,
			code: errPayload.error.code,
			message: errPayload.error.message,
		}
	}
	return { kind: 'ok', data: body }
}

export interface GuestPortalView {
	bookingId: string
	status: string
	checkIn: string /** ISO Date */
	checkOut: string
	nights: number
	guestsCount: number
	totalFormatted: string
	currency: string
	propertyName: string
	propertyAddress: string | null
	propertyPhone: string | null
}

export interface CancelPolicy {
	boundary: 'pre_checkin' | 'day_of_or_later'
	refundPercent: number
	maxChargeNights: number
	disclosure: string
}

export interface GuestPortalGetPayload {
	booking: GuestPortalView
	cancelPolicy: CancelPolicy
	scope: 'view' | 'mutate'
}

export interface GuestPortalErrorPayload {
	error: {
		code:
			| 'GUEST_SESSION_REQUIRED'
			| 'GUEST_SESSION_INVALID'
			| 'GUEST_SESSION_BOOKING_MISMATCH'
			| 'GUEST_SESSION_SCOPE_INSUFFICIENT'
			| 'BOOKING_NOT_FOUND'
			| 'BOOKING_CANCEL_FAILED'
		message: string
	}
}

export type GuestPortalResult<T> =
	| { kind: 'ok'; data: T }
	| {
			kind: 'error'
			status: number
			code: GuestPortalErrorPayload['error']['code']
			message: string
	  }

export async function getGuestPortal(
	bookingId: string,
): Promise<GuestPortalResult<GuestPortalGetPayload>> {
	const res = await fetch(`${API_BASE}/guest-portal/${encodeURIComponent(bookingId)}`, {
		method: 'GET',
		credentials: 'include',
	})
	const body = (await res.json()) as GuestPortalGetPayload | GuestPortalErrorPayload
	if (!res.ok || 'error' in body) {
		const errPayload = body as GuestPortalErrorPayload
		return {
			kind: 'error',
			status: res.status,
			code: errPayload.error.code,
			message: errPayload.error.message,
		}
	}
	return { kind: 'ok', data: body }
}

export interface CancelPayload {
	bookingId: string
	status: string
	cancelPolicy: Omit<CancelPolicy, 'disclosure'>
}

export async function cancelBooking(
	bookingId: string,
	reason: string,
): Promise<GuestPortalResult<CancelPayload>> {
	const res = await fetch(`${API_BASE}/guest-portal/${encodeURIComponent(bookingId)}/cancel`, {
		method: 'POST',
		credentials: 'include',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ reason }),
	})
	const body = (await res.json()) as CancelPayload | GuestPortalErrorPayload
	if (!res.ok || 'error' in body) {
		const errPayload = body as GuestPortalErrorPayload
		return {
			kind: 'error',
			status: res.status,
			code: errPayload.error.code,
			message: errPayload.error.message,
		}
	}
	return { kind: 'ok', data: body }
}
