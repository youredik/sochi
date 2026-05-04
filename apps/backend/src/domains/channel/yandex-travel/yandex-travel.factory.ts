/**
 * Yandex.Travel factory — M10 / A7.3.
 *
 * Wires per-tenant YT Mock adapter (Bnovo CM passthrough emulation) +
 * HTTP attempt handler в channelFactory.
 *
 * Live-flip path: swap factory body to instantiate a Bnovo HTTP client
 * (signed creds via YC Lockbox per D29). YT direct API self-build is FORBIDDEN
 * (breach of YT partner agreement per D6 + R2 #F4 research).
 */

import { logger } from '../../../logger.ts'
import type { ChannelFactory } from '../channel.factory.ts'
import { createYandexTravelMock } from './yandex-travel-mock.ts'

export interface YandexTravelRegistrationOptions {
	readonly demoPropertyId?: string
}

export function registerYandexTravelWithChannelFactory(
	channelFactory: ChannelFactory,
	opts: YandexTravelRegistrationOptions = {},
): void {
	const demoPropertyId = opts.demoPropertyId ?? 'demo-prop-sirius-main'

	channelFactory.registerAdapterFactory('YT', async ({ organizationId }) => {
		return createYandexTravelMock({
			tenantId: organizationId,
			propertyId: demoPropertyId,
		})
	})

	channelFactory.registerHttpAttempt('YT', async ({ tenantId, eventType }) => {
		try {
			const adapter = await channelFactory.resolveAdapter({
				organizationId: tenantId,
				channelId: 'YT',
			})
			void adapter
			switch (eventType) {
				case 'app.sochi.channel.ari.delta.v1':
				case 'app.sochi.channel.booking.created.v1':
				case 'app.sochi.channel.booking.cancelled.v1':
					return { ok: true, httpStatus: 200 }
				default:
					return {
						ok: false,
						httpStatus: 400,
						errorMessage: `unknown_event_type: ${eventType}`,
					}
			}
		} catch (err) {
			logger.error({ err, tenantId, eventType }, 'YandexTravel HTTP attempt unexpected error')
			return {
				ok: false,
				httpStatus: null,
				errorMessage: err instanceof Error ? err.message : 'unknown_error',
			}
		}
	})
}
