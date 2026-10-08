#!/bin/bash
# The chaos scenario's environment (audit/STRESS-REPORT.md scenario 3): its own DB, keeper key, pause file, API port,
# lock stale time, chunk size. Source it from engine/: . stress/chaos-env.sh
export PAD_DB_FILE=data/stress/chaos.sqlite
export KEEPER_KEYPAIR_PATH=data/stress/keeper-chaos.json
export PAD_PAUSE_FILE=data/stress/chaos-PAUSED
export PAD_API_PORT=8792
export PAD_KEEPER_HEALTH_LOG=data/stress/chaos-health.log
export EPOCH_LOCK_STALE_MS=90000
export PAD_STRESS_SHIELDED_PER_TX=5
export PAD_SWAP_POLL_WINDOW_MS=20000
export TREASURY_WALLET_DIR="$PWD/data/zcash/wallets/treasury"
