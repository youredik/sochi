/**
 * Auto-created placeholder org name applied at `/welcome` route when a
 * fresh user has no organizations yet. Replaces the legacy form-based
 * orgName entry — per 2026-05-22 «DaData party wins» canon (см.
 * `identify-step.tsx:60-69`), the legal-entity name is established от
 * ИНН lookup в setup wizard step 1, so asking the user to type a name
 * up-front была dummy friction (typed → URL-param → form prefill →
 * DaData rename ⇒ all three keystrokes thrown away).
 *
 * Round 14.6.2 — signup-form orgName field dropped; welcome route
 * auto-creates org с этим placeholder; IdentifyStep ИНН confirm
 * triggers `organization.update({ name: party.name })` (DaData wins);
 * URL slug remains `org-<base36>` для bookmark stability (URL stability
 * > display cleanliness mid-onboarding).
 *
 * Tests `identify-step.test.tsx` reuse this constant as baseline
 * pre-rename name; changing the value here does NOT break logic, only
 * literal expectations в a single fixture.
 *
 * Lives в `lib/` (not next к a component) because Biome's
 * `useComponentExportOnlyModules` requires hot-reload-friendly component
 * files to export only components.
 */
export const DEFAULT_WELCOME_ORG_NAME = 'Моя гостиница'
