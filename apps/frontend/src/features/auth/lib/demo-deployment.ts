/**
 * Demo-deployment flag — `true` when build was produced for the public
 * hosted demo (`VITE_DEMO_DEPLOYMENT='true'`). Paired with backend
 * `DEMO_DEPLOYMENT=true` per `[[demo_strategy]]`.
 *
 * Read-once at module init: Vite inlines `import.meta.env` constants at
 * build time, so the value is fully static for the deployed bundle.
 *
 * Consumers:
 *   - `captcha.ts` — suppresses captcha widget when demo build
 *   - `DemoInboxPanel` — renders inline inbox panel when demo build
 */
export const isDemoDeployment: boolean = import.meta.env.VITE_DEMO_DEPLOYMENT === 'true'
