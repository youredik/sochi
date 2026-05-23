import pino from 'pino'
import { env } from './env.ts'

/**
 * Defense-in-depth redaction paths (P2.5 hardening, 2026-05-19).
 *
 * Pino redact applies BEFORE serialization: matching paths replaced с `[Redacted]`.
 * Use case: catch accidental sensitive-data leaks (PII / credentials / OCR raw
 * bytes) если developer forgets к sanitize a log call.
 *
 * **NOT** a substitute for not-logging-sensitive-data в the first place — we
 * design log calls к not include sensitive fields (current code does so).
 * But canon (Pino docs Q2 2026 + 152-ФЗ guidance) mandates explicit redact list
 * to catch future mistakes.
 *
 * Wildcards have ~50% overhead vs exact paths; use sparingly. The patterns here
 * are exact-path где possible + few targeted wildcards для known PII fields.
 */
const REDACT_PATHS = [
	// Auth / credentials (payment + vision providers)
	'req.headers.authorization',
	'req.headers.Authorization',
	'req.headers["x-folder-id"]',
	'req.headers["X-Folder-Id"]',
	'*.apiKey',
	'*.secretKey',
	// PCI: payment method PAN / CVV (last4 OK to keep, full PAN must NEVER appear)
	'*.payment_method_data.card.number',
	'*.payment_method_data.card.cvc',
	'*.card.number',
	'*.card.cvc',
	// 152-ФЗ: passport / OCR raw bytes
	'*.bytes', // raw image bytes argument к OCR adapter
	'*.content', // base64 body field в request к Yandex Vision
	'*.passport',
	'*.fullText', // raw OCR output text
	'*.imageBase64', // route body field (frontend → backend)
	'*.archive', // route handler local var (Uint8Array from base64 decode)
	'*.inputObjectKey', // S3 object key — adversarial reconstruction risk
	// 152-ФЗ: passport entities — scoped к `entities.*` чтобы НЕ redact'ить
	// unrelated `name`/`surname` поля в booking/property logs. Round 3
	// security review insight 2026-05-22.
	'*.entities.name',
	'*.entities.surname',
	'*.entities.middleName',
	'*.entities.gender',
	'*.entities.birthDate',
	'*.entities.birthPlace',
	'*.entities.documentNumber',
	'*.entities.issueDate',
	'*.entities.expirationDate',
	'*.entities.citizenshipIso3',
	'*.entities', // top-level fallback если объект entities целиком в log
	// 152-ФЗ: национальность из паспорта = special category ст.10
	'*.detectedCountryIso3',
	'*.citizenshipIso3',
	'*.rawResponseJson', // full Yandex Vision response may contain entities
	// 152-ФЗ: PII contact fields
	'*.email',
	'*.phone',
	'*.inn',
	'*.snils',
	// PCI: receipt PII at line level
	'*.receipt.customer.email',
	'*.receipt.customer.phone',
] as const

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
 *
 * P2.5: explicit redact paths defend against PII / credential leaks (152-ФЗ,
 * PCI DSS 4.0.1 Req 10). See `REDACT_PATHS` const for the canonical list.
 */
export const logger = pino({
	level: env.LOG_LEVEL,
	redact: {
		paths: [...REDACT_PATHS],
		censor: '[Redacted]',
	},
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
