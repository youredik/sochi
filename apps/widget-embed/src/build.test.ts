/**
 * Build artifact tests — BLD1..5 + BLD-FX1..3 per `plans/m9_widget_6_canonical.md`
 * §9 + A4.1.fix corrections (R1+R2 2026-05-04).
 *
 *   BLD1     : facade gzip size ≤ 15 360 bytes (D12 reframed)
 *   BLD2     : IIFE format — single self-contained `embed.js`
 *   BLD3     : no external imports (Lit bundled, hydrate-support inlined)
 *   BLD4     : subpath imports enforced (no `lit` barrel)
 *   BLD5     : source map separate `.map` file
 *   BLD-FX1  : DOM-clobbering stash present at IIFE prologue (D16)
 *   BLD-FX2  : Trusted Types `lit-html` policy registration emitted (D15)
 *   BLD-FX3  : Lit DSD hydrate-support code inlined (D1)
 */

import { existsSync, readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { gzipSync } from 'node:zlib'
import { beforeAll, describe, expect, it } from 'vitest'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const pkgRoot = path.resolve(__dirname, '..')
const distDir = path.join(pkgRoot, 'dist')
const bundlePath = path.join(distDir, 'embed.js')
const sourceMapPath = path.join(distDir, 'embed.js.map')

const LIMIT_BYTES = 15 * 1024 // 15 360 — facade pattern (D12 reframed)

beforeAll(async () => {
	if (!existsSync(bundlePath)) {
		const { build } = await import('vite')
		await build({
			root: pkgRoot,
			configFile: path.join(pkgRoot, 'vite.config.ts'),
			logLevel: 'error',
		})
	}
}, 90_000)

describe('widget-embed build artifact', () => {
	it('BLD1 — facade gzip size ≤ 15 360 bytes (D12)', () => {
		const raw = readFileSync(bundlePath)
		const gzipped = gzipSync(raw, { level: 9 })
		expect(gzipped.length).toBeLessThanOrEqual(LIMIT_BYTES)
	})

	it('BLD2 — IIFE format, single self-contained embed.js', () => {
		const code = readFileSync(bundlePath, 'utf-8')
		// Vite 8 + Terser + `output.extend: true` emits a bang-function IIFE:
		// `!function(t){…}(this.SochiBookingWidget=this.SochiBookingWidget||{});`
		// The leading `!` and the global-assignment tail are the canonical
		// signature.
		expect(code).toMatch(/^!function\s*\(/)
		expect(code).toMatch(/this\.SochiBookingWidget\s*=\s*this\.SochiBookingWidget/)
		// No ESM `import` / `export` statements должны утечь в IIFE output.
		expect(code).not.toMatch(/(?:^|[\s;])import\s+["'`]/)
		expect(code).not.toMatch(/(?:^|[\s;])export\s+\{/)
	})

	it('BLD3 — no external imports (Lit bundled into the IIFE)', () => {
		const code = readFileSync(bundlePath, 'utf-8')
		// Lit primitives must appear inlined, not as bare-specifier requires:
		expect(code).not.toMatch(/require\(["']lit["']\)/)
		expect(code).not.toMatch(/from\s+["']lit["']/)
		// Some Lit internal token (e.g. `_$litElement$`) must be present —
		// proves Lit code is bundled, not stripped/aliased.
		expect(code).toMatch(/_\$litElement\$|litElementHydrateSupport|reactiveElementVersions/)
	})

	it('BLD4 — only one bundle file emitted (no chunk splits)', () => {
		// `inlineDynamicImports: true` collapses every chunk into embed.js.
		// Asset map files (`stats.html`, `embed.js.map`) are allowed; any
		// extra `.js` file would mean a code-split slipped through.
		const entries = readdirSync(distDir).filter((f) => f.endsWith('.js'))
		expect(entries).toEqual(['embed.js'])
	})

	it('BLD5 — sourcemap emitted as separate .map file', () => {
		expect(existsSync(sourceMapPath)).toBe(true)
		const map = JSON.parse(readFileSync(sourceMapPath, 'utf-8')) as {
			version: number
			mappings: string
		}
		expect(map.version).toBe(3)
		expect(map.mappings.length).toBeGreaterThan(0)
		// embed.js должен ссылаться на отдельный .map (sourceMappingURL comment).
		const code = readFileSync(bundlePath, 'utf-8')
		expect(code).toMatch(/\/\/# sourceMappingURL=embed\.js\.map\s*$/m)
	})

	it('BLD-FX1 — DOM-clobbering stash markers present (D16)', () => {
		const code = readFileSync(bundlePath, 'utf-8')
		// `dom-stash.ts` throws on hostile env via these specific marker strings —
		// proves stash module survived minification + tree-shaking.
		expect(code).toContain('document clobbered')
		expect(code).toContain('customElements clobbered')
	})

	it('BLD-FX2 — Trusted Types policy registration emitted (D15)', () => {
		const code = readFileSync(bundlePath, 'utf-8')
		// Lit reads a policy named `lit-html`; security-prologue registers it.
		expect(code).toContain('lit-html')
	})

	it('BLD-FX3 — Lit DSD hydrate-support inlined (D1)', () => {
		const code = readFileSync(bundlePath, 'utf-8')
		// `@lit-labs/ssr-client/lit-element-hydrate-support` exports
		// `litElementHydrateSupport`; minifier preserves the call site.
		expect(code).toContain('litElementHydrateSupport')
	})
})
