/**
 * Structured frontend logger — pino-shaped `{ ts, level, msg, ctx }`.
 *
 * Complementary to OTel tracing (features/observability/setup-otel.ts):
 *   - OTel ships SPANS to Yandex Monium (what happened + timing + trace id)
 *   - logger ships EVENTS + diagnostics (app-level context, error detail)
 *
 * Dev transport = console; prod transport (wired in M5f) = fetch → backend
 * `/api/logs` → Yandex Cloud Logging (152-ФЗ residency). Transport swap is
 * a one-line change when the prod target is ready — records carry stable
 * shape now so grep/jq queries written today still match prod format.
 */

type LogLevel = 'debug' | 'info' | 'warn' | 'error'

const LEVEL_ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 }
const MIN_LEVEL: LogLevel = import.meta.env.DEV ? 'debug' : 'info'

function emit(level: LogLevel, msg: string, ctx?: Record<string, unknown>): void {
	if (LEVEL_ORDER[level] < LEVEL_ORDER[MIN_LEVEL]) return
	const record = {
		ts: new Date().toISOString(),
		level,
		msg,
		...(ctx ? { ctx } : {}),
	}
	const method =
		level === 'error'
			? console.error
			: level === 'warn'
				? console.warn
				: level === 'info'
					? console.info
					: console.debug
	method(`[${level}]`, record.msg, record.ctx ?? {})
}

export const logger = {
	debug: (msg: string, ctx?: Record<string, unknown>) => emit('debug', msg, ctx),
	info: (msg: string, ctx?: Record<string, unknown>) => emit('info', msg, ctx),
	warn: (msg: string, ctx?: Record<string, unknown>) => emit('warn', msg, ctx),
	error: (msg: string, ctx?: Record<string, unknown>) => emit('error', msg, ctx),
}
