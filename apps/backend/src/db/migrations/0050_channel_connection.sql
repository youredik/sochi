-- M10 / A7.1 — channel_connection: per-tenant per-property channel adapter binding.
--
-- Per `plans/m10_canonical.md` §2 D6-D20 + project_demo_strategy.md (per-tenant
-- adapter resolution): each (tenant, property, channel) tuple has its own
-- mode (mock/sandbox/live), DPA status, RKN registration, sync state.
--
-- credentialsLockboxRef = ref to YC Lockbox secret per `(organizationId, channelId)`
-- tuple (D29). Mock adapters do NOT have credentials (NULL); sandbox/live do.
-- role determines compliance gate (D18): processor_with_dpa | independent_operator
-- | foreign_recipient (sanctioned channels HARD-DISABLED at factory level).

CREATE TABLE channelConnection (
    tenantId               Utf8 NOT NULL,
    propertyId             Utf8 NOT NULL,
    channelId              Utf8 NOT NULL, -- 'TL' | 'YT' | 'ETG' | 'BNV'(future) | 'BCOM'(disabled)
    mode                   Utf8 NOT NULL, -- 'mock' | 'sandbox' | 'live'
    role                   Utf8 NOT NULL, -- 'processor_with_dpa' | 'independent_operator' | 'foreign_recipient'
    -- YC Lockbox secret reference per D29; NULL for mock-mode adapters.
    -- Honest cost flag: 100 tenants × 5 channels = 500 secrets — folder-level
    -- shared optimization carry-forward к Track B per plan §8.
    credentialsLockboxRef  Utf8,
    -- DPA = Data Processing Agreement (152-ФЗ ст. 6 ч. 3). Required для
    -- processor_with_dpa role; NULL для independent_operator.
    dpaSignedAt            Timestamp,
    -- Roskomnadzor operator registry ID per pd.rkn.gov.ru/operators-registry.
    -- Channels acting as independent_operator must have this populated before
    -- adapter activation.
    rknOperatorId          Utf8,
    -- Cross-border transfer notification (D19). Required только для
    -- foreign_recipient role; NULL для RU-resident channels.
    crossBorderNotificationStatus Utf8, -- 'filed' | 'pending' | 'denied' | NULL
    syncStatus             Utf8 NOT NULL, -- 'idle' | 'syncing' | 'error' | 'auto_disabled'
    lastSyncAt             Timestamp,
    autoDisabledReason     Utf8,
    autoDisabledAt         Timestamp,
    isEnabled              Bool NOT NULL,
    createdAt              Timestamp NOT NULL,
    updatedAt              Timestamp NOT NULL,
    PRIMARY KEY (tenantId, propertyId, channelId),
    INDEX idxChannelEnabledByTenant GLOBAL SYNC ON (tenantId, isEnabled, syncStatus)
);

ALTER TABLE channelConnection SET (AUTO_PARTITIONING_BY_LOAD = ENABLED);
