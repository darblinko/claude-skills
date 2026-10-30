---
name: ec2-ml-training
description: Use when an ML training run needs more RAM or a GPU than the local machine has and should run on a temporary EC2 instance. Covers the config and workflow script split, instance and algorithm selection, S3 data transfer, XGBoost GPU settings, cost rules and common failure modes.
---

# EC2 ML Training

Offload an ML training run to a short-lived EC2 instance when the local machine
does not have the RAM or GPU for it.

This skill is guidance. It ships no scripts. It assumes the project provides the
two scripts described under "Project interface"; if they do not exist yet, write
them to that interface before the first run.

## Project interface

Two files, separation of concerns:

| File | Purpose | When to edit |
|---|---|---|
| `scripts/ec2_config.sh` | All configurable values (AWS, instance types, data paths, training parameters) | Changing parameters, instance types, data paths |
| `scripts/ec2_training.sh` | Workflow logic (launch, setup, train, download, verify, terminate) | Changing the lifecycle steps themselves |

**AI agents edit `ec2_config.sh`, not `ec2_training.sh`.**

### Workflow flags

```bash
# XGBoost GPU training
./scripts/ec2_training.sh --gpu

# CPU training (the author's configuration for LightGBM/CatBoost)
./scripts/ec2_training.sh

# Custom command (bypass the default train script)
./scripts/ec2_training.sh --gpu --command "python3.12 scripts/train.py --algorithms xgb --n-trials 40 --gpu"

# Keep the instance alive after training
./scripts/ec2_training.sh --keep

# SSH into the running training instance
./scripts/ec2_training.sh --connect

# Terminate
./scripts/ec2_training.sh --terminate <instance-id>

# Preview without executing
./scripts/ec2_training.sh --dry-run
```

### Lifecycle the workflow script implements

1. Launch an on-demand instance from the CPU or GPU AMI with the configured key pair and security group.
2. Wait for SSH, then create the top-level directories in `EC2_REMOTE_DIRS`.
3. Install `EC2_PIP_PACKAGES`.
4. Copy `EC2_SOURCE_DIRS` with `scp -r`. Pull the dataset from S3 on the instance; fall back to `scp` from `EC2_LOCAL_DATA` if the S3 copy fails.
5. Run the training command under `nohup` with a log file.
6. Download `EC2_DOWNLOAD_DIR` and check that every path in `EC2_VERIFY_MODELS` exists locally.
7. Terminate on success unless `--keep` is set. On a training error or a missing artifact, leave the instance running and print the SSH command.
8. Refuse to terminate any instance listed in `EC2_PROTECTED_INSTANCES`.

### Config variables

| Section | Key variables | What to change |
|---|---|---|
| AWS infrastructure | `EC2_KEY_NAME`, `EC2_SECURITY_GROUP`, `EC2_REGION` | AWS account setup |
| Instance types | `EC2_INSTANCE_TYPE_CPU`, `EC2_INSTANCE_TYPE_GPU` | Instance sizing |
| AMIs | `EC2_AMI_CPU`, `EC2_AMI_GPU` | Region and image refresh |
| Data transfer | `EC2_S3_DATA_KEY`, `EC2_LOCAL_DATA`, `EC2_REMOTE_DATA` | Dataset location |
| Source files | `EC2_TRAIN_SCRIPT`, `EC2_SOURCE_DIRS`, `EC2_REMOTE_DIRS` | Scripts to upload |
| Python | `EC2_PIP_PACKAGES` | Extra packages on the instance |
| Training parameters | `TRAIN_N_TRIALS`, `TRAIN_MAX_FEATURES` | Tuning budget |
| Results download | `EC2_DOWNLOAD_DIR`, `EC2_VERIFY_MODELS` | Artifact paths |
| Protected instances | `EC2_PROTECTED_INSTANCES` | Never-terminate list |

Keep account identifiers, key names and bucket names in `ec2_config.sh` or the
environment, never in the workflow script.

## Instance selection

| Instance | vCPU | RAM | GPU | Approx. on-demand $/hr | When to use |
|---|---|---|---|---|---|
| g4dn.xlarge | 4 | 16 GB | T4 | about 0.53 | Small datasets only. OOM risk on large ones. |
| g4dn.2xlarge | 8 | 32 GB | T4 | about 0.75 | GPU training on large datasets |
| r5.2xlarge | 8 | 64 GB | None | about 0.50 | CPU training, dataset builds. Most RAM of the three. |

