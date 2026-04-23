import { lingui } from '@lingui/vite-plugin'
import tailwindcss from '@tailwindcss/vite'
import { tanstackRouter } from '@tanstack/router-plugin/vite'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

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
	],
	resolve: {
		tsconfigPaths: true,
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
