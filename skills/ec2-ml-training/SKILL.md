---
name: ec2-ml-training
description: Use when an ML training run needs more RAM or a GPU than the local machine has and should run on a temporary EC2 instance. Covers the config and workflow script split, instance and algorithm selection, S3 data transfer, XGBoost 3.x GPU settings, cost rules and common failure modes.
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

# CPU training (use for LightGBM/CatBoost, which gain little from a GPU)
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

| Instance | vCPU | RAM | GPU | On-demand $/hr | When to use |
|---|---|---|---|---|---|
| g4dn.xlarge | 4 | 16 GB | T4 | 0.53 | Small datasets only. OOM risk on large ones. |
| g4dn.2xlarge | 8 | 32 GB | T4 | 0.75 | XGBoost GPU training on large datasets |
| r5.2xlarge | 8 | 64 GB | None | 0.50 | CPU training, LightGBM/CatBoost, dataset builds. Lowest price per GB of RAM of the three. |

Prices are Linux on-demand rates as recorded 2026-05. Verify current pricing
for your region before relying on them.

### Size RAM for feature preparation, not for the file

In one recorded run, a dataset of about 1M rows by 553 numeric columns needed
15 to 20 GB once loaded, prepared and trained on, and a g4dn.xlarge (16 GB) was
OOM-killed during SHAP feature selection. Choose an instance with at least
twice the expected in-memory size of the prepared dataset.

### On-demand vs Spot

Use **on-demand** for model training (long-running; losing mid-train progress is
costly). Spot is appropriate only for stateless tasks such as dataset builds
that can be retried cheaply.

## Algorithm selection and GPU benefit

| Algorithm | GPU benefit | Recorded run (800K rows, 60 trials) | Instance |
|---|---|---|---|
| **XGBoost** | **Yes** (`device="cuda"`, 3 to 5x faster) | about 19 min GPU, about 60 min CPU | g4dn.2xlarge |
| **LightGBM** | **No** (CPU-only in practice) | about 45 min CPU | r5.2xlarge |
| **CatBoost** | Marginal (`task_type="GPU"`) | about 45 min | r5.2xlarge |

Timings come from one recorded run. Treat them as order of magnitude.

### When to benchmark multiple algorithms

- **Easy tasks** (PR-AUC > 0.90, e.g. a volatility-style target): **XGBoost only.** The algorithms converge to the same answer, and benchmarking wastes GPU time.
- **Hard tasks** (PR-AUC < 0.60, e.g. the sign of a short-horizon return): **Benchmark XGBoost first**, then LightGBM/CatBoost on the 1 or 2 most promising sub-models only.
- **Categorical-heavy tasks**: CatBoost's native categorical handling may help. Worth benchmarking.

### Optuna trial count guidance

| Task difficulty | PR-AUC range | Recommended trials |
|---|---|---|
| Easy | > 0.85 | 20 to 30 |
| Medium | 0.50 to 0.85 | 40 to 60 |
| Hard | < 0.50 | 60 to 80 |

## XGBoost 3.x GPU configuration

XGBoost 3.x **removed `gpu_hist`**. Use:

```python
# CORRECT (XGBoost 3.x)
xgb.XGBClassifier(
    tree_method="hist",
    device="cuda",  # or "cpu"
)

# WRONG (XGBoost 2.x, errors on 3.x)
xgb.XGBClassifier(
    tree_method="gpu_hist",  # Invalid in 3.x
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

1. **Do not benchmark every algorithm on easy tasks.** If XGBoost reaches PR-AUC > 0.85, LightGBM and CatBoost will not differ materially. Skip them.
2. **Match the instance to the algorithm.** A GPU (g4dn) only helps XGBoost. For LightGBM/CatBoost, use r5.2xlarge (more RAM, lower price).
3. **Reduce trials on predictable tasks.** 60 Optuna trials is excessive when the CV score plateaus by trial 20. Check with fewer trials first.
4. **Gate before expanding.** Do not train downstream models until upstream gates pass. Do not benchmark 3 algorithms until 1 algorithm shows the task is viable.
5. **Terminate promptly.** At the recorded 0.75 $/hr, a g4dn.2xlarge left idle for 12 hours costs 9 dollars.
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
| `Invalid Input: 'gpu_hist'` | XGBoost 3.x API change | Use `tree_method="hist"` with `device="cuda"` |
| LightGBM/CatBoost slow | Running on a GPU instance with no GPU benefit | Use r5.2xlarge (CPU) instead: same speed, lower price |
| SSH timeout during long training | Default SSH keepalive too short | Use `--keep` with nohup, or add `-o ServerAliveInterval=60` |
| Download fails but training succeeded | `EC2_VERIFY_MODELS` paths do not match the output | Check the report and model paths in the training script |
