/**
 * Placeholder shown inside the empty orgName input on `/welcome`. ALSO
 * compared by `identify-step.tsx` to detect «user accepted the placeholder
 * as the value» — the classic placeholder-as-default UX trap. When the
 * wizard's step-1 confirms a DaData party, this constant is the trigger to
 * auto-replace the org name с the legal entity name из DaData (so the
 * sidebar / cabinet label match the property header inside Шахматка).
 *
 * Lives в `lib/` (not next к the component) because Biome's
 * `useComponentExportOnlyModules` requires hot-reload-friendly component
 * files to export only components.
 */
export const DEFAULT_WELCOME_ORG_NAME = 'Гостиница Ромашка'
