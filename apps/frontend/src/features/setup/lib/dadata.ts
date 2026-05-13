/**
 * Wizard-internal re-export so feature files import a single specifier
 * (`./lib/dadata.ts`) instead of reaching up to the workspace package on
 * every site — easier to grep / refactor / future-mock if the wire shape
 * ever diverges between backend and wizard.
 */
export type { DaDataParty, LegalForm, PartyStatus, TaxRegime } from '@horeca/shared'
