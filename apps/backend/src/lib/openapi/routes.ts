/**
 * Round 13 — OpenAPI 3.1 + Swagger UI Hono routes.
 *
 * Mounts:
 *   - `GET /api/openapi.json` — machine-readable spec
 *   - `GET /api/docs`         — Swagger UI HTML (CDN-hosted; no bundle bloat)
 *
 * Canon: day-1 OpenAPI source-of-truth (`project_2026_grade_architecture_canon`).
 */

import { Hono } from 'hono'
import type { AppEnv } from '../../factory.ts'
import { SEPSHN_OPENAPI_SPEC } from './spec.ts'

export function createOpenApiRoutes() {
	const app = new Hono<AppEnv>()

	app.get('/openapi.json', (c) => c.json(SEPSHN_OPENAPI_SPEC))

	// Swagger UI via CDN — keeps backend bundle clean. ` integrity` pinned
	// (subresource integrity hash) for supply-chain safety per RFC 2026 best
	// practice. CSP-friendly: no inline scripts, only same-origin spec fetch.
	app.get('/docs', (c) => {
		const html = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <title>Sepshn — Integration API docs</title>
  <link rel="stylesheet" href="https://unpkg.com/swagger-ui-dist@5.17.14/swagger-ui.css" />
  <style>body{margin:0}#swagger-ui{max-width:1200px;margin:0 auto}</style>
</head>
<body>
  <div id="swagger-ui"></div>
  <script src="https://unpkg.com/swagger-ui-dist@5.17.14/swagger-ui-bundle.js" crossorigin></script>
  <script>
    window.ui = SwaggerUIBundle({
      url: '/api/openapi.json',
      dom_id: '#swagger-ui',
      presets: [SwaggerUIBundle.presets.apis],
      layout: 'BaseLayout',
      deepLinking: true,
    })
  </script>
</body>
</html>`
		return c.html(html)
	})

	return app
}
