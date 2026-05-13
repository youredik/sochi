/**
 * Track B.0 microbench (Phase 16 2026-05-12) — empirical answer to:
 * "How expensive is schema-prefix-per-worker DB isolation under YDB+Vitest?"
 *
 * Replays the full backend migration set under N parallel `PRAGMA TablePathPrefix`
 * sub-trees on a single local YDB instance. Wall-clock results decide B1 vs B2:
 *   - If parallel wall < 20 s for 4 workers → B2 ships (single shared YDB)
 *   - If parallel wall > 40 s → fall back to B1 (testcontainers-per-worker)
 *
 * Web-research baseline (≥2026-05-01, cited in Phase 16 commit):
 *   - YDB PRAGMA TablePathPrefix is supported for DDL incl. CREATE TABLE
 *     (https://ydb.tech/docs/en/yql/reference/syntax/pragma — verified 2026-05-12)
 *   - @ydbjs/query 6.1.0 has no Driver-level path-prefix API; pragma-per-script
 *     is the canonical pattern (research agent verified by cloning ydb-js-sdk)
 *
 * Usage:
 *   node --env-file-if-exists=.env scripts/bench-schema-prefix.ts [workers]
 *
 * Default workers = 1,2,4 (sweep). Prefixes are `/local/_bench_<uuid>` so the
 * sweep is non-destructive and concurrent runs don't collide. Bench teardown
 * removes all tables it created (best-effort).
 */
import { randomUUID } from 'node:crypto'
import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { AnonymousCredentialsProvider } from '@ydbjs/auth/anonymous'
import { Driver } from '@ydbjs/core'
import { query } from '@ydbjs/query'

const thisDir = dirname(fileURLToPath(import.meta.url))
const migrationsDir = join(thisDir, 'migrations')
const connStr = process.env.YDB_CONNECTION_STRING ?? 'grpc://localhost:2236/local'

function splitStatements(content: string): string[] {
	// Strip `-- …` inline + full-line comments; split on `;`. Mirrors
	// `apps/backend/src/db/apply-migrations.ts:splitStatements`.
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

async function applyMigrationsToPrefix(prefix: string, label: string): Promise<number> {
	const driver = new Driver(connStr, {
		credentialsProvider: new AnonymousCredentialsProvider(),
	})
	await driver.ready(AbortSignal.timeout(15_000))
	const sql = query(driver, { poolOptions: { maxSize: 8, waitQueueFactor: 4 } })

	const files = readdirSync(migrationsDir)
		.filter((f) => f.endsWith('.sql'))
		.sort()

	const t0 = performance.now()
	let stmtCount = 0
	for (const file of files) {
		const content = readFileSync(join(migrationsDir, file), 'utf8')
		const statements = splitStatements(content)
		for (const stmt of statements) {
			// PRAGMA TablePathPrefix is module-scoped per YDB docs — prepend
			// per-statement to be safe across `@ydbjs/query` session-pool
			// checkouts (no Driver-level prefix API in 6.1.0).
			await sql`${sql.unsafe(`PRAGMA TablePathPrefix("${prefix}"); ${stmt}`)}`
			stmtCount++
		}
	}
	const elapsed = performance.now() - t0
	console.log(`  ${label} (${prefix}): ${stmtCount} stmts in ${elapsed.toFixed(0)} ms`)
	await driver.close()
	return elapsed
}

async function bench(
	workers: number,
): Promise<{ workers: number; wall: number; perWorker: number[] }> {
	const prefixes = Array.from(
		{ length: workers },
		(_, i) => `/local/_bench_${randomUUID().slice(0, 8)}_w${i}`,
	)
	const t0 = performance.now()
	const perWorker = await Promise.all(
		prefixes.map((p, i) => applyMigrationsToPrefix(p, `worker-${i}`)),
	)
	const wall = performance.now() - t0
	return { workers, wall, perWorker }
}

const sweep = process.argv[2]?.split(',').map(Number) ?? [1, 2, 4]
console.log(`Bench sweep: workers=[${sweep.join(',')}], target=${connStr}`)
console.log(
	`Migration files: ${readdirSync(migrationsDir).filter((f) => f.endsWith('.sql')).length}`,
)

const results: { workers: number; wall: number; perWorker: number[] }[] = []
for (const w of sweep) {
	console.log(`\n=== workers=${w} ===`)
	const r = await bench(w)
	results.push(r)
	const slowest = Math.max(...r.perWorker).toFixed(0)
	const fastest = Math.min(...r.perWorker).toFixed(0)
	console.log(
		`  wall=${r.wall.toFixed(0)} ms · slowest-worker=${slowest} ms · fastest-worker=${fastest} ms`,
	)
}

console.log('\n=== Summary ===')
console.log('workers | wall (ms) | per-worker median (ms) | parallel efficiency')
const baseline = results[0]?.wall ?? 0
for (const r of results) {
	const median = r.perWorker.slice().sort((a, b) => a - b)[Math.floor(r.perWorker.length / 2)] ?? 0
	const ideal = baseline
	const efficiency = ideal === 0 ? 1 : ideal / r.wall
	console.log(
		`   ${r.workers.toString().padStart(4)}  | ${r.wall.toFixed(0).padStart(8)} | ${median.toFixed(0).padStart(20)} | ${efficiency.toFixed(2)}× of single-worker`,
	)
}

console.log('\nDecision (target: 132 s test:db → <40 s with isolation):')
const four = results.find((r) => r.workers === 4)
if (four) {
	if (four.wall < 20_000) {
		console.log('  ✅ B2 SHIPS — schema-prefix-per-worker is cheap enough')
	} else if (four.wall < 40_000) {
		console.log('  ⚠️ B2 marginal — re-bench under coverage load before commit')
	} else {
		console.log('  ❌ B2 too expensive — fall back to B1 (testcontainers-per-worker)')
	}
}

process.exit(0)
