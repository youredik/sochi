-- 0043_passkey_better_auth.sql — M9.5 Phase D
-- per project_m9_theming_adaptive_canonical.md §M9.4 (Risk #4 mitigation).
--
-- Adds `passkey` table backing Better Auth `passkey()` plugin (WebAuthn).
-- Schema mirrors Better Auth canonical model (1.6.x):
--   https://www.better-auth.com/docs/plugins/passkey#schema
--
--   id           — typeid `pk_*` (matches advanced.database.generateId mapping)
--   name         — human label («iPad Touch ID», «MacBook Pro»). Optional.
--   publicKey    — COSE public key (base64url-encoded). Required.
--   userId       — owner. Cascade-delete handled at app level (BA spec).
--   credentialID — WebAuthn credentialId (base64url). UNIQUE для signin lookup.
--   counter      — anti-replay sign counter (server-side). Bumped per-auth.
--   deviceType   — 'singleDevice' | 'multiDevice' (WebAuthn AAGUID-derived).
--   backedUp     — passkey is platform-synced (iCloud Keychain / Google PM).
--   transports   — comma-separated AuthenticatorTransport ('internal,hybrid,...').
--                  Optional — used as transport hint при auth challenge.
--   createdAt    — enrollment timestamp.
--
-- a11y / compliance:
--   - Touch ID / Face ID / Windows Hello platform passkeys = 152-ФЗ-friendly
--     (биометрия НЕ покидает device, server hranит только public key).
--   - Real-device manual smoke required перед enabling в production
--     (Touch ID на iPad/Mac, Windows Hello на PC, fingerprint на Android).

CREATE TABLE IF NOT EXISTS passkey (
    id              Utf8 NOT NULL,
    name            Utf8,
    publicKey       Utf8 NOT NULL,
    userId          Utf8 NOT NULL,
    credentialID    Utf8 NOT NULL,
    counter         Uint64 NOT NULL,
    deviceType      Utf8 NOT NULL,
    backedUp        Bool NOT NULL,
    transports      Utf8,
    createdAt       Datetime NOT NULL,
    PRIMARY KEY (id),
    INDEX ixPasskeyUser GLOBAL ON (userId),
    INDEX ixPasskeyCredential GLOBAL ON (credentialID)
);
