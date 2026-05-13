/**
 * Spike A — Bun 1.3.13 runtime compat smoke test (2026-05-12 Phase 16).
 *
 * Verifies: @ydbjs/auth + @ydbjs/core + @ydbjs/query work end-to-end under Bun.
 * Bun's @grpc/grpc-js compat is 95.25% of gRPC test suite per docs — this
 * empirically confirms whether OUR YDB workload is in the 95% or 5%.
 *
 * Usage:
 *   node_modules/.bin/bun apps/backend/src/db/spike-bun-ydb.ts
 *
 * Pass criteria: connects + runs SELECT + UPSERT + SELECT in <2s wall.
 */
import { AnonymousCredentialsProvider } from '@ydbjs/auth/anonymous'
import { Driver } from '@ydbjs/core'
import { query } from '@ydbjs/query'

const connStr = process.env.YDB_CONNECTION_STRING ?? 'grpc://localhost:2236/local'

console.log(`Spike A: Bun ${typeof Bun !== 'undefined' ? Bun.version : 'NOT-DETECTED'}`)
console.log(`Target: ${connStr}`)

const t0 = performance.now()

const driver = new Driver(connStr, {
	credentialsProvider: new AnonymousCredentialsProvider(),
})

await driver.ready(AbortSignal.timeout(15_000))
const sql = query(driver)
const tConnect = performance.now() - t0
console.log(`  ✓ Driver ready in ${tConnect.toFixed(0)} ms`)

// 1. Plain SELECT
const tSel0 = performance.now()
const [rows = []] = await sql<[{ name: string }]>`SELECT 'bun-spike' AS name`
const tSel = performance.now() - tSel0
console.log(
	`  ✓ SELECT returned ${rows.length} row(s) in ${tSel.toFixed(0)} ms — row.name="${rows[0]?.name ?? 'NULL'}"`,
)

// 2. UPSERT into transient table (bench prefix from B.0 leftover)
const tDdl0 = performance.now()
await sql`${sql.unsafe(`CREATE TABLE IF NOT EXISTS \`_bun_spike\` (id Utf8 NOT NULL, val Int32, PRIMARY KEY (id))`)}`
const tDdl = performance.now() - tDdl0
console.log(`  ✓ DDL CREATE TABLE in ${tDdl.toFixed(0)} ms`)

const tUp0 = performance.now()
await sql`UPSERT INTO \`_bun_spike\` (id, val) VALUES (${'k1'}, ${42})`
const tUp = performance.now() - tUp0
console.log(`  ✓ UPSERT in ${tUp.toFixed(0)} ms`)

const tRead0 = performance.now()
const [readRows = []] = await sql<
	[{ id: string; val: number }]
>`SELECT id, val FROM \`_bun_spike\` WHERE id = ${'k1'}`
const tRead = performance.now() - tRead0
console.log(
	`  ✓ SELECT-back returned ${readRows.length} row(s) in ${tRead.toFixed(0)} ms — val=${readRows[0]?.val ?? 'NULL'}`,
)

// 3. Cleanup
await sql`${sql.unsafe(`DROP TABLE \`_bun_spike\``)}`

const total = performance.now() - t0
console.log(`\n=== Spike A wall-clock: ${total.toFixed(0)} ms ===`)
console.log(`    Pass criterion: <2000 ms total`)
console.log(`    Verdict: ${total < 2000 ? '✅ GREEN' : '⚠️ SLOWER THAN NODE'}`)

await driver.close()
process.exit(0)
