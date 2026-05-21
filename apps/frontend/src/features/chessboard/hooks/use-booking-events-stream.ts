import type {
	BookingChannelCode,
	SseBookingEventPayload,
	SseShutdownPayload,
	SseStalePayload,
} from '@horeca/shared'
import { useQueryClient } from '@tanstack/react-query'
import { useEffect } from 'react'
import { toast } from 'sonner'
import { getApiBaseUrl } from '../../../lib/api-base-url.ts'
import { useCurrentUserId } from '../../../lib/use-can'
import { logger } from '../../../lib/logger'

/**
 * G10 (2026-05-16) — frontend SSE client per R1+R2 ≥ 2026-05-16 canon.
 *
 * Subscribes к `GET /api/v1/properties/:propertyId/events?stream=bookings`
 * via browser-native `EventSource`. Auth via `withCredentials: true`
 * (cookie) — EventSource spec disallows custom headers.
 *
 * Lifecycle events handling:
 *   - `ready` — connection established; clear «reconnecting» toast
 *   - `booking.created/updated/cancelled` — RU toast (id-dedup) + invalidate
 *     queries. Suppress если `actorUserId === currentUserId` (self-echo).
 *   - `stale` — full refetch ALL booking queries (server signal: buffer
 *     rotated / queue overflow / unknown since-id)
 *   - `shutdown` — toast «Соединение прервано» + EventSource auto-reconnect
 *     after `reconnectInMs` (browser native + `retry: 5000` server hint)
 *
 * Toast canon: `toast(text, {id: 'booking-' + bookingId})` — rapid edits
 * collapse в одно toast. Bnovo wording style. NO sound (operator в
 * наушниках с гостем).
 *
 * Auto-reconnect: browser-native via `EventSource` + server `retry: 5000`.
 * No custom exponential backoff library — D-G10.4 canon.
 */

// Same-origin canon 2026-05-21 — shared helper.
const API_URL = getApiBaseUrl()

interface UseBookingEventsStreamOptions {
	/** propertyId к subscribe; null disables (no SSE while propertyId loading). */
	propertyId: string | null
	/** Disable for tests / SSR — defaults к true когда propertyId present. */
	enabled?: boolean
}

/** Exhaustive Record<BookingChannelCode, string>. Adding a new channel
 *  к the enum upstream → typecheck fails here until label provided. Per
 *  `[[no-hardcoding]]` canon (typecheck-safe vs fallback-к-raw-code). */
const CHANNEL_LABEL_RU: Record<BookingChannelCode, string> = {
	direct: 'Прямое бронирование',
	walkIn: 'С ресепшн',
	yandexTravel: 'Яндекс Путешествия',
	ostrovok: 'Островок',
	travelLine: 'TravelLine',
	bnovo: 'Bnovo',
	bookingCom: 'Booking.com',
	expedia: 'Expedia',
	airbnb: 'Airbnb',
}

function channelLabel(code: BookingChannelCode): string {
	return CHANNEL_LABEL_RU[code]
}

function bookingNumber(payload: SseBookingEventPayload): string {
	if (payload.externalId) return payload.externalId
	// Fallback: last 6 chars of typeid (after `book_` prefix, 26-char base32).
	return payload.bookingId.slice(-6).toUpperCase()
}

export function useBookingEventsStream(opts: UseBookingEventsStreamOptions): void {
	const { propertyId, enabled = true } = opts
	const queryClient = useQueryClient()
	const currentUserId = useCurrentUserId()

	useEffect(() => {
		if (!enabled || !propertyId) return

		const url = `${API_URL}/api/v1/properties/${propertyId}/events?stream=bookings`
		const source = new EventSource(url, { withCredentials: true })

		// `ready` — initial frame после handshake. Clears any «reconnecting» toast.
		source.addEventListener('ready', () => {
			toast.dismiss('sse-connection')
		})

		// `booking.*` — domain event. Toast (id-dedup, own-user suppress) +
		// queryClient.invalidateQueries (full refetch keeps cache consistent).
		const handleBookingEvent =
			(eventType: 'created' | 'updated' | 'cancelled') => (messageEvent: MessageEvent<string>) => {
				try {
					const payload = JSON.parse(messageEvent.data) as SseBookingEventPayload
					if (currentUserId && payload.actorUserId === currentUserId) {
						// Own-user write — REST response already updated state;
						// suppress self-echo toast.
						void queryClient.invalidateQueries({ queryKey: ['bookings', propertyId] })
						return
					}
					const num = bookingNumber(payload)
					const sub = channelLabel(payload.channelCode)
					if (eventType === 'cancelled') {
						toast.error(`Отменена бронь №${num}`, {
							id: `booking-${payload.bookingId}`,
							description: sub,
						})
					} else {
						const verb = eventType === 'created' ? 'Создана' : 'Изменена'
						toast.success(`${verb} бронь №${num}`, {
							id: `booking-${payload.bookingId}`,
							description: sub,
						})
					}
					void queryClient.invalidateQueries({ queryKey: ['bookings', propertyId] })
					// Also invalidate any availability queries (G9 surface 1).
					void queryClient.invalidateQueries({ queryKey: ['availability-check'] })
				} catch (err) {
					logger.error('SSE booking event parse failed', { err })
				}
			}

		source.addEventListener('booking.created', handleBookingEvent('created') as EventListener)
		source.addEventListener('booking.updated', handleBookingEvent('updated') as EventListener)
		source.addEventListener('booking.cancelled', handleBookingEvent('cancelled') as EventListener)

		// `stale` — server signals client cache may be inconsistent. Full
		// refetch ALL booking queries (R2 ≥ 2026-05-16 canon: refetch wins).
		source.addEventListener('stale', (messageEvent) => {
			try {
				const payload = JSON.parse((messageEvent as MessageEvent<string>).data) as SseStalePayload
				logger.warn('SSE cache stale', { reason: payload.reason })
			} catch {
				// payload parse failure non-fatal — still invalidate
			}
			void queryClient.invalidateQueries({ queryKey: ['bookings', propertyId] })
			void queryClient.invalidateQueries({ queryKey: ['property-blocks', propertyId] })
			void queryClient.invalidateQueries({ queryKey: ['availability-check'] })
		})

		// `shutdown` — graceful server shutdown signal. EventSource will
		// auto-reconnect (browser native + server `retry: 5000` directive).
		// We surface a toast so operator knows brief connection hiccup is normal.
		source.addEventListener('shutdown', (messageEvent) => {
			try {
				const payload = JSON.parse(
					(messageEvent as MessageEvent<string>).data,
				) as SseShutdownPayload
				logger.info('SSE shutdown signal', { reconnectInMs: payload.reconnectInMs })
			} catch {
				// non-fatal
			}
			toast.info('Соединение с сервером перезапускается', {
				id: 'sse-connection',
				description: 'Восстанавливаем real-time обновления…',
			})
		})

		// Transport error — browser will auto-reconnect via `retry:` directive.
		// Surface toast on FIRST error; clears когда `ready` fires after reconnect.
		source.addEventListener('error', () => {
			if (source.readyState === EventSource.CLOSED) {
				toast.error('Связь с сервером прервана', {
					id: 'sse-connection',
					description: 'Попробуйте обновить страницу.',
				})
			} else {
				toast.warning('Восстанавливаем связь с сервером…', {
					id: 'sse-connection',
				})
			}
		})

		return () => {
			source.close()
			toast.dismiss('sse-connection')
		}
	}, [propertyId, enabled, queryClient, currentUserId])
}
