#!/bin/bash
# Starts the engine API for a stress scenario: start-api.sh <db-file> <port> <log>
cd "$(dirname "$0")/.." || exit 1
PAD_DB_FILE="$1" PAD_API_PORT="$2" nohup bun scripts/api.ts > "$3" 2>&1 &
echo $!
