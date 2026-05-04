import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

export default defineConfig({
	test: {
		name: 'widget-embed',
		globals: false,
		passWithNoTests: false,
		// Build artifact tests run in node — beforeAll spawns Vite в API mode
		// и читает dist/embed.js. Component tests (W1-W10 в А4.2) появятся
		// в Vitest Browser Mode + Playwright provider (per plan §5).
		environment: 'node',
		include: ['src/**/*.test.ts'],
		hookTimeout: 90_000,
	},
	resolve: {
		alias: {
			'@': path.resolve(__dirname, './src'),
		},
	},
})
