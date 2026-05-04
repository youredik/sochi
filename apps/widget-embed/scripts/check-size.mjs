/**
 * Bundle size CI gate — dual gates per facade pattern (D12 reframed 2026-05-04).
 *
 *   `dist/embed.js`         — facade gzip ≤ 15 360 bytes
 *   `dist/booking-flow.js`  — lazy chunk gzip ≤ 81 920 bytes
 *
 * Per `plans/m9_widget_6_canonical.md` §D12:
 *   - Facade pattern canon — Stripe Buy Button (3.5 KB gzip), Bnovo
 *     (4.2 KB), SiteMinder (12.3 KB), Yandex.Travel (4.8 KB), Resy (36.8 KB)
 *     ВСЕ ship a tiny facade + heavy lazy chunk. Defends tenant Core Web
 *     Vitals — INP attribution from in-DOM widgets counts against tenant's
 *     PSI score.
 *   - Run via `pnpm --filter @horeca/widget-embed build:check` in post-push CI.
 *   - Exit 1 if EITHER bundle missing OR over budget so workflow fails red.
 *
 * Uses Node's built-in `zlib.gzipSync` instead of the `gzip-size` package to
 * avoid a runtime dep and keep the gate self-contained.
 */

import { readFileSync, statSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { gzipSync } from 'node:zlib'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const distDir = path.resolve(__dirname, '..', 'dist')

const bundles = [
	{ name: 'embed.js', limit: 15 * 1024, label: 'facade' },
	{ name: 'booking-flow.js', limit: 80 * 1024, label: 'lazy chunk' },
]

const fmt = (n) => `${n.toLocaleString('en-US')} bytes (${(n / 1024).toFixed(2)} KiB)`

let failed = false

for (const b of bundles) {
	const bundlePath = path.join(distDir, b.name)
	let stat
	try {
		stat = statSync(bundlePath)
	} catch {
		console.error(
			`[widget-embed] FAIL — ${b.name} missing at ${bundlePath}. Run "pnpm build" first.`,
		)
		failed = true
		continue
	}
	const raw = readFileSync(bundlePath)
	const gzipped = gzipSync(raw, { level: 9 })
	const rawBytes = stat.size
	const gzipBytes = gzipped.length

	console.log(`[widget-embed] dist/${b.name} (${b.label})`)
	console.log(`  raw : ${fmt(rawBytes)}`)
	console.log(`  gzip: ${fmt(gzipBytes)}  (limit ${fmt(b.limit)})`)

	if (gzipBytes > b.limit) {
		const over = gzipBytes - b.limit
		console.error(`[widget-embed] FAIL ${b.name} — over budget by ${fmt(over)}.`)
		failed = true
	} else {
		const headroom = b.limit - gzipBytes
		console.log(`[widget-embed] OK ${b.name} — ${fmt(headroom)} headroom.`)
	}
}

if (failed) process.exit(1)
