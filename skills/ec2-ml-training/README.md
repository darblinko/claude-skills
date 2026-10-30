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
- GPU support in XGBoost, LightGBM and CatBoost, the instance each used in the
  author's runs, and a rule to benchmark CPU against GPU per workload.
- The XGBoost change from `tree_method="gpu_hist"` (deprecated in 2.0, removed
  in 3.1) to `device="cuda"`.
- AMI lookup commands instead of hardcoded AMI IDs.
- The `scp -r` directory nesting failure and how `EC2_REMOTE_DIRS` avoids it.
- Cost rules and a failure-mode table.

## Limitations

- The instance prices in `SKILL.md` are approximate Linux on-demand rates noted
  2026-05. The region was not recorded and the figures were not checked against
  AWS pricing pages; check current pricing for the region.
- The timings and RAM figures in `SKILL.md` come from the author's single
  reported run on tabular gradient-boosting workloads. No benchmark artifacts
  are published, and the figures do not transfer to deep learning jobs.
- The skill assumes the AWS CLI is configured with credentials that can launch
  and terminate instances. It does not cover IAM policy design.
