#!/usr/bin/env bash
# Health check (systemd timer, every 5 minutes). Exits 1, writes a line to the journal and posts to the optional
# webhook (ALERT_WEBHOOK_URL) and to Telegram (TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID, both needed) when: the API does
# not answer, payouts are paused, an epoch needs attention, the keeper's health log is
# older than 15 minutes (it writes a heartbeat every 10), the API or keeper unit is not active, the disk is over
# 85% full, or the server's clock is not synchronised (the launch window's fee is read off the clock: ops/timesync.sh,
# ops/MAINNET-RUNBOOK.md G14). Needs curl, jq, sqlite3 and timedatectl.
# Which instance: PAD_INSTANCE from that instance's engine.env (snarks, the devnet demo, when it is not set); its API
# port is PAD_API_PORT (8787 when it is not set). The message starts with the instance name, so two instances on one
# box cannot be mistaken for each other. Each answer is logged as a status code only, never the address or the token.
# Telegram's address contains the bot token, so it reaches curl on stdin (-K -), never on a command line.
# It also forwards the engine's own open alerts (rpc_budget, faucet_low, a parked epoch, short holder samples, ...), which the engine only stores
# and logs: the alerts table of the instance's database (PAD_DB_FILE), read as src/db.ts listOpenAlerts reads it, opened read-only so that it works
# while the API or the chain is down. Each alert is sent once, as one line "<instance> alert <kind>: <text>" (the text as the engine stored it, already
# masked; cut at 300 characters; at most 4 lines a message, the rest follow at the next check) with the health problems when there are any. What was sent
# is remembered in PAD_HEALTH_ALERTS_SENT (default /var/lib/<instance>/data/health-alerts-sent, 0600, the instance user's): the open alerts already
# sent. A message that no channel accepted (none set, or no answer in the 2xx range) is not remembered, so the next check sends it again. An alert
# alone does not fail the check (a dry faucet is not an outage), and a database that is missing or cannot be read is not a failure either.
set -uo pipefail
INSTANCE="${PAD_INSTANCE:-snarks}"
API="${HEALTH_API:-http://127.0.0.1:${PAD_API_PORT:-8787}/api}"
LOG="${PAD_KEEPER_HEALTH_LOG:-/var/lib/$INSTANCE/data/keeper-health.log}"
DB="${PAD_DB_FILE:-/var/lib/$INSTANCE/data/devnet.sqlite}"
SENT="${PAD_HEALTH_ALERTS_SENT:-/var/lib/$INSTANCE/data/health-alerts-sent}"
case "$INSTANCE" in snarks) LABEL="Test site" ;; snarksm) LABEL="Mainnet" ;; *) LABEL="$INSTANCE" ;; esac # what the owner reads on the phone
MAX_ALERT_LINES=4
nl=$'\n'
# The open alerts, one line each: id, time, kind and the text on one line (newlines and tabs made spaces), tab-separated.
OPEN_ALERTS_SQL="SELECT id || char(9) || at || char(9) || kind || char(9) || CASE WHEN length(flat) > 300 THEN substr(flat, 1, 297) || '...' ELSE flat END
  FROM (SELECT id, at, kind, replace(replace(replace(message, char(13), ' '), char(10), ' '), char(9), ' ') AS flat FROM alerts WHERE resolvedAt IS NULL)
  ORDER BY id"
db_read=0 open_keys="" new_keys="" alert_lines="" sent_keys=""

send_message() { # <text>: to the webhook and to Telegram, whichever are set. Succeeds when at least one answered in the 2xx range.
  local text="$1" code delivered=1
  if [ -n "${ALERT_WEBHOOK_URL:-}" ]; then
    code="$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 -H 'content-type: application/json' -d "$(jq -n --arg c "$text" '{content:$c}')" "$ALERT_WEBHOOK_URL")" || code=000
    echo "alert webhook answered HTTP $code" >&2
    case "$code" in 2??) delivered=0 ;; esac
  fi
  if [ -n "${TELEGRAM_BOT_TOKEN:-}" ] && [ -n "${TELEGRAM_CHAT_ID:-}" ]; then
    code="$(printf 'url = "https://api.telegram.org/bot%s/sendMessage"\n' "$TELEGRAM_BOT_TOKEN" | curl -s -o /dev/null -w '%{http_code}' --max-time 10 --data-urlencode "chat_id=$TELEGRAM_CHAT_ID" --data-urlencode "text=$text" -K -)" || code=000
    echo "telegram answered HTTP $code" >&2
    case "$code" in 2??) delivered=0 ;; esac
  elif [ -n "${TELEGRAM_BOT_TOKEN:-}${TELEGRAM_CHAT_ID:-}" ]; then
    echo "telegram not used: TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID must both be set" >&2
  fi
  return "$delivered"
}

read_engine_alerts() { # the open alerts that were not sent before, at most MAX_ALERT_LINES: sets alert_lines and new_keys; open_keys is every open alert
  local rows id at kind text key count=0
  [ -f "$DB" ] || return 0
  command -v sqlite3 > /dev/null || { echo "engine alerts not read: sqlite3 is not installed" >&2; return 0; }
  rows="$(sqlite3 -readonly -cmd '.timeout 3000' "$DB" "$OPEN_ALERTS_SQL" 2> /dev/null)" || { echo "engine alerts not read: $DB could not be queried" >&2; return 0; }
  db_read=1
  while IFS=$'\t' read -r id at kind text; do
    [ -n "$id" ] || continue
    key="$id|$at" # the time too, so a database made again from scratch does not look like the old one
    open_keys="$open_keys$key$nl"
    if [ -f "$SENT" ] && grep -qxF -- "$key" "$SENT"; then continue; fi
    [ "$count" -lt "$MAX_ALERT_LINES" ] || continue
    count=$((count + 1))
    new_keys="$new_keys$key$nl"
    alert_lines="${alert_lines:+$alert_lines$nl}$LABEL alert $kind: $text"
  done <<< "$rows"
}

