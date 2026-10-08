#!/usr/bin/env bash
# Writes /etc/<instance>/secrets.env on the server from the owner's private files on THIS Mac, over ssh stdin.
# Nothing is typed, echoed or put on a command line: the values live in this script's variables and in the pipe, and the
# only output is variable NAMES with set or empty. Run on the Mac:
#   ops/push-secrets.sh snarksm    SOLANA_MAINNET_RPC (the Helius mainnet URL built from the key), HELIUS_API_KEY, ALERT_WEBHOOK_URL, TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID
#   ops/push-secrets.sh snarks     [SOLANA_DEVNET_RPC,] HELIUS_API_KEY, ALERT_WEBHOOK_URL, TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID (replaces the devnet file: read DEPLOY.md first)
# Sources (override with PAD_ENV_FILE, ALERTS_ENV_FILE and RPC_URL_FILE):
#   ~/.config/snarks-pad/rpc.env             one line, HELIUS_API_KEY=<key>   (the same file the engine's devnet mode reads)
#   ~/.config/snarks-pad/alerts.env          ALERT_WEBHOOK_URL=<https url>    (may be empty: the line is then written empty)
#                                            TELEGRAM_BOT_TOKEN=<the token @BotFather gave>, TELEGRAM_CHAT_ID=<number> (ops/telegram-setup.sh finds and saves
#                                            it). Either may be empty; the health check sends to Telegram only when both are set. Their shapes are checked
#                                            first, and a value of the wrong shape stops the push.
#   ~/.config/snarks-pad/rpc-quicknode.env   optional, the devnet instance only: one line, QUICKNODE_DEVNET_URL=<the provider's full https URL>
#                                            It is written as SOLANA_DEVNET_RPC, which the engine prefers to the Helius key. With it the Helius key
#                                            may be missing (the line is then written empty). Its variable name differs from the engine's on purpose:
#                                            nothing on the Mac reads it, so the server's endpoint is never spent from here. No such line, no
#                                            SOLANA_DEVNET_RPC line is written, so a value in engine.env stands.
# The file on the server is root:root 0600, replaced atomically; systemd reads it as root, the service user never can.
#   ops/push-secrets.sh <instance> api       the API's OWN key (audit S6, product decision 5): writes /etc/<instance>/secrets-api.env with
#                                            HELIUS_API_KEY and, on mainnet, SOLANA_MAINNET_RPC built from it, read from
#                                            ~/.config/snarks-pad/rpc-api.env (override with PAD_API_ENV_FILE). api.service reads that file after
#                                            secrets.env, so the API runs on this key and the keeper keeps the shared one. Nothing else is written there.
HOST_CONF="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/host.conf"; [ -z "${SNARKS_HOST:-}" ] && [ -f "$HOST_CONF" ] && . "$HOST_CONF"
set -euo pipefail
INSTANCE="${1:-}"
ROLE="${2:-shared}"
case "$INSTANCE" in snarks | snarksm) ;; *) echo "usage: ops/push-secrets.sh <snarks|snarksm> [api]" >&2; exit 2 ;; esac
case "$ROLE" in shared | api) ;; *) echo "usage: ops/push-secrets.sh <snarks|snarksm> [api]" >&2; exit 2 ;; esac
HOST="${SNARKS_HOST:?set SNARKS_HOST (deploy@<server>) or create ops/host.conf}"
RPC_FILE="${PAD_ENV_FILE:-$HOME/.config/snarks-pad/rpc.env}"
[ "$ROLE" != api ] || RPC_FILE="${PAD_API_ENV_FILE:-$HOME/.config/snarks-pad/rpc-api.env}"
ALERTS_FILE="${ALERTS_ENV_FILE:-$HOME/.config/snarks-pad/alerts.env}"
RPC_URL_FILE="${RPC_URL_FILE:-$HOME/.config/snarks-pad/rpc-quicknode.env}"

. "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/envfile.sh" # value_of and the Telegram shapes

key="$(value_of "$RPC_FILE" HELIUS_API_KEY)"
hook="$(value_of "$ALERTS_FILE" ALERT_WEBHOOK_URL)"
tg_token="$(value_of "$ALERTS_FILE" TELEGRAM_BOT_TOKEN)"
tg_chat="$(value_of "$ALERTS_FILE" TELEGRAM_CHAT_ID)"
url=""
[ "$INSTANCE" != snarks ] || url="$(value_of "$RPC_URL_FILE" QUICKNODE_DEVNET_URL)"
if [ -z "$key" ] && [ -z "$url" ]; then
  if [ "$INSTANCE" = snarks ]; then echo "no HELIUS_API_KEY line in $RPC_FILE and no QUICKNODE_DEVNET_URL line in $RPC_URL_FILE" >&2; else echo "no HELIUS_API_KEY line in $RPC_FILE" >&2; fi
  exit 1
