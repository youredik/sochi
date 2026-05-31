import { connect } from 'node:net'

/**
 * Vitest `globalSetup` — fail-fast guard against a CONTAMINATING dev backend.
 *
 * ## Why (root-caused 2026-05-30)
 * The integration db-tests seed `payment` / `folio` / `booking` rows into the
 * local YDB. If the local dev backend (`bun --watch src/index.ts`, port 8787)
 * is running, its CDC consumers (`folio_balance_writer`, `activity_writer`, …)
 * read the SAME changefeeds and process the test-seeded rows from a SEPARATE
 * process — recomputing folios, writing activity, etc. — out from under the
 * assertions. That silently corrupts "row X untouched" tests: e.g. the
 * `folio-balance [CT1]` cross-tenant flake was empirically the dev consumer
 * rewriting tenant B's folio mid-test (confirmed: stop the backend → 6/6 green).
 *
 * Integration tests must own their database (canonical 2026 guidance: never
 * share a test DB with a live service). Until the db-tests get a dedicated YDB
 * instance, this guard turns a silent flake into a loud, actionable failure.
 *
 * Scope: only fires when the tests target the DEFAULT shared local YDB (the one
 * the dev backend uses). A dedicated test YDB (override `YDB_CONNECTION_STRING`)
 * is immune. CI has no dev backend, so this is a no-op there.
 */
const TEST_YDB = process.env.YDB_CONNECTION_STRING || 'grpc://localhost:2236/local'
const DEV_BACKEND_PORT = 8787

export default async function globalSetup(): Promise<void> {
	const usesSharedLocalYdb =
		TEST_YDB.includes('localhost:2236') || TEST_YDB.includes('127.0.0.1:2236')
	if (!usesSharedLocalYdb) return

	if (await isPortOpen('127.0.0.1', DEV_BACKEND_PORT)) {
		throw new Error(
			[
				'',
				'  ✖ db-tests aborted: the local dev backend (port 8787) is RUNNING.',
				'',
				'    These tests seed payment/folio/booking rows into the shared local YDB.',
				"    The dev backend's CDC consumers (folio_balance_writer, activity_writer, …)",
				'    read the SAME changefeeds and process those rows from a separate process,',
				'    corrupting assertions like "tenant B untouched" (silent flakes).',
				'',
				'    Stop it, then re-run `pnpm test:db`:',
				"      lsof -i :8787 -P | awk '$NF~/LISTEN/{print $2}' | xargs kill",
				'',
				'    (CI has no dev backend, so this never fires there.)',
				'',
			].join('\n'),
		)
	}
}

/** Resolve true iff a TCP listener accepts a connection on host:port within 400ms. */
function isPortOpen(host: string, port: number): Promise<boolean> {
	return new Promise((resolve) => {
		const socket = connect({ host, port })
		const finish = (result: boolean): void => {
			socket.destroy()
			resolve(result)
		}
		socket.setTimeout(400)
		socket.once('connect', () => finish(true))
		socket.once('timeout', () => finish(false))
		socket.once('error', () => resolve(false))
	})
}
