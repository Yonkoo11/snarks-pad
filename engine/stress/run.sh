#!/bin/bash
# run.sh <db-file> <api-port> <log> <script> [KEY=VAL ...]: runs a stress script detached with a scenario's DB and API port.
cd "$(dirname "$0")/.." || exit 1
db="$1"; port="$2"; log="$3"; script="$4"; shift 4
env PAD_DB_FILE="$db" PAD_API_PORT="$port" "$@" nohup bun "$script" > "$log" 2>&1 &
echo $!
