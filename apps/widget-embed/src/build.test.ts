/**
 * Build artifact tests — BLD1 through BLD5 per `plans/m9_widget_6_canonical.md` §9.
 *
 *   BLD1: bundle size gate ≤ 30 720 bytes gzip
 *   BLD2: IIFE format — single self-contained `embed.js`
 *   BLD3: no external imports (Lit bundled, не externalized)
 *   BLD4: subpath imports enforced (no `lit` barrel — bundle lookup table)
 *   BLD5: source map separate `.map` file
 *
 * `beforeAll` builds the bundle if `dist/embed.js` is missing so the test is
 * self-contained when run via `pnpm test:serial`. CI workflow can build once
 * upfront via `pnpm --filter @horeca/widget-embed build` to skip the rebuild.
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

const LIMIT_BYTES = 30 * 1024 // 30 720

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
	it('BLD1 — gzip size ≤ 30 720 bytes', () => {
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
})
