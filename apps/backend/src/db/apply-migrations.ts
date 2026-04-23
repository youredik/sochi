/**
 * YDB schema migration runner.
 *
 * Design choices (different from stankoff-v2's version; see memory
 * `feedback_aggressive_delegacy.md` — reference, not gospel):
 *   - Track applied migrations in a `_migration_history` table so re-runs are
 *     true no-ops, not "run everything again and hope DDL is idempotent".
 *     Future `ALTER TABLE … ADD INDEX` migrations are NOT idempotent without
 *     tracking; the stankoff-v2 runner silently swallows errors, which is
 *     the exact polumera we're avoiding.
 *   - Checksum each migration file. If a previously-applied migration has
 *     mutated content, abort with a loud error instead of silently drifting.
 *     DDL must be immutable history.
 *   - Fail fast on any DDL error (no try/catch/continue). Caller sees the real
 *     error and fixes the migration, not a silent inconsistent DB.
 *
 * Usage:
 *   node apps/backend/src/db/apply-migrations.ts
 *
 * Env: YDB_CONNECTION_STRING (default: grpc://localhost:2236/local).
 *
 * Safety:
 *   - Applies migrations sorted by filename (NNNN-name.sql convention).
 *   - Uses `sql.unsafe` ONLY because DDL cannot use bound parameters. File
 *     contents are developer-authored, never user input.
 */
import { createHash } from 'node:crypto'
import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { AnonymousCredentialsProvider } from '@ydbjs/auth/anonymous'
import { Driver } from '@ydbjs/core'
import { query } from '@ydbjs/query'

const thisDir = dirname(fileURLToPath(import.meta.url))
const migrationsDir = join(thisDir, 'migrations')
const connStr = process.env.YDB_CONNECTION_STRING ?? 'grpc://localhost:2236/local'

const driver = new Driver(connStr, {
	credentialsProvider: new AnonymousCredentialsProvider(),
})

// `driver.ready` returns as soon as the gRPC handshake succeeds, which is
// earlier than when YDB is ready to accept DDL on a fresh boot. We poll
// `SELECT 1` with a 30s budget so `infra:reset` (down -v → up → migrate) is
// a single script, not two steps with a manual wait between them.
await driver.ready(AbortSignal.timeout(30_000))
const sql = query(driver)

const bootDeadline = Date.now() + 30_000
while (true) {
	try {
		await sql<[{ ok: number }]>`SELECT 1 AS ok`.isolation('snapshotReadOnly').idempotent(true)
		break
	} catch (err) {
		if (Date.now() > bootDeadline) {
			console.error('YDB did not accept queries within 30s — aborting.')
			throw err
		}
		await new Promise((r) => setTimeout(r, 500))
	}
}

// 1. Bootstrap the history table. `Datetime` (seconds) is fine for migration
//    provenance — we don't need microsecond precision here.
await sql`
	CREATE TABLE IF NOT EXISTS \`_migration_history\` (
		name Utf8 NOT NULL,
		checksum Utf8 NOT NULL,
		appliedAt Datetime NOT NULL,
		PRIMARY KEY (name)
	)
`

// 2. Snapshot what's already applied (name → checksum).
const [appliedRows = []] = await sql<
	[{ name: string; checksum: string }]
>`SELECT name, checksum FROM \`_migration_history\``
	.isolation('snapshotReadOnly')
	.idempotent(true)
const applied = new Map(appliedRows.map((r) => [r.name, r.checksum]))

// 3. Discover migration files.
const files = readdirSync(migrationsDir)
	.filter((f) => f.endsWith('.sql'))
	.sort()

if (files.length === 0) {
	console.log(`No migrations found in ${migrationsDir}`)
	await driver.close()
	process.exit(0)
}

console.log(`Migrations discovered: ${files.length} (target: ${connStr})`)

/**
 * Split a multi-statement SQL file on top-level `;`. YDB Query Service does
 * not accept multiple DDL statements in one request, so we dispatch each
 * statement separately.
 *
 * Comment handling: strips `-- …` inline and full-line comments before split
 * so semicolons inside comments don't break the parse. Does NOT handle
 * semicolons inside string literals; DDL has no legitimate need for them.
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

let applyCount = 0
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
		console.log(`  · ${file} (already at HEAD)`)
		continue
	}

	const statements = splitStatements(content)
	console.log(`  ▸ ${file} — applying ${statements.length} statement(s)`)
	for (const stmt of statements) {
		await sql`${sql.unsafe(stmt)}`
	}

	await sql`
		UPSERT INTO \`_migration_history\` (name, checksum, appliedAt)
		VALUES (${file}, ${checksum}, ${new Date()})
	`
	console.log(`  ✓ ${file}`)
	applyCount++
}

console.log(
	applyCount === 0
		? `All ${files.length} migration(s) already applied.`
		: `Applied ${applyCount} new migration(s); ${files.length - applyCount} already at HEAD.`,
)

await driver.close()
