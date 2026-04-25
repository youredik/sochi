-- =============================================================================
-- Migration 0013 — M6 Payment domain pt.7: routingRule (declarative routing)
-- =============================================================================
--
-- Declarative folio-routing rules per Apaleo + Mews canon (3-round research,
-- memory `project_payment_domain_canonical.md` "Folio routing"). Replaces
-- the anti-pattern of hardcoded `if charge.isFnB` logic in app code.
--
-- ## Resolution algorithm (V1 minimum)
--
--   candidates = rules
--     .filter(enabled = TRUE)
--     .filter(matchScope ∈ {'property', 'company'} AND matches(booking))
--     .filter(matchChargeCategoriesJson includes charge.category)
--     .filter(validFrom <= today AND (validTo IS NULL OR today <= validTo))
--     .sortBy(priority asc)  -- lower number = higher precedence
--   target = candidates[0]?.targetFolioKind ?? 'guest' (safe default)
--
-- ## Snapshot-on-post (54-ФЗ reproducibility)
--
-- When a folioLine is posted, we write `routingRuleId` + resolved
-- `targetFolioId` ON the folioLine row (migration 0007). Editing a rule
-- LATER does NOT retroactively re-route past charges. Apaleo snapshot
-- principle + 54-ФЗ ledger immutability.
--
-- ## Why NO CHANGEFEED
--
-- routingRule is a CONFIG table, not an event source. Edits are
-- intentional ops actions (no high-volume mutations). Audit trail is
-- handled by the standard activity log via service-layer hook (M6.6),
-- not via CDC. Consumers don't need to react to rule edits — they
-- consult the table at post time.
--
-- ## V1 minimum scope
--
-- Canon: matchScope ∈ {'property', 'company'} + categorical filter.
-- DEFER for V2: window matching, amount limits, channel-code filter.
-- Schema reserves columns for these so V2 is a code change, not a migration.
--
-- ## Indexes
--
-- - PK `(tenantId, propertyId, priority, id)` — resolution path scan is
--   single-shard per (tenantId, propertyId) and natively ordered by priority.
-- - `ixRoutingRuleEnabled GLOBAL SYNC ON (tenantId, propertyId, enabled, priority)`
--   — fast filter on enabled rules during resolution.
--
-- =============================================================================

CREATE TABLE routingRule (
    tenantId          Utf8 NOT NULL,
    propertyId        Utf8 NOT NULL,
    -- Priority: 0..1000. Lower number wins. Embedded in PK so range scans
    -- are natively ordered. Domain layer enforces 0 <= priority <= 1000.
    priority          Int32 NOT NULL,
    id                Utf8 NOT NULL,
    -- Human-readable label for ops UI. Unique per (tenant, property)
    -- enforced at domain layer (NOT DB) — non-critical, just convenience.
    name              Utf8 NOT NULL,
    -- Match scope:
    --   property   — applies to all bookings at this property
    --   company    — applies only when booking.companyId = matchCompanyId
    --   ratePlan   — applies only when booking.ratePlanId = matchRatePlanId
    --                (V2 — schema reserved, not yet wired)
    matchScope        Utf8 NOT NULL,
    -- Optional matchers — NULL means wildcard within scope.
    matchCompanyId    Utf8,
    matchRatePlanId   Utf8,
    -- Channel matcher (V2 — schema reserved). Channel codes from booking
    -- domain: direct | yandex_travel | bnovo | etc.
    matchChannelCode  Utf8,
    -- JSON array of folioLine.category values that this rule routes.
    -- Example: ["fnb", "minibar", "spa"]
    -- Empty array = matches NOTHING (rule effectively disabled).
    -- Wildcard intent = use enabled=FALSE on a separate "fallback" row.
    matchChargeCategoriesJson Json NOT NULL,
    -- Resolution targets:
    --   targetFolioKind: 'guest' | 'company' | 'group_master' | 'ota_receivable'
    --                    | 'ota_payable' | 'transitory'
    targetFolioKind   Utf8 NOT NULL,
    -- For targetFolioKind='company', the company that pays the routed
    -- charges. NULL for non-company targets.
    targetCompanyId   Utf8,
    -- Validity window (Date — date-only, not Timestamp). Domain checks
    -- inclusive bounds: validFrom <= today AND (validTo IS NULL OR today <= validTo).
    validFrom         Date NOT NULL,
    validTo           Date,
    -- V2 amount cap (schema reserved). If charge.amountMinor > amountLimitMinor,
    -- this rule fails over to the next candidate. NULL = no cap.
    amountLimitMinor  Int64,
    -- Master switch. enabled=FALSE leaves the row in place for audit but
    -- excludes from resolution. Cheaper than DELETE because matched
    -- folioLines retain `routingRuleId` snapshot reference.
    enabled           Bool NOT NULL,
    -- OCC version (Int32 per gotcha #9).
    version           Int32 NOT NULL,
    -- Audit.
    createdAt         Timestamp NOT NULL,
    updatedAt         Timestamp NOT NULL,
    createdBy         Utf8 NOT NULL,
    updatedBy         Utf8 NOT NULL,
    PRIMARY KEY (tenantId, propertyId, priority, id),
    -- Resolution-path index — enabled rules ordered by priority
    INDEX ixRoutingRuleEnabled GLOBAL SYNC ON (tenantId, propertyId, enabled, priority)
);

ALTER TABLE routingRule SET (AUTO_PARTITIONING_BY_LOAD = ENABLED);

-- NO CHANGEFEED — config table, not event source (canon decision).
