#!/usr/bin/env bash
# Shared by the scripts that run on the owner's Mac and read the owner's private env files (push-secrets.sh, telegram-setup.sh).
# Source it: it only defines things, prints nothing and reads no file by itself.

value_of() { # <file> <NAME>: the value of the first NAME=... line (optional "export", optional quotes), or nothing
  local line v dq='"' sq="'"
  [ -f "$1" ] || return 0
  while IFS= read -r line || [ -n "$line" ]; do
    line="${line#"${line%%[![:space:]]*}"}" # leading blanks
    case "$line" in
      "$2="* | "export $2="*)
        v="${line#*=}"
        v="${v%"${v##*[![:space:]]}"}" # trailing blanks
        v="${v#[$dq$sq]}"; v="${v%[$dq$sq]}"
        printf '%s' "$v"
        return 0
        ;;
    esac
  done < "$1"
}

# Telegram: a bot token is digits, a colon, then 30 to 50 letters, digits, _ or -. A chat id is digits, with a leading - for a group.
# Both are written into an env file line and into a curl config, so nothing else may pass.
TELEGRAM_TOKEN_RE='^[0-9]{6,12}:[A-Za-z0-9_-]{30,50}$'
TELEGRAM_CHAT_RE='^-?[0-9]{5,20}$'
