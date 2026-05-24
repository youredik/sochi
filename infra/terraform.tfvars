# =============================================================================
# Sepshn IaC — environment values (committed — все public IDs, no secrets)
# =============================================================================
#
# Migration к новый cloud 2026-05-20:
#   Old: youredik org / sepshn cloud b1g444ngoknombq45l4t (deleted by user)
#   New: Сэпшн org bpfar26apvm2ljel57ta / sepshn cloud b1gisf466novulsg0a0n
#
# Структура упрощена: 1 folder `infra` для всего (раньше было infra + demo).

yc_cloud_id        = "b1gisf466novulsg0a0n" # cloud sepshn (новое)
yc_organization_id = "bpfar26apvm2ljel57ta" # org Сэпшн (новое)
infra_folder_id    = "b1gp4bo808jr6qvrnltu" # folder infra (shared: DNS, KMS, Registry, Postbox identity)
demo_folder_id     = "b1gtssqle0rbc3nv489v" # folder demo (workload: Container, YDB, S3, Lockbox, Captcha, Sender SA)

# Когда появится prod environment — отдельный cloud `sepshn-prod` (max isolation
# per Yandex security canon, не folder). См. `[[handover_2026_05_22]]` § Future.
# prod_folder_id   = "TBD"  # в новом cloud, не в этом

# Bootstrap-created resources (см. _bootstrap/bootstrap.sh):
tf_bot_sa_id           = "ajer6tlq2rcccuuln5vq"
tf_state_kms_key_id    = "abjrq8h1v9o6tam8ml8n"
tf_state_bucket        = "sepshn-tfstate-v2"
bootstrap_claude_sa_id = "ajel5mli0hshm053amt8"

# SmartCaptcha bootstrap (Phase 1 завершён 2026-05-22, см. bootstrap.md шаги 1.2-1.4)
smartcaptcha_lockbox_secret_id  = "e6qa4in4mep35ubimi6c" # sepshn-smartcaptcha-server-key в infra folder
smartcaptcha_lockbox_version_id = "e6qvbn4ajnl1fcff7h9q" # initial version с SMARTCAPTCHA_SERVER_KEY=ysc2_...

# Postbox DKIM bootstrap (Phase 2 завершён 2026-05-22, см. bootstrap.md шаги 2.1-2.2)
lockbox_postbox_dkim_secret_id = "e6q473a65ocn37tkcovg" # sepshn-postbox-dkim в infra folder
postbox_dkim_public_key        = "MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAqmdBBaBHEe6at3617TxeVG/O1BYumtSbArUi7wCkvES/qFC8oKBYzh3HMp/vs3vmCDMqaKGHAWdemCQcMoYk1b/f/t+Gyq4svV6cyFsFpW2YD8EWEido/6yx1cb42lNkviLfOcR4G1OCnDQChkFE1RX0zBaUoJrTnegi9vlMzxtYctp8zvkjBOezyN9CTyeBvxjTy+0yC8BM/8uK+8jMK2hNl6qPTHp+DHsVkb8mF8NwUVzWGtT0oEdnXXCyclkJTF46Z1HI4XBWHwtcmBMNMoRm16sapxZTJ/bhCo9VuiaYwd00xYeFo62jLdWwllSdfn1aR5JKHFglOUQ4VTRi9QIDAQAB"

# DaData live API key bootstrap (Phase 2.5 завершён 2026-05-22).
# Bootstrap: `yc lockbox secret create --name sepshn-dadata-api-key --folder-id
# b1gp4bo808jr6qvrnltu --payload '[{"key":"DADATA_API_KEY","text_value":"<key>"}]'`.
# Без этих IDs backend factory создаёт mock-dadata (только 4 фиктивных ИНН
# с префиксом `2320` lookupable). С IDs — live `suggestions.dadata.ru`.
dadata_lockbox_secret_id  = "e6q3ug4k0m9eobgstvv2" # sepshn-dadata-api-key в infra folder
dadata_lockbox_version_id = "e6q96288msve5pnu3rvo" # initial version с DADATA_API_KEY

# Round 7 v3 2026-05-25 — canonical Yandex SWS bypass token (SUPERSEDES v2 SA-JWT)
# Lockbox `sepshn-sws-bypass-token` в demo folder. 32-byte hex token, two-layer
# canon: SWS edge allow-rule (priority 8500) + backend timing-safe compare.
# Old SA-JWT v2 stack (sepshn-agent-verifier SA + key + Lockbox sepshn-agent-
# verifier-public + SC secret YC_AGENT_VERIFIER_SA_KEY_JSON) removed via cleanup.
sws_bypass_lockbox_secret_id  = "e6q7smlofm4eft1sp1ll"
sws_bypass_lockbox_version_id = "e6qclc038p7gkl6ajvrp"
