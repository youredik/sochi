/**
 * Vite multi-entry IIFE library build — facade pattern (D12).
 *
 *   `embed.js`         — facade, ≤15 KB gzip target. Renders CTA button +
 *                        IntersectionObserver lazy trigger + dynamic
 *                        `import('./booking-flow.js')` on click.
 *   `booking-flow.js`  — lazy chunk, ≤80 KB gzip target. Full booking flow
 *                        (search/extras/guest/confirm screens).
 *
 * Per `plans/m9_widget_6_canonical.md` §D12 (REFRAMED 2026-05-04 from R1b
 * industry benchmark + R1c INP attribution):
 *   - Stripe Buy Button (3.5 KB facade → 259 KB Stripe.js lazy), Bnovo
 *     (4.2 KB → iframe lazy), SiteMinder (12.3 KB → hosted iframe),
 *     Yandex.Travel (4.8 KB) ВСЕ ship two-stage. Industry canonical.
 *   - INP attribution: in-DOM widget event handlers count against tenant's
 *     PSI score (web-vitals 5 attribution build 2026). Tiny facade keeps
 *     first-paint cheap; heavy flow loads on user intent.
 *
 * Two-entry strategy: build runs twice (one per entry) because IIFE format
 * does not support multi-entry в native lib mode (Vite 8 рестрикция). Each
 * pass writes one self-contained bundle to `dist/`. CI runs
 * `pnpm build` + `node scripts/check-size.mjs` (gates BOTH artifacts).
 *
 * Selection: `EMBED_ENTRY=embed` (default) builds facade; `EMBED_ENTRY=flow`
 * builds the lazy chunk. `package.json scripts.build` chains both.
 */

import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { visualizer } from 'rollup-plugin-visualizer'
import { defineConfig } from 'vite'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

const ENTRY = process.env.EMBED_ENTRY === 'flow' ? 'flow' : 'embed'

const entryConfig =
	ENTRY === 'flow'
		? {
				entryPath: 'src/booking-flow-entry.ts',
				name: 'SochiBookingFlow',
				fileName: 'booking-flow.js',
			}
		: {
				entryPath: 'src/index.ts',
				name: 'SochiBookingWidget',
				fileName: 'embed.js',
			}

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
		// `false` so the second build (`EMBED_ENTRY=flow`) does NOT wipe the
		// facade artifact emitted by the first pass. CI / scripts orchestrate
		// the two-step build.
		emptyOutDir: false,
		lib: {
			entry: path.resolve(__dirname, entryConfig.entryPath),
			name: entryConfig.name,
			formats: ['iife'],
			fileName: () => entryConfig.fileName,
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
			filename: `dist/stats-${ENTRY}.html`,
			gzipSize: true,
			brotliSize: false,
			template: 'treemap',
			emitFile: false,
		}),
	],
})
