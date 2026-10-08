#!/bin/bash
# The soak scenario's environment (audit/STRESS-REPORT.md scenario 4). Source it from engine/: . stress/soak-env.sh
# Epochs every 10 minutes, Solana-only (the Zcash treasury is shared with the chaos run), 4 holder samples per window.
export PAD_DB_FILE=data/stress/soak.sqlite
export KEEPER_KEYPAIR_PATH=data/stress/keeper-soak.json
export PAD_PAUSE_FILE=data/stress/soak-PAUSED
export PAD_API_PORT=8793
export PAD_KEEPER_HEALTH_LOG=data/stress/soak-health.log
export PAD_EPOCH_EVERY_MS=600000
export PAD_SHIELDED_EVERY_DAYS=999
export PAD_KEEPER_TICK_MS=10000
export PAD_RESUME_EVERY_MS=30000
export PAD_SNAPSHOT_COUNT=4
export EPOCH_LOCK_STALE_MS=60000
