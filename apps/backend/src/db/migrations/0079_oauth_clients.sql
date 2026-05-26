-- Round 14 — RFC 7591 Dynamic Client Registration YDB-backed storage.
--
-- Round 13 Phase D-DCR shipped в commit `04b4648` с in-memory store; that
-- closed «RFC 7591 shape works» surface area но NOT actual «OAuth onboarding
-- gap» (per Round 13 canon HONEST scope limit — server restart invalidates
-- ALL registrations).
--
-- Round 14 Phase E1 — persistent storage. Integration partner registers
-- once → credentials valid across restarts/deploys → onboarding gap closed
-- functionally.

CREATE TABLE IF NOT EXISTS oauthClient (
    tenantId                Utf8 NOT NULL,
    clientId                Utf8 NOT NULL,
    clientSecretHash        Utf8 NOT NULL,
    clientName              Utf8 NOT NULL,
    redirectUrisJson        Json NOT NULL,
    grantTypesJson          Json NOT NULL,
    tokenEndpointAuthMethod Utf8 NOT NULL,
    contactsJson            Json,
    clientIdIssuedAt        Timestamp NOT NULL,
    clientSecretExpiresAt   Timestamp,
    revokedAt               Timestamp,
    PRIMARY KEY (tenantId, clientId),
    INDEX idxOauthClientById GLOBAL SYNC ON (clientId)
);
