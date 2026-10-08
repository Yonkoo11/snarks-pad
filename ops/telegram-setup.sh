#!/usr/bin/env bash
# Finds the owner's private Telegram chat with the alert bot and saves it. Runs on the owner's Mac, after the owner has
#   1. made the bot with @BotFather (/newbot) and put its token in ~/.config/snarks-pad/alerts.env as one line, TELEGRAM_BOT_TOKEN=<token>
#   2. opened the new bot in Telegram and pressed Start
# Then: ops/telegram-setup.sh, and after it ops/push-secrets.sh for each instance (that is what sends the pair to the server).
# It asks Telegram who has written to the bot (getUpdates; it does not acknowledge them, so running it again is safe). Exactly one private
# chat: it appends TELEGRAM_CHAT_ID=<id> to the alerts file (kept 0600) and prints that person's first name, so the owner can see the chat is
# theirs. None, or more than one: it changes nothing and says so (anyone who finds the bot's name can write to it, so two chats are never
# guessed between). Then it sends one test message to the chat and prints Telegram's HTTP status.
# A TELEGRAM_CHAT_ID already in the file is used as it is, without asking Telegram, so running this again only sends another test message
# (to change the chat, delete that line first). The token reaches curl on stdin, never on a command line; the token and the chat id are
# never printed. Override the file with ALERTS_ENV_FILE. Needs curl and jq.
set -euo pipefail
umask 077
FILE="${ALERTS_ENV_FILE:-$HOME/.config/snarks-pad/alerts.env}"
. "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/envfile.sh" # value_of and the Telegram shapes

for tool in curl jq; do command -v "$tool" > /dev/null || { echo "needs $tool" >&2; exit 1; }; done
token="$(value_of "$FILE" TELEGRAM_BOT_TOKEN)"
[ -n "$token" ] || { echo "no TELEGRAM_BOT_TOKEN line in $FILE: make the bot with @BotFather (/newbot) and put its token there" >&2; exit 1; }
printf '%s\n' "$token" | grep -qE "$TELEGRAM_TOKEN_RE" || { echo "TELEGRAM_BOT_TOKEN in $FILE is not shaped like a bot token; copy it again from @BotFather" >&2; exit 1; }

nl=$'\n'
ask() { # <method> [curl options]: Telegram's answer, a newline, then the HTTP status (000 when Telegram cannot be reached)
  local method="$1"
  shift
  printf 'url = "https://api.telegram.org/bot%s/%s"\n' "$token" "$method" | curl -s --max-time 10 -w '\n%{http_code}' "$@" -K - || true
}

# One entry per private chat that has written to the bot (a group or a channel is not one), its first name stripped of control characters.
PRIVATE_CHATS='[.result[]? | (.message // .edited_message) | select(. != null and .chat.type == "private")
  | {id: .chat.id, name: ((.chat.first_name // .from.first_name // "") | explode | map(select(. > 31 and (. < 127 or . > 159))) | implode | .[0:64] | if . == "" then "(no name)" else . end)}]
  | unique_by(.id)'

chat="$(value_of "$FILE" TELEGRAM_CHAT_ID)"
if [ -n "$chat" ]; then
  printf '%s\n' "$chat" | grep -qE "$TELEGRAM_CHAT_RE" || { echo "TELEGRAM_CHAT_ID in $FILE is not a chat number; delete that line and run this again" >&2; exit 1; }
  echo "chat already saved in $FILE"
else
  answer="$(ask getUpdates)"
  code="${answer##*$nl}"
  [ "$code" = 200 ] || { echo "getUpdates answered HTTP ${code:-000}: check TELEGRAM_BOT_TOKEN in $FILE" >&2; exit 1; }
  chats="$(jq -c "$PRIVATE_CHATS" <<< "${answer%$nl*}")" || { echo "getUpdates gave an answer that is not JSON" >&2; exit 1; }
  case "$(jq length <<< "$chats")" in
    0) echo "send your bot a message first (open it in Telegram, press Start)" >&2; exit 1 ;;
    1) ;;
    *) echo "more than one private chat has written to this bot, so none was picked: put TELEGRAM_CHAT_ID=<your chat number> in $FILE by hand" >&2; exit 1 ;;
  esac
  chat="$(jq -r '.[0].id' <<< "$chats")"
  printf '%s\n' "$chat" | grep -qE "$TELEGRAM_CHAT_RE" || { echo "the chat number Telegram gave is not one this kit accepts; nothing was saved" >&2; exit 1; }
  [ -z "$(tail -c 1 "$FILE")" ] || echo >> "$FILE" # a last line without its newline would swallow the new one
  echo "TELEGRAM_CHAT_ID=$chat" >> "$FILE"
  chmod 600 "$FILE"
  echo "chat found: $(jq -r '.[0].name' <<< "$chats")"
fi

answer="$(ask sendMessage -o /dev/null --data-urlencode "chat_id=$chat" --data-urlencode "text=SNARKS pad alerts are connected.")"
code="${answer##*$nl}"
echo "test message answered HTTP ${code:-000}"
[ "$code" = 200 ]
