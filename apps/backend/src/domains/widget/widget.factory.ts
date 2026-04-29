/**
 * Widget factory — wires repo + service для public booking widget.
 * Mirrors booking.factory.ts pattern (pure DI, no side effects).
 */
import type { sql as SQL } from '../../db/index.ts'
import { createWidgetRepo } from './widget.repo.ts'
import { createWidgetService } from './widget.service.ts'

type SqlInstance = typeof SQL

export function createWidgetFactory(sql: SqlInstance) {
	const repo = createWidgetRepo(sql)
	const service = createWidgetService(repo)
	return { repo, service }
}

// WidgetFactory type — currently unused externally (only `factory.service`
// is consumed by app.ts via inline access). `export type WidgetFactory =
// ReturnType<typeof createWidgetFactory>` re-added в M9.widget.4 когда
// booking-create domain потребует DI typing.