fi
if [ -n "$key" ]; then
  echo "$key" | grep -qE '^[A-Za-z0-9_-]{8,128}$' || { echo "the key in $RPC_FILE has characters a URL key never has; not pushing it" >&2; exit 1; }
fi
if [ -n "$url" ]; then
  # An https address of plain URL characters (no quote, space, backslash, dollar or hash): it goes into an env file line as it is.
  { [ "${#url}" -le 512 ] && printf '%s\n' "$url" | grep -qE '^https://[A-Za-z0-9.-]+(:[0-9]{1,5})?(/[A-Za-z0-9._~%:@+=/-]*)?(\?[A-Za-z0-9._~%:@+=&/-]*)?$'; } \
    || { echo "QUICKNODE_DEVNET_URL in $RPC_URL_FILE is not a plain https URL of at most 512 characters; not pushing it" >&2; exit 1; }
fi
if [ -n "$hook" ]; then
  echo "$hook" | grep -qE "^https://[^[:space:]\"'\\\\]+\$" || { echo "ALERT_WEBHOOK_URL in $ALERTS_FILE is not a plain https URL; not pushing it" >&2; exit 1; }
fi
if [ -n "$tg_token" ]; then
  printf '%s\n' "$tg_token" | grep -qE "$TELEGRAM_TOKEN_RE" || { echo "TELEGRAM_BOT_TOKEN in $ALERTS_FILE is not shaped like a bot token (digits, a colon, 30 to 50 letters, digits, _ or -); not pushing it" >&2; exit 1; }
fi
if [ -n "$tg_chat" ]; then
  printf '%s\n' "$tg_chat" | grep -qE "$TELEGRAM_CHAT_RE" || { echo "TELEGRAM_CHAT_ID in $ALERTS_FILE is not a chat number (5 to 20 digits, a group's starts with -); not pushing it" >&2; exit 1; }
fi
[ "${tg_token:+x}" = "${tg_chat:+x}" ] || echo "note: only one of TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID is set, so no Telegram alert is sent until both are (ops/telegram-setup.sh finds the chat)" >&2

nl=$'\n'
body="# written by ops/push-secrets.sh; root:root 0600; values never printed${nl}"
if [ "$ROLE" = api ]; then
  [ -n "$key" ] || { echo "no HELIUS_API_KEY line in $RPC_FILE (the API's own key)" >&2; exit 1; }
  [ "$INSTANCE" != snarksm ] || body="${body}SOLANA_MAINNET_RPC=https://mainnet.helius-rpc.com/?api-key=${key}${nl}"
  body="${body}HELIUS_API_KEY=${key}${nl}"
  DEST="/etc/$INSTANCE/secrets-api.env"
else
  [ "$INSTANCE" != snarksm ] || body="${body}SOLANA_MAINNET_RPC=https://mainnet.helius-rpc.com/?api-key=${key}${nl}"
  [ -z "$url" ] || body="${body}SOLANA_DEVNET_RPC=${url}${nl}"
  body="${body}HELIUS_API_KEY=${key}${nl}ALERT_WEBHOOK_URL=${hook}${nl}TELEGRAM_BOT_TOKEN=${tg_token}${nl}TELEGRAM_CHAT_ID=${tg_chat}${nl}"
  DEST="/etc/$INSTANCE/secrets.env"
fi
printf '%s' "$body" | ssh -o BatchMode=yes -o ConnectTimeout=20 "$HOST" \
  "sudo sh -c 'umask 077; cat > $DEST.new && chown root:root $DEST.new && chmod 600 $DEST.new && mv $DEST.new $DEST'"
unset key hook url tg_token tg_chat body

# Read back names only: which variables exist and whether each has a value.
ssh -o BatchMode=yes -o ConnectTimeout=20 "$HOST" \
  "sudo awk -F= '/^[A-Z_]+=/ { print \"  \" \$1 \" = \" (length(\$0) > length(\$1) + 1 ? \"<set>\" : \"<empty>\") }' $DEST; sudo stat -c '  %a %U:%G %s bytes' $DEST"
