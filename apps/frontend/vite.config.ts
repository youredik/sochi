import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { lingui } from '@lingui/vite-plugin'
import babel from '@rolldown/plugin-babel'
import tailwindcss from '@tailwindcss/vite'
import { tanstackRouter } from '@tanstack/router-plugin/vite'
import react, { reactCompilerPreset } from '@vitejs/plugin-react'
import { defineConfig } from 'vite'
import { VitePWA } from 'vite-plugin-pwa'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

export default defineConfig({
	plugins: [
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
				name: 'HoReCa Sochi',
				short_name: 'HoReCa',
				description: 'Облачная PMS для малых отелей и гостевых домов Большого Сочи',
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
