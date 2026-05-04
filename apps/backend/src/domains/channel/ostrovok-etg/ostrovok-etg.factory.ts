/**
 * Ostrovok ETG factory — M10 / A7.4.
 *
 * Wires per-tenant ETG Mock + HTTP attempt handler в channelFactory.
 * Live-flip: swap factory body to instantiate raw HTTP client with Basic Auth
 * via YC Lockbox creds (ETG SDK does not exist on npm — confirmed empirical 2026-05-04).
 */

import { logger } from '../../../logger.ts'
import type { ChannelFactory } from '../channel.factory.ts'
import { createOstrovokEtgMock } from './ostrovok-etg-mock.ts'

export interface OstrovokEtgRegistrationOptions {
	readonly demoPropertyId?: string
	readonly mode?: 'sandbox' | 'live'
}

export function registerOstrovokEtgWithChannelFactory(
	channelFactory: ChannelFactory,
	opts: OstrovokEtgRegistrationOptions = {},
): void {
	const demoPropertyId = opts.demoPropertyId ?? 'demo-prop-sirius-main'
	const mode = opts.mode ?? 'sandbox'

	channelFactory.registerAdapterFactory('ETG', async ({ organizationId }) => {
		return createOstrovokEtgMock({
			tenantId: organizationId,
			propertyId: demoPropertyId,
			mode,
		})
	})

	channelFactory.registerHttpAttempt('ETG', async ({ tenantId, eventType }) => {
		try {
			const adapter = await channelFactory.resolveAdapter({
				organizationId: tenantId,
				channelId: 'ETG',
			})
			void adapter
			switch (eventType) {
				case 'app.sochi.channel.booking.created.v1':
				case 'app.sochi.channel.booking.cancelled.v1':
				case 'app.sochi.channel.ari.delta.v1':
					return { ok: true, httpStatus: 200 }
				default:
					return {
						ok: false,
						httpStatus: 400,
						errorMessage: `unknown_event_type: ${eventType}`,
					}
			}
		} catch (err) {
			logger.error({ err, tenantId, eventType }, 'OstrovokEtg HTTP attempt unexpected error')
			return {
				ok: false,
				httpStatus: null,
				errorMessage: err instanceof Error ? err.message : 'unknown_error',
			}
		}
	})
}