Prices are approximate Linux on-demand rates noted by the author in 2026-05.
The region was not recorded and the figures have not been checked against the
AWS pricing pages. Look up current pricing for your region before relying on
them.

### Size RAM for feature preparation, not for the file

In the author's single reported run (no benchmark artifacts are published), a
dataset of about 1M rows by 553 numeric columns needed about 15 to 20 GB once
loaded, prepared and trained on, and a g4dn.xlarge (16 GB) was OOM-killed
during SHAP feature selection. Choose an instance with at least twice the
expected in-memory size of the prepared dataset.

### On-demand vs Spot

Use **on-demand** for model training (long-running; losing mid-train progress is
costly). Spot is appropriate only for stateless tasks such as dataset builds
that can be retried cheaply.

## Algorithm selection and GPU benefit

| Algorithm | GPU support in the library | Author's reported run (800K rows, 60 trials) | Instance used |
|---|---|---|---|
| **XGBoost** | Yes (`device="cuda"`) | about 19 min GPU, about 60 min CPU | g4dn.2xlarge |
| **LightGBM** | Yes (GPU build, `device="gpu"`, OpenCL) | about 45 min CPU; GPU not run | r5.2xlarge |
| **CatBoost** | Yes (`task_type="GPU"`) | about 45 min CPU; GPU not run | r5.2xlarge |

The timings come from the author's single reported run; no benchmark artifacts
are published. Treat them as order of magnitude. All three libraries document
GPU training: the LightGBM GPU tutorial reports over 3x speedup on its test
dataset, and the CatBoost documentation states that GPU training speeds up
datasets from tens of thousands of objects upward. The CPU instance for
LightGBM and CatBoost was the author's configuration, not a library limit.
Benchmark CPU against GPU on a sample of the actual workload before choosing
the instance.

### When to benchmark multiple algorithms

- **Judge PR-AUC against its baseline.** The no-skill PR-AUC equals the positive-class prevalence of the validation set, so an absolute value such as 0.85 says nothing about difficulty on its own. Compare the validation PR-AUC with the prevalence and look at its spread across CV folds.
- **Train XGBoost first.** Add LightGBM/CatBoost when the comparison could change the decision: the lift over baseline is small relative to fold-to-fold variation, or the expected gain justifies the measured training cost of another run. Restrict the comparison to the 1 or 2 most promising sub-models.
- **Categorical-heavy tasks**: CatBoost's native categorical handling may help. Worth benchmarking.

### Optuna trial count guidance

| Task difficulty | Indicator on validation data | Recommended trials |
|---|---|---|
| Easy | Large PR-AUC lift over prevalence; CV score plateaus early | 20 to 30 |
| Medium | Clear lift over prevalence; CV score still improving | 40 to 60 |
| Hard | Small lift over prevalence; high fold-to-fold variance | 60 to 80 |

These trial counts are the author's heuristics, not measured results.

## XGBoost GPU configuration

XGBoost 2.0 deprecated `gpu_hist` and `gpu_id` in favor of the `device`
parameter, and XGBoost 3.1 removed them. Use:

```python
# CORRECT (XGBoost 2.0 and later)
xgb.XGBClassifier(
    tree_method="hist",
    device="cuda",  # or "cpu"
)

# WRONG (deprecated in 2.0, removed in 3.1)
xgb.XGBClassifier(
    tree_method="gpu_hist",  # Invalid from 3.1
)
```

## AMI selection

AMI IDs differ by region and go stale. Look them up instead of hardcoding them:

```bash
# CPU: latest Amazon Linux 2023
aws ec2 describe-images --owners amazon --region "$EC2_REGION" \
  --filters "Name=name,Values=al2023-ami-2023*-kernel-*-x86_64" \
  --query 'Images | sort_by(@, &CreationDate) | [-1].ImageId' --output text

# GPU: latest Deep Learning Base AMI with CUDA on Amazon Linux 2023
aws ec2 describe-images --owners amazon --region "$EC2_REGION" \
  --filters "Name=name,Values=*Deep Learning Base*CUDA*Amazon Linux*" \
  --query 'Images | sort_by(@, &CreationDate) | [-1].ImageId' --output text
```

