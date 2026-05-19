# =============================================================================
# Sepshn IaC — environment values (committed — все public IDs, no secrets)
# =============================================================================

yc_cloud_id        = "b1g444ngoknombq45l4t"   # cloud sepshn
yc_organization_id = "bpfvruf04ttdp3gmpj8h"
infra_folder_id    = "b1g6abh503j0dvitdccg"   # folder infra (renamed from default)
demo_folder_id     = "b1gcqa89an0n32mqpuvo"   # folder demo

# Bootstrap-created resources (см. _bootstrap/bootstrap.sh):
tf_bot_sa_id        = "ajeh7mk9muf6gbsee66l"
tf_state_kms_key_id = "abj7p3c9pbdmko5jsrtb"
tf_state_bucket     = "sepshn-tfstate"
