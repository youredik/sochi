/**
 * YDB schema migration applier — re-usable from CLI script + backend startup.
 *
 * Canonical Q2 2026 pattern для serverless containers: backend runs migrations
 * on cold start as idempotent init step. Subsequent starts (already-at-HEAD)
 * are ~50ms reads from `_migration_history`. New migration land deploy = first
 * container instance applies, subsequent instances skip via checksum match.
 *
 * Race condition note: parallel cold-starts на N replicas → race на initial
 * apply. YDB UPSERT on `_migration_history` prevents tracking duplication, but
 * raw DDL (`CREATE TABLE`) на active migration would error для loser(s).
 * Acceptable для single-replica demo deployment; revisit с advisory lock when
 * scaling beyond min_instances=2.
 */

import { createHash } from 'node:crypto'
import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { QueryClient } from '@ydbjs/query'

const thisDir = dirname(fileURLToPath(import.meta.url))
const migrationsDir = join(thisDir, 'migrations')

export interface MigrationRunResult {
	totalMigrations: number
	newlyApplied: number
	alreadyAtHead: number
}

export interface ApplyMigrationsOpts {
	sql: QueryClient
	log?: (msg: string) => void
}

/**
 * Apply all pending migrations к YDB. Idempotent — already-applied migrations
 * verified by checksum and skipped. Throws on:
 *   - checksum mismatch (mutated migration — schema history violation)
 *   - DDL execution failure (let caller decide retry/abort)
 *
 * Compatible с empty database (creates `_migration_history` table first).
 */
export async function applyMigrations(opts: ApplyMigrationsOpts): Promise<MigrationRunResult> {
	const { sql, log = console.log } = opts

	// 1. Bootstrap the history table.
	await sql`
		CREATE TABLE IF NOT EXISTS \`_migration_history\` (
			name Utf8 NOT NULL,
			checksum Utf8 NOT NULL,
			appliedAt Datetime NOT NULL,
			PRIMARY KEY (name)
		)
	`

	// 2. Snapshot what's already applied.
	const [appliedRows = []] = await sql<[{ name: string; checksum: string }]>`
		SELECT name, checksum FROM \`_migration_history\`
	`
		.isolation('snapshotReadOnly')
		.idempotent(true)
	const applied = new Map(appliedRows.map((r) => [r.name, r.checksum]))

	// 3. Discover migration files.
	const files = readdirSync(migrationsDir)
		.filter((f) => f.endsWith('.sql'))
		.sort()

	if (files.length === 0) {
		log(`No migrations found in ${migrationsDir}`)
		return { totalMigrations: 0, newlyApplied: 0, alreadyAtHead: 0 }
	}

	// 4. Apply pending migrations.
	let newlyApplied = 0
	let alreadyAtHead = 0
	for (const file of files) {
		const content = readFileSync(join(migrationsDir, file), 'utf8')
		const checksum = createHash('sha256').update(content).digest('hex').slice(0, 16)

		const priorChecksum = applied.get(file)
		if (priorChecksum !== undefined) {
			if (priorChecksum !== checksum) {
				throw new Error(
					`Migration ${file} was mutated: recorded checksum ${priorChecksum}, file checksum ${checksum}. ` +
						`Schema history is immutable — add a new migration rather than editing an applied one.`,
				)
			}
			alreadyAtHead++
			continue
		}

		const statements = splitStatements(content)
		log(`  ▸ ${file} — applying ${statements.length} statement(s)`)
		for (let i = 0; i < statements.length; i++) {
			const raw = statements[i]
			if (raw === undefined) continue // unreachable per for-bound, satisfies lint
			const stmt = applyServerlessCompat(raw)
			const stmtIdx = i + 1
			try {
				await executeWithSchemeRetry(sql, stmt, log, file, stmtIdx)
			} catch (err) {
				// Canon Q2 2026 observability (2026-05-19): YDB DDL is non-
				// transactional + SCHEME_ERROR (1030) is non-retryable in
				// @ydbjs/retry, so a single bad statement leaves partial state
				// AND the migration row is NOT inserted. Without statement-
				// scoped context the bare `Fatal startup error` line at the
				// `index.ts main()` catch loses the most useful diagnostics:
				// (a) the statement index inside the file, (b) the SQL text,
				// (c) YDBError's `issues[]` array (issueCode + position).
				// Re-throw enriched so the operator can act on the actual
				// SchemeShard rejection instead of guessing.
				// 4 KB cap — enough для full CREATE TABLE с 40-col schema + indexes
				// (largest stmt in our 0001-0060 corpus is ~3 KB).
				const stmtPreview = stmt.length > 4000 ? `${stmt.slice(0, 4000)}…[truncated]` : stmt
				const issuesJson = (() => {
					try {
						const e = err as { issues?: unknown }
						return e.issues ? JSON.stringify(e.issues, null, 2) : '<no issues array>'
					} catch {
						return '<issues serialize failed>'
					}
				})()
				const wrapped = new Error(
					`Migration ${file} failed at statement #${stmtIdx} of ${statements.length}.\n` +
						`Statement:\n${stmtPreview}\n` +
						`YDB issues:\n${issuesJson}\n` +
						`Underlying: ${(err as Error).message}`,
				)
				;(wrapped as Error & { cause?: unknown }).cause = err
				throw wrapped
			}
		}

		await sql`
			UPSERT INTO \`_migration_history\` (name, checksum, appliedAt)
			VALUES (${file}, ${checksum}, ${new Date()})
		`
		log(`  ✓ ${file}`)
		newlyApplied++
	}

	return { totalMigrations: files.length, newlyApplied, alreadyAtHead }
}

