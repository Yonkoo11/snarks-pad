#!/usr/bin/env bash
# Installs the launchd job on the owner's Mac that runs ops/pull-backups.sh every 6 hours (and once at load).
set -euo pipefail
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LABEL=com.snarks.backup-pull
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
mkdir -p "$REPO/backups-remote" "$HOME/Library/LaunchAgents"; chmod 0700 "$REPO/backups-remote"
cat > "$PLIST" <<PL
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key><array><string>/bin/bash</string><string>$REPO/ops/pull-backups.sh</string></array>
  <key>EnvironmentVariables</key><dict><key>PATH</key><string>/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin</string></dict>
  <key>StartInterval</key><integer>21600</integer>
  <key>RunAtLoad</key><true/>
  <key>StandardOutPath</key><string>$REPO/backups-remote/launchd.log</string>
  <key>StandardErrorPath</key><string>$REPO/backups-remote/launchd.log</string>
</dict></plist>
PL
launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" "$PLIST"
echo "installed $LABEL: pulls every 6 h into $REPO/backups-remote (0700)"