remember_alerts() { # the file keeps the open alerts that were sent before and those this run delivered; an alert that was resolved drops out
  local key kept="" tmp="$SENT.$$"
  [ "$db_read" = 1 ] || return 0
  while IFS= read -r key; do
    [ -n "$key" ] || continue
    if grep -qxF -- "$key" <<< "$sent_keys" || { [ -f "$SENT" ] && grep -qxF -- "$key" "$SENT"; }; then kept="$kept$key$nl"; fi
  done <<< "$open_keys"
  [ -n "$kept" ] || [ -f "$SENT" ] || return 0
  ( umask 077; printf '%s' "$kept" > "$tmp" ) && mv -f "$tmp" "$SENT" || { rm -f "$tmp"; echo "alert state not written to $SENT: the open engine alerts will be sent again at the next check" >&2; }
}

problems=()
t="$(curl -fsS --max-time 10 "$API/treasury")" || problems+=("API does not answer")
if [ -n "${t:-}" ]; then
  [ "$(jq -r .paused <<<"$t")" = "false" ] || problems+=("payouts are PAUSED")
  [ "$(jq -r .epochsNeedingAttention <<<"$t")" = "0" ] || problems+=("$(jq -r .epochsNeedingAttention <<<"$t") epoch(s) need attention")
  # A round still not done PAD_HEALTH_OVERDUE_MINUTES (default 120) after it was due: a keeper with no SOL, a chain it cannot read or a swap that does not
  # finish all look like this from outside (devnet, 2026-10-06: a dry keeper failed every claim for 21 hours and nothing alerted). Not while payouts are paused.
  due="$(jq -r '(.nextEpochAt // empty) | sub("\\.[0-9]+Z$"; "Z") | fromdateiso8601' <<<"$t" 2>/dev/null)" || due=""
  if [ -n "$due" ] && [ "$(jq -r .paused <<<"$t")" = "false" ]; then
    late=$(( $(date +%s) - due ))
    [ "$late" -lt $(( ${PAD_HEALTH_OVERDUE_MINUTES:-120} * 60 )) ] || problems+=("payout round overdue by $(( late / 3600 ))h $(( late % 3600 / 60 ))m (it was due $(jq -r .nextEpochAt <<<"$t"))")
  fi
fi
if [ -f "$LOG" ]; then
  age=$(( $(date +%s) - $(stat -c %Y "$LOG") ))
  [ "$age" -lt 900 ] || problems+=("keeper health log is ${age}s old")
else
  problems+=("no keeper health log")
fi
for u in "$INSTANCE-api" "$INSTANCE-keeper"; do systemctl is-active --quiet "$u" || problems+=("$u is not active"); done
use="$(df --output=pcent "/var/lib/$INSTANCE" | tail -1 | tr -dc 0-9)"
[ "$use" -lt 85 ] || problems+=("disk ${use}% full")
case "$(timedatectl show -p NTPSynchronized --value 2>/dev/null)" in
  yes) ;;
  no) problems+=("server clock is NOT synchronised (timedatectl NTPSynchronized=no): sudo ops/timesync.sh") ;;
  *) problems+=("cannot tell whether the server clock is synchronised (timedatectl gave no answer)") ;;
esac
read_engine_alerts
# The problems line goes to the journal every run, and to the phone once when it appears, again when its text changes, and otherwise at most every
# PAD_HEALTH_REPEAT_MINUTES (default 60) while it stands (2026-10-07: a parked round sent the owner the same line every 5 minutes); when it clears,
# one "recovered" line. PAD_HEALTH_PROBLEMS_SENT (default /var/lib/<instance>/data/health-problems-sent) keeps when and what was last sent.
problems_text=""; [ "${#problems[@]}" -eq 0 ] || problems_text="$LABEL: $(IFS=';'; echo "${problems[*]}")"
PSENT="${PAD_HEALTH_PROBLEMS_SENT:-/var/lib/$INSTANCE/data/health-problems-sent}"
last_at=0; last_text=""
if [ -f "$PSENT" ]; then last_at="$(sed -n 1p "$PSENT")"; last_text="$(sed -n '2,$p' "$PSENT")"; fi
case "$last_at" in ''|*[!0-9]*) last_at=0 ;; esac
say_problems=""
if [ -n "$problems_text" ]; then
  if [ "$problems_text" != "$last_text" ] || [ $(( $(date +%s) - last_at )) -ge $(( ${PAD_HEALTH_REPEAT_MINUTES:-60} * 60 )) ]; then say_problems="$problems_text"; fi
elif [ -n "$last_text" ]; then
  say_problems="$LABEL: recovered (was: ${last_text#"$LABEL: "})"
fi
[ -z "$problems_text" ] || echo "$problems_text" >&2
msg="$say_problems"
[ -z "$alert_lines" ] || msg="${msg:+$msg$nl}$alert_lines"
if [ -n "$msg" ]; then
  [ -z "$alert_lines" ] || echo "$alert_lines" >&2
  if send_message "$msg"; then
    sent_keys="$new_keys"
    if [ -n "$say_problems" ]; then
      if [ -n "$problems_text" ]; then ( umask 077; printf '%s\n%s' "$(date +%s)" "$problems_text" > "$PSENT" ) || echo "problem state not written to $PSENT: the line will be sent again at the next check" >&2
      else rm -f "$PSENT"; fi
    fi
  fi
fi
remember_alerts
[ "${#problems[@]}" -eq 0 ] || exit 1
echo "$INSTANCE health: ok"
