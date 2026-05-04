/**
 * Vite IIFE library mode build for embed bundle.
 *
 * Per `plans/m9_widget_6_canonical.md` §D2:
 *   - Native `build.lib.formats: ['iife']` produces single self-contained
 *     bundle. Vite 8 disables code-splitting automatically для IIFE/UMD.
 *   - Terser (D3) — Vite 8 default Oxc loses ~0.5-2% gzip on the 30 kB cliff;
 *     Terser is canonical for byte-tight bundles.
 *   - rollup-plugin-visualizer writes `dist/stats.html` for chunk inspection.
 *   - SourceMap separate `.map` per BLD5.
 *   - `target: 'es2022'` matches `tsconfig.json`. Browsers без support
 *     (≤2% global per caniuse 2026) fall back на iframe path.
 *
 * Bundle size CI gate (D12, BLD1): `gzip-size dist/embed.js --raw` ≤ 30720 bytes.
 */

import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { visualizer } from 'rollup-plugin-visualizer'
import { defineConfig } from 'vite'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

export default defineConfig({
	build: {
		target: 'es2022',
		minify: 'terser',
		terserOptions: {
			compress: { passes: 2, ecma: 2020 },
			mangle: { properties: false },
			format: { comments: false },
		},
		sourcemap: true,
		emptyOutDir: true,
		lib: {
			entry: path.resolve(__dirname, 'src/index.ts'),
			name: 'SochiBookingWidget',
			formats: ['iife'],
			fileName: () => 'embed.js',
		},
		rollupOptions: {
			output: {
				extend: true,
			},
		},
		reportCompressedSize: true,
	},
	plugins: [
		visualizer({
			filename: 'dist/stats.html',
			gzipSize: true,
			brotliSize: false,
			template: 'treemap',
			emitFile: false,
		}),
	],
})