/**
 * Schema-ops rate-limit retry — canon Q2 2026 (verified 2026-05-19).
 *
 * YDB Serverless rate-limits the number of schema operations per time window.
 * Bulk migration runs (20+ DDL statements in one cold-start) hit:
 *
 *   GENERIC_ERROR (ExecError):
 *   "Request exceeded a limit on the number of schema operations,
 *    try again later."
 *
 * Это retryable — quota refills time-based. Without retry, container exits,
 * YC restarts, next boot resumes from the failed statement — but restart
 * storm + cold-start cost makes this slow (~30s per restart × N statements).
 *
 * Exponential backoff caps at 30s × 6 retries = ~3 min budget per stmt,
 * which is enough к pass the YDB schema quota refill (verified empirically
 * 2026-05-19: rate limit clears in 10-30s typically).
 *
 * Только rate-limit errors retried; SCHEME_ERROR (1030) и другие non-retryable
 * codes пробрасываются сразу (stankoff canon — fail-fast на user error).
 */
/**
 * Flatten YDBError nested issues structure into single searchable string.
 *
 * Canon Q2 2026 (2026-05-19 caught via adversarial-reading post-test-green):
 * @ydbjs/error YDBError exposes top-level `.message` ONLY as «SCHEME_ERROR,
 * Issues: ERROR(<code>): <category>» — the actionable phrase ("Column already
 * exists", "limit on the number of schema operations") lives 2-3 levels deep
 * в `issues[].issues[].issues[].message`. Halfmeasure trap: regex-match на
 * top-level message DOES NOT FIRE on real production errors — only on unit
 * test mocks (which incorrectly synthesized errors с the phrase at top).
 *
 * Walks issues recursively, concatenates all messages с « | » separator,
 * returns a flat string suitable для `.includes()` checks.
 */
export function flattenIssueMessages(err: unknown): string {
	if (err === null || err === undefined) return ''
	if (typeof err !== 'object') return String(err)
	const e = err as { message?: unknown; issues?: unknown }
	const parts: string[] = []
	if (typeof e.message === 'string') parts.push(e.message)
	if (Array.isArray(e.issues)) {
		for (const issue of e.issues) {
			const inner = flattenIssueMessages(issue)
			if (inner) parts.push(inner)
		}
	}
	return parts.join(' | ')
}

/**
 * Idempotent-error detection — canon Q2 2026 (stankoff apply-migrations.ts
 * lines 153-181, production-verified preprod 2026-04-22 / 2026-05-06).
 *
 * YDB DDL is non-transactional → a partial-apply leaves SCHEMA changes
 * committed but the `_migration_history` row never inserted. Next boot
 * re-runs the migration; statements like `ALTER TABLE … ADD COLUMN x` then
 * fail with "Column already exists" — semantically a no-op success, but
 * syntactically a hard SCHEME_ERROR. Stankoff canon: phrase-whitelist match
 * на known idempotent failures, log + skip, NEVER throw.
 *
 * Distinct from rate-limit retry: idempotent errors are SKIPPED (final), not
 * RETRIED (might succeed). Both checked в same catch arm.
 */
export function isIdempotentError(err: unknown): boolean {
	const msg = flattenIssueMessages(err)
	// stankoff phrase whitelist — verified Apr-May 2026 production:
	return (
		msg.includes('already exists') ||
		msg.includes('path exist') ||
		msg.includes('Duplicate consumer name') ||
		msg.includes('Path already exists')
	)
}

