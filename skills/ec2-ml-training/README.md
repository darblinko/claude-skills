# ec2-ml-training

Guidance for running an ML training job on a temporary EC2 instance when it does
not fit in local RAM or needs a GPU. Claude loads `SKILL.md` when a training run
is about to exceed the local machine.

The skill ships no code. It defines the interface of two project scripts:

| Script | Role |
|---|---|
| `scripts/ec2_config.sh` | Every configurable value. The only file an agent edits. |
| `scripts/ec2_training.sh` | The lifecycle: launch, set up, upload, train, download, verify, terminate. |

`SKILL.md` lists the flags the workflow script accepts (`--gpu`, `--command`,
`--keep`, `--connect`, `--terminate`, `--dry-run`), the eight lifecycle steps it
implements and the config variables it reads. If a project has neither script,
Claude writes them to that interface.

## Contents of SKILL.md

- Instance selection for CPU and GPU training, with RAM sizing from one recorded
  run.
- Which gradient-boosting libraries gain from a GPU (XGBoost) and which do not
  (LightGBM, CatBoost).
- The XGBoost 3.x change from `tree_method="gpu_hist"` to `device="cuda"`.
- AMI lookup commands instead of hardcoded AMI IDs.
- The `scp -r` directory nesting failure and how `EC2_REMOTE_DIRS` avoids it.
- Cost rules and a failure-mode table.

## Limitations

- The instance prices in `SKILL.md` were recorded 2026-05 for Linux on-demand
  instances. They change; check current pricing for the region.
- The timings and RAM figures in `SKILL.md` come from one set of runs on tabular
  gradient-boosting workloads and do not transfer to deep learning jobs.
- The skill assumes the AWS CLI is configured with credentials that can launch
  and terminate instances. It does not cover IAM policy design.
