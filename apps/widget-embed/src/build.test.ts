/**
 * Build artifact tests — BLD1..5 (facade) + BLD-FX1..3 (security hardening) +
 * BLD-LF1..3 (lazy flow chunk) per `plans/m9_widget_6_canonical.md` §9 + §A4.2.
 *
 *   BLD1     : facade gzip ≤ 15 360 bytes (D12 reframed)
 *   BLD2     : IIFE format — single self-contained `embed.js`
 *   BLD3     : no external imports (Lit + hydrate-support inlined)
 *   BLD4     : facade emits `embed.js` + sourcemap; lazy chunk emits separately
 *   BLD5     : source map separate `.map` file
 *   BLD-FX1  : DOM-clobbering stash present at IIFE prologue (D16)
 *   BLD-FX2  : Trusted Types `lit-html` policy registration emitted (D15)
 *   BLD-FX3  : Lit DSD hydrate-support code inlined (D1)
 *   BLD-LF1  : lazy `booking-flow.js` gzip ≤ 81 920 bytes (D12)
 *   BLD-LF2  : lazy chunk IIFE, no light-DOM `<slot>` references (D6)
 *   BLD-LF3  : lazy chunk has its own DOM-stash + hydrate-support (idempotent)
 *
 * `beforeAll` runs full build (both entries) if either artifact is missing
 * so the test is self-contained when run via `pnpm test:serial`. CI workflow
 * builds once upfront via `pnpm --filter @horeca/widget-embed build` to skip
 * the rebuild.
 */

import { existsSync, readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { gzipSync } from 'node:zlib'
import { beforeAll, describe, expect, it } from 'vitest'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const pkgRoot = path.resolve(__dirname, '..')
const distDir = path.join(pkgRoot, 'dist')
const facadePath = path.join(distDir, 'embed.js')
const facadeMapPath = path.join(distDir, 'embed.js.map')
const flowPath = path.join(distDir, 'booking-flow.js')

const FACADE_LIMIT = 15 * 1024
const FLOW_LIMIT = 80 * 1024

beforeAll(async () => {
	if (existsSync(facadePath) && existsSync(flowPath)) return
	const { build } = await import('vite')
	// First entry — facade.
	await build({
		root: pkgRoot,
		configFile: path.join(pkgRoot, 'vite.config.ts'),
		logLevel: 'error',
	})
	// Second entry — lazy flow. Vite reads `EMBED_ENTRY` env var.
	process.env.EMBED_ENTRY = 'flow'
	try {
		await build({
			root: pkgRoot,
			configFile: path.join(pkgRoot, 'vite.config.ts'),
			logLevel: 'error',
		})
	} finally {
		process.env.EMBED_ENTRY = ''
	}
}, 90_000)

describe('widget-embed build — facade (embed.js)', () => {
	it('BLD1 — facade gzip size ≤ 15 360 bytes (D12)', () => {
		const raw = readFileSync(facadePath)
		const gzipped = gzipSync(raw, { level: 9 })
		expect(gzipped.length).toBeLessThanOrEqual(FACADE_LIMIT)
	})

	it('BLD2 — IIFE format, single self-contained embed.js', () => {
		const code = readFileSync(facadePath, 'utf-8')
		// Vite 8 + Terser + `output.extend: true` emits a bang-function IIFE:
		// `!function(t){…}(this.SochiBookingWidget=this.SochiBookingWidget||{});`
		expect(code).toMatch(/^!function\s*\(/)
		expect(code).toMatch(/this\.SochiBookingWidget\s*=\s*this\.SochiBookingWidget/)
		expect(code).not.toMatch(/(?:^|[\s;])import\s+["'`]/)
		expect(code).not.toMatch(/(?:^|[\s;])export\s+\{/)
	})

	it('BLD3 — no external imports (Lit bundled into the IIFE)', () => {
		const code = readFileSync(facadePath, 'utf-8')
		expect(code).not.toMatch(/require\(["']lit["']\)/)
		expect(code).not.toMatch(/from\s+["']lit["']/)
		expect(code).toMatch(/_\$litElement\$|litElementHydrateSupport|reactiveElementVersions/)
	})

	it('BLD4 — exactly two .js bundles emitted (facade + lazy chunk)', () => {
		const entries = readdirSync(distDir)
			.filter((f) => f.endsWith('.js'))
			.sort()
		expect(entries).toEqual(['booking-flow.js', 'embed.js'])
	})

	it('BLD5 — facade sourcemap emitted as separate .map file', () => {
		expect(existsSync(facadeMapPath)).toBe(true)
		const map = JSON.parse(readFileSync(facadeMapPath, 'utf-8')) as {
			version: number
			mappings: string
		}
		expect(map.version).toBe(3)
		expect(map.mappings.length).toBeGreaterThan(0)
		const code = readFileSync(facadePath, 'utf-8')
		expect(code).toMatch(/\/\/# sourceMappingURL=embed\.js\.map\s*$/m)
	})

	it('BLD-FX1 — DOM-clobbering stash markers present (D16)', () => {
		const code = readFileSync(facadePath, 'utf-8')
		expect(code).toContain('document clobbered')
		expect(code).toContain('customElements clobbered')
	})

	it('BLD-FX2 — Trusted Types policy registration emitted (D15)', () => {
		const code = readFileSync(facadePath, 'utf-8')
		expect(code).toContain('lit-html')
	})

	it('BLD-FX3 — Lit DSD hydrate-support inlined (D1)', () => {
		const code = readFileSync(facadePath, 'utf-8')
		expect(code).toContain('litElementHydrateSupport')
	})
})

describe('widget-embed build — lazy chunk (booking-flow.js)', () => {
	it('BLD-LF1 — lazy chunk gzip ≤ 81 920 bytes (D12)', () => {
		const raw = readFileSync(flowPath)
		const gzipped = gzipSync(raw, { level: 9 })
		expect(gzipped.length).toBeLessThanOrEqual(FLOW_LIMIT)
	})

	it('BLD-LF2 — lazy chunk is IIFE, no light-DOM <slot> references (D6)', () => {
		const code = readFileSync(flowPath, 'utf-8')
		expect(code).toMatch(/^!function\s*\(/)
		expect(code).toMatch(/this\.SochiBookingFlow\s*=\s*this\.SochiBookingFlow/)
		// Lit's `html` template literal does not produce `<slot` for our markup
		// — `<slot>` exposure is banned (D6, R2 #3 XSS mitigation).
		expect(code).not.toMatch(/<slot[\s>]/)
	})

	it('BLD-LF3 — lazy chunk has its own DOM stash + hydrate-support (idempotent)', () => {
		const code = readFileSync(flowPath, 'utf-8')
		// The lazy chunk re-runs the stash so it cannot trust state set by the
		// facade — defensive against partial loads / SW staleness mismatches.
		expect(code).toContain('document clobbered')
		expect(code).toContain('customElements clobbered')
		expect(code).toContain('litElementHydrateSupport')
	})
})