export async function executeWithSchemeRetry(
	sql: QueryClient,
	stmt: string,
	log: (m: string) => void,
	file: string,
	stmtIdx: number,
): Promise<void> {
	// Stankoff-v2 canon (production-verified preprod 2026-04-22, seed.ts:74-104):
	// linear backoff `30s + 15s × attempt`, 8 retries → total budget 10 min.
	// Aligned with YC Serverless schema-ops quota refill (30 ops/min, per-minute
	// leaky bucket — empirically clears in 30-60s windows). Go SDK v3.119.0
	// (2025-11-25) ships equivalent canon as `TypeSlow` backoff с 60s cap +
	// 10 retries default. JS @ydbjs/retry@6.2.0 has NO parity yet — applier-
	// level retry NECESSARY (not redundant) per canon research 2026-05-19.
	const MAX_RETRIES = 8
	let lastErr: unknown
	for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
		try {
			await sql`${sql.unsafe(stmt)}`
			if (attempt > 0) log(`  ↻ ${file}#${stmtIdx} succeeded after ${attempt} retry(ies)`)
			return
		} catch (err) {
			lastErr = err
			// Stankoff canon: idempotent failures (object already at target state)
			// are SKIPPED — partial-apply leaves DDL committed, history row not.
			// Replay safely no-ops. ALTER TABLE ADD COLUMN, ALTER TOPIC ADD
			// CONSUMER, CREATE TABLE без IF NOT EXISTS all rely on this.
			if (isIdempotentError(err)) {
				const flat = flattenIssueMessages(err)
				log(`  ↻ ${file}#${stmtIdx} idempotent skip (${flat.slice(0, 120)})`)
				return
			}
			const flatMsg = flattenIssueMessages(err)
			const isSchemeRateLimit = flatMsg.includes('limit on the number of schema operations')
			if (!isSchemeRateLimit || attempt === MAX_RETRIES) {
				throw err
			}
			// Linear 30,45,60,75,90,105,120,135s (stankoff exact).
			const delayMs = 30_000 + 15_000 * attempt
			log(
				`  ⟳ ${file}#${stmtIdx} schema-rate-limit hit, retry ${attempt + 1}/${MAX_RETRIES} в ${delayMs / 1000}s`,
			)
			await new Promise((r) => setTimeout(r, delayMs))
		}
	}
	throw lastErr
}

/**
 * YDB Serverless compatibility rewrite — canon Q2 2026 (verified 2026-05-19).
 *
 * Yandex Cloud Serverless YDB rejects CHANGEFEED topics whose retention does
 * not fit one of two tiers:
 *   Tier A: hours ∈ [0, 24],   storage_megabytes = 0           (in-memory)
 *   Tier B: hours ∈ [0, 168],  storage_megabytes ∈ [51200, 1048576]  (persistent)
 *
 * Empirical failure (issueCode 1060):
 *   "retention hours and storage megabytes must fit one of: ...
 *    provided values: hours 72, storage 0"
 *
 * Our migrations historically used `Interval("PT72H")` (canon на Dedicated YDB
 * + local-ydb Docker, where this works fine). To deploy ONE codebase к both
 * tiers without forking migration files, we rewrite `PT72H` → `PT24H` at
 * apply-time. Checksum tracking uses the ORIGINAL file content so:
 *   - already-applied migrations stay applied (history immutable)
 *   - new migrations apply with serverless-safe retention
 *   - Dedicated YDB users lose 48h replay window — acceptable for at-least-
 *     once consumer recovery (offset-based, not retention-based)
 *
 * **Code behavior** (immutable canon at this commit): rewrite is UNCONDITIONAL —
 * applies на любом deployment (Serverless OR Dedicated). Trade-off: Dedicated
 * users lose 48h replay window. Acceptable per stankoff canon (offset-based
 * recovery via _migration_history, retention is не load-bearing for correctness).
 * Если в будущем Dedicated production требует full 72h replay, add env gate
 * `YDB_TIER=dedicated` here с corresponding skip — **NOT implemented сейчас**.
 */
export function applyServerlessCompat(stmt: string): string {
	// Match Interval("PT<N>H") where N > 24. YC Serverless Tier A hard cap is
	// 24h; anything above falls к Tier B (requires 50GB+ storage allocation,
	// not exposed via YQL CHANGEFEED). Catches PT25H, PT48H, PT72H, PT168H...
	// — anything operator-set that violates Tier A automatically downgraded.
	return stmt.replace(/Interval\(\s*"PT(\d+)H"\s*\)/g, (match, hours) => {
		const h = Number(hours)
		return h > 24 ? 'Interval("PT24H")' : match
	})
}

/**
 * Split a multi-statement SQL file on top-level `;`. YDB Query Service does
 * not accept multiple DDL statements in one request, so we dispatch each
 * separately.
 */
function splitStatements(content: string): string[] {
	const stripped = content
		.split('\n')
		.map((line) => {
			const idx = line.indexOf('--')
			return idx === -1 ? line : line.slice(0, idx)
		})
		.join('\n')
	return stripped
		.split(';')
		.map((s) => s.trim())
		.filter((s) => s.length > 0)
}
