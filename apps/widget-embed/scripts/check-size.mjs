/**
 * Bundle size CI gate — `dist/embed.js` (facade) gzip-size ≤ 15 360 bytes.
 *
 * Per `plans/m9_widget_6_canonical.md` §D12 (REFRAMED 2026-05-04):
 *   - **Facade pattern canon** — Stripe Buy Button (3.5 KB gzip), Bnovo
 *     (4.2 KB), SiteMinder (12.3 KB), Yandex.Travel (4.8 KB) ВСЕ ship a tiny
 *     loader that lazy-fetches the heavy booking flow. Defends tenant Core
 *     Web Vitals — INP attribution from in-DOM widgets counts against
 *     tenant's PSI score.
 *   - Hard gate facade ≤ 15 KB gzip; future `dist/booking-flow.js` lazy chunk
 *     gets a separate ≤ 80 KB gate during A4.2.
 *   - Run via `pnpm --filter @horeca/widget-embed build:check` in post-push CI.
 *   - Exit 1 if missing OR over budget so workflow fails red.
 *
 * Uses Node's built-in `zlib.gzipSync` instead of the `gzip-size` package to
 * avoid a runtime dep and to keep the gate self-contained.
 */

import { readFileSync, statSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { gzipSync } from 'node:zlib'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const bundlePath = path.resolve(__dirname, '..', 'dist', 'embed.js')
const LIMIT_BYTES = 15 * 1024

let stat
try {
	stat = statSync(bundlePath)
} catch {
	console.error(`[widget-embed] FAIL — bundle missing at ${bundlePath}. Run "pnpm build" first.`)
	process.exit(1)
}

const raw = readFileSync(bundlePath)
const gzipped = gzipSync(raw, { level: 9 })
const rawBytes = stat.size
const gzipBytes = gzipped.length

const fmt = (n) => `${n.toLocaleString('en-US')} bytes (${(n / 1024).toFixed(2)} KiB)`

console.log(`[widget-embed] dist/embed.js`)
console.log(`  raw : ${fmt(rawBytes)}`)
console.log(`  gzip: ${fmt(gzipBytes)}  (limit ${fmt(LIMIT_BYTES)})`)

if (gzipBytes > LIMIT_BYTES) {
	const over = gzipBytes - LIMIT_BYTES
	console.error(`[widget-embed] FAIL — over budget by ${fmt(over)}.`)
	process.exit(1)
}

const headroom = LIMIT_BYTES - gzipBytes
console.log(`[widget-embed] OK — ${fmt(headroom)} headroom.`)
