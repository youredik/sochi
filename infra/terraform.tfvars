# =============================================================================
# Sepshn IaC — environment values (committed — все public IDs, no secrets)
# =============================================================================
#
# Migration к новый cloud 2026-05-20:
#   Old: youredik org / sepshn cloud b1g444ngoknombq45l4t (deleted by user)
#   New: Сэпшн org bpfar26apvm2ljel57ta / sepshn cloud b1gisf466novulsg0a0n
#
# Структура упрощена: 1 folder `infra` для всего (раньше было infra + demo).

yc_cloud_id        = "b1gisf466novulsg0a0n"   # cloud sepshn (новое)
yc_organization_id = "bpfar26apvm2ljel57ta"   # org Сэпшн (новое)
infra_folder_id    = "b1gp4bo808jr6qvrnltu"   # folder infra (shared: DNS, KMS, Registry, Postbox identity)
demo_folder_id     = "b1gtssqle0rbc3nv489v"   # folder demo (workload: Container, YDB, S3, Lockbox, Captcha, Sender SA)

# Когда появится prod environment — отдельный cloud `sepshn-prod` (max isolation
# per Yandex security canon, не folder). См. `[[handover_2026_05_22]]` § Future.
# prod_folder_id   = "TBD"  # в новом cloud, не в этом

# Bootstrap-created resources (см. _bootstrap/bootstrap.sh):
tf_bot_sa_id           = "ajer6tlq2rcccuuln5vq"
tf_state_kms_key_id    = "abjrq8h1v9o6tam8ml8n"
tf_state_bucket        = "sepshn-tfstate-v2"
bootstrap_claude_sa_id = "ajel5mli0hshm053amt8"

# SmartCaptcha bootstrap (Phase 1 завершён 2026-05-22, см. bootstrap.md шаги 1.2-1.4)
smartcaptcha_lockbox_secret_id  = "e6qa4in4mep35ubimi6c"  # sepshn-smartcaptcha-server-key в infra folder
smartcaptcha_lockbox_version_id = "e6qvbn4ajnl1fcff7h9q"  # initial version с SMARTCAPTCHA_SERVER_KEY=ysc2_...
