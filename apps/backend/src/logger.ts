import pino from 'pino'
import { env } from './env.ts'

/**
 * Application-wide pino logger. Use this for startup, shutdown, and background
 * workers (anything outside a request lifecycle).
 *
 * Inside route handlers / middleware, prefer `c.var.logger` from hono-pino —
 * it carries the per-request `requestId` automatically.
 *
 * Yandex Cloud Logging expects uppercase severity labels (INFO, WARN, ERROR).
 * The `formatters.level` hook outputs the label instead of the numeric level,
 * which aligns with Cloud Logging + every major log aggregator.
 */
export const logger = pino({
	level: env.LOG_LEVEL,
	formatters: {
		level: (label) => ({ level: label.toUpperCase() }),
	},
	...(env.NODE_ENV === 'development' && {
		transport: {
			target: 'pino-pretty',
			options: {
				colorize: true,
				translateTime: 'HH:MM:ss.l',
				ignore: 'pid,hostname',
			},
		},
	}),
})
