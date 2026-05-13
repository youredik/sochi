/**
 * DaData findById/party adapter contract. The wire-level DTOs live в
 * `@horeca/shared` so the frontend wizard reads the same shape the backend
 * route literally returns — see `packages/shared/src/dadata.ts`. Only the
 * adapter interface (server-side capability) stays here.
 */

import type { DaDataParty } from '@horeca/shared'

export type { DaDataParty, LegalForm, PartyStatus, TaxRegime } from '@horeca/shared'

/**
 * The single capability of the DaData adapter: lookup by ИНН. Returns
 * `null` when DaData has no record (unknown ИНН) OR when the adapter
 * failed fail-softly. The route layer distinguishes via response shape:
 * `{ data: party | null }` carries «not found / soft fail» semantics
 * uniformly; the UI then offers manual override.
 */
export interface DaDataAdapter {
	findByInn(inn: string): Promise<DaDataParty | null>
}
