import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { lingui } from '@lingui/vite-plugin'
import babel from '@rolldown/plugin-babel'
import tailwindcss from '@tailwindcss/vite'
import { tanstackRouter } from '@tanstack/router-plugin/vite'
import react, { reactCompilerPreset } from '@vitejs/plugin-react'
import { defineConfig, type Plugin } from 'vite'
import { VitePWA } from 'vite-plugin-pwa'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

/**
 * Strip CSP meta tag in dev mode only (Sprint C+ Round 6 2026-05-24).
 *
 * Vite dev injects React Fast Refresh inline preamble script which strict
 * CSP (`script-src 'self'`) would block — HMR breaks, console errors. Prod
 * builds (`vite build`) emit purely external-script bundles so CSP enforces
 * cleanly. This plugin runs ONLY when `command === 'serve'` (dev server) и
 * strips the meta тэг before browser sees it.
 *
 * Canon: production gets ZERO CSP relaxation; dev mode losses are local-
 * only convenience trade-off (no security surface in dev).
 */
function devOnlyStripCsp(): Plugin {
	return {
		name: 'sepshn-csp-dev-strip',
		apply: 'serve',
		transformIndexHtml: {
			order: 'pre',
			handler(html) {
				return html.replace(
					/<meta[^>]*http-equiv="Content-Security-Policy"[^>]*>\s*/i,
					'<!-- CSP stripped in dev mode (vite.config.ts devOnlyStripCsp) -->',
				)
			},
		},
	}
}

export default defineConfig({
	plugins: [
		devOnlyStripCsp(),
		tanstackRouter({
			target: 'react',
			autoCodeSplitting: true,
		}),
		react(),
		// React Compiler 1.0 (stable Oct 2025) + Lingui macro — via @rolldown/plugin-babel.
		// CANONICAL Vite 8 + @vitejs/plugin-react v6 setup (verified May 2026):
		// v6 dropped legacy `react({ babel: {...} })`; Babel-based plugins run via
		// @rolldown/plugin-babel separately. Old config silently no-op'd until
		// Phase 14 (bundle had 2 useMemoCache markers; fix below brought hundreds).
		// API: presets/plugins at top level, NOT wrapped in `babelConfig`.
		// Docs: https://github.com/vitejs/vite-plugin-react/blob/main/packages/plugin-react/README.md
		babel({
			presets: [reactCompilerPreset({ target: '19' })],
			plugins: ['@lingui/babel-plugin-lingui-macro'],
		}),
		lingui(),
		tailwindcss(),
		// PWA plugin (M9.4): manifest + service-worker precache + workbox.
		// `registerType: 'autoUpdate'` — silent SW update без user prompt.
		// `navigateFallbackDenylist: /^\/api/` — НЕ кэшируем API requests
		// (per plan §6.13 anti-pattern: API кэш = stale data).
		// Manifest = standalone display + Sochi-blue theme + RU lang. На iOS 26
		// Safari «Open as Web App» — game-changer (per plan §M9.4 + iOS 26
		// research: Apple добавил «Open as Web App» по умолчанию ON 2025-09).
		VitePWA({
			// **2026-05-22 disabled** until proper offline-UX в roadmap.
			// Empirical (HAR analysis sepshn.ru/demo): SW precache fetched ALL
			// 115-292 JS chunks at first visit, including deep app routes
			// `widget._tenantSlug_._propertyId.*` на маркетинг-лендинге → UX
			// regression + лишний traffic. «Приложение готово работать offline»
			// toast also unsolicited. Re-enable когда (1) operator UX explicitly
			// нуждается в offline editing AND (2) narrow `globPatterns` к
			// entry-only precache + runtime-caching для routes.
			//
			// Plugin still generates manifest.webmanifest (PWA add-to-home), но
			// SW не регистрируется → no precache fetches.
			disable: true,
			// G11 (2026-05-16) — `prompt` (NOT autoUpdate) per R1+R2 ≥ 2026-05-16
			// canon: operator app has forms (booking edit, wizard) → silent reload
			// mid-edit = data loss. `useRegisterSW` hook + Sonner action toast
			// «Доступна новая версия. [Обновить]» (см. SwUpdatePrompt component).
			registerType: 'prompt',
			// devOptions.enabled — генерирует manifest + SW в dev mode для local
			// smoke testing. Без этого Vite SPA fallback ловит /manifest.webmanifest
			// и возвращает index.html (parser fail в Playwright PWA verify).
			devOptions: {
				enabled: true,
				type: 'module',
			},
			workbox: {
				globPatterns: ['**/*.{js,css,html,svg,png,woff2}'],
				navigateFallbackDenylist: [/^\/api/, /^\/health/],
			},
			manifest: {
				name: 'Сэпшн — программа для гостевых домов и мини-отелей',
				short_name: 'Сэпшн',
				description: 'Программа для управления гостевым домом или мини-отелем. Сделано в Сочи.',
				theme_color: '#0a0a0a',
				background_color: '#ffffff',
				display: 'standalone',
				orientation: 'any',
				lang: 'ru',
				start_url: '/',
				scope: '/',
				icons: [
					{ src: 'pwa-64x64.png', sizes: '64x64', type: 'image/png' },
					{ src: 'pwa-192x192.png', sizes: '192x192', type: 'image/png' },
					{ src: 'pwa-512x512.png', sizes: '512x512', type: 'image/png' },
					{
						src: 'maskable-icon-512x512.png',
						sizes: '512x512',
						type: 'image/png',
						purpose: 'maskable',
					},
				],
			},
		}),
	],
	resolve: {
		alias: {
			// Matches apps/frontend/tsconfig.json paths: { "@/*": ["./src/*"] }.
			// shadcn components import via `@/lib/utils` and `@/components/...`;
			// Vite needs an explicit alias (tsconfig paths are type-only).
			'@': path.resolve(__dirname, './src'),
		},
	},
	server: {
		port: 5273,
		strictPort: true,
		// Same-origin proxy for Hono backend — keeps Better Auth cookie SameSite=Lax
		// viable in dev and allows `/api/otel/v1/*` OTLP traces without CORS.
		proxy: {
			'/api': {
				// Port 8787 — sochi unique (per `feedback_no_disrupt_other_dev.md`).
				target: 'http://localhost:8787',
				changeOrigin: false,
			},
		},
	},
	preview: {
		port: 5273,
		strictPort: true,
	},
})
