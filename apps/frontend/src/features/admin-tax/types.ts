/**
 * Re-exported helper types for tax report UI components — keeps imports
 * stable if the canonical types in `@horeca/shared` ever rename.
 */
import type {
	TourismTaxOrgReport,
	TourismTaxOrgReportMonthly,
	TourismTaxOrgReportRow,
} from '@horeca/shared'

export type TourismTaxOrgReportKpi = TourismTaxOrgReport['kpi']
export type { TourismTaxOrgReport, TourismTaxOrgReportMonthly, TourismTaxOrgReportRow }