Write the results into `EC2_AMI_CPU` and `EC2_AMI_GPU`.

## Remote directory setup

Only create top-level dirs in `EC2_REMOTE_DIRS`. `scp -r` creates subdirectories
itself. Pre-creating subdirs (e.g. `src/eval`, `src/features`) causes scp to
**nest directories** (`src/src/eval/`), which breaks imports.

```bash
# CORRECT
EC2_REMOTE_DIRS=(
    "~/project/backtest"
    "~/project/backtest/experiments/models"
)

# WRONG: causes src/src/ nesting
EC2_REMOTE_DIRS=(
    "~/project/src/eval"
    "~/project/src/features"
)
```

## Data upload

Upload the dataset to S3 before launching. An instance reads S3 in its own region
far faster than scp from a workstation; in the author's setup scp from a WSL
host ran at about 1 MB/s.

```bash
aws s3 cp data/train.parquet "s3://<your-bucket>/ml-training/train.parquet" \
  --region "$EC2_REGION"
```

## Python environment

As recorded 2026-05, the Deep Learning Base AMI ships Python 3.12 with numpy,
scipy, scikit-learn, numba and shap. Check the AMI release notes for the current
list. Install the rest through the config:

```bash
EC2_PIP_PACKAGES="pandas pyarrow numpy scipy scikit-learn xgboost lightgbm catboost shap optuna python-dotenv"
```

## Cost rules

1. **Do not benchmark every algorithm by default.** Decide from the XGBoost validation PR-AUC relative to the prevalence baseline, its spread across CV folds, and the measured cost of another training run. A high absolute PR-AUC does not show that other algorithms cannot differ materially.
2. **Match the instance to the measured workload.** XGBoost, LightGBM and CatBoost all support GPU training. Time a sample run on CPU and on GPU, then choose the instance with the lower cost per completed run. In the author's setup, LightGBM/CatBoost ran on r5.2xlarge for its RAM.
3. **Reduce trials on predictable tasks.** 60 Optuna trials is excessive when the CV score plateaus by trial 20. Check with fewer trials first.
4. **Gate before expanding.** Do not train downstream models until upstream gates pass. Do not benchmark 3 algorithms until 1 algorithm shows the task is viable.
5. **Terminate promptly.** An instance left idle for 12 hours costs 12 times its hourly rate; at the approximate 0.75 $/hr in the table, a g4dn.2xlarge costs about 9 dollars.
6. **Use `--keep` only for debugging.** The default auto-terminates on success. Keep an instance alive only to inspect a failure over SSH.

## Safety

- **Protected instances**: the `EC2_PROTECTED_INSTANCES` array prevents accidental termination of long-running instances that are not part of the training run.
- **Failure handling**: on a training error, the instance stays alive for SSH inspection.
- **Model verification**: downloads are checked before termination; missing files keep the instance alive.
- **S3 fallback**: if the S3 download fails, the script falls back to scp from the local machine.

## Common failure modes

| Symptom | Cause | Fix |
|---|---|---|
| OOM kill (process disappears, no error in log) | Instance RAM too small (e.g. g4dn.xlarge, 16 GB) | Use g4dn.2xlarge (32 GB) or r5.2xlarge (64 GB) |
| `ImportError: cannot import name X` | scp nesting created `src/src/` | Check `EC2_REMOTE_DIRS`; remove subdirs and let scp create them |
| `Invalid Input: 'gpu_hist'` | XGBoost 3.1 removed `gpu_hist` (deprecated since 2.0) | Use `tree_method="hist"` with `device="cuda"` |
| LightGBM/CatBoost slow on a GPU instance | GPU training not enabled (LightGBM CPU build, or CatBoost without `task_type="GPU"`) | Enable GPU training and time it, or move to a CPU instance such as r5.2xlarge |
| SSH timeout during long training | Default SSH keepalive too short | Use `--keep` with nohup, or add `-o ServerAliveInterval=60` |
| Download fails but training succeeded | `EC2_VERIFY_MODELS` paths do not match the output | Check the report and model paths in the training script |
