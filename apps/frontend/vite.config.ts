import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { lingui } from '@lingui/vite-plugin'
import tailwindcss from '@tailwindcss/vite'
import { tanstackRouter } from '@tanstack/router-plugin/vite'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'
import { VitePWA } from 'vite-plugin-pwa'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

export default defineConfig({
	plugins: [
		tanstackRouter({
			target: 'react',
			autoCodeSplitting: true,
		}),
		react({
			babel: {
				// react-compiler: auto-memoize; lingui macro: extract-at-build for i18n.
				// Order matters only if plugins disagree on AST — here they don't.
				plugins: ['babel-plugin-react-compiler', '@lingui/babel-plugin-lingui-macro'],
			},
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
			registerType: 'autoUpdate',
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
		port: 5173,
		strictPort: true,
		// Same-origin proxy for Hono backend — keeps Better Auth cookie SameSite=Lax
		// viable in dev and allows `/api/otel/v1/*` OTLP traces without CORS.
		proxy: {
			'/api': {
				target: 'http://localhost:3000',
				changeOrigin: false,
			},
		},
	},
	preview: {
		port: 5173,
		strictPort: true,
	},
})
