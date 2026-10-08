#!/usr/bin/env bash
# Makes the keys the MAINNET instance needs, ON the server and as that instance's own user, and prints only what is public.
# Run on the server as root:
#   sudo ops/keys-setup.sh snarksm keeper     the keeper's Solana key. Made if absent, never overwritten. Prints its public key.
#   sudo ops/keys-setup.sh snarksm treasury   the Zcash mainnet treasury wallet (zcash-devtool, age identity). Made if absent.
#                                             Prints its default unified address.
#   sudo ops/keys-setup.sh snarksm seed       writes the treasury seed phrase ONCE to /root/snarksm-treasury-seed.txt (0600 root),
#                                             for the owner's paper backup (runbook G6). Prints only the word count.
#   sudo ops/keys-setup.sh snarksm pin        writes TREASURY_ZCASH_ADDRESS (the wallet's default address) and ZCASH_DEVTOOL_SHA256 (the
#                                             recorded checksum, runbook G8) into engine.env. Fills an empty value, never overwrites a different one.
#   sudo ops/keys-setup.sh snarksm seedcheck  proves the exported phrase derives the treasury's default address (offline). Prints match or fails.
#   sudo ops/keys-setup.sh snarksm status     file names, owners and modes. No contents.
#   sudo ops/keys-setup.sh <instance> signer  the pad's launch signer (Meteora's ask, 2026-10-08): the key every launch carries so trading terminals
#                                             attribute it to the pad. Made under /etc/<instance>/api-keys (the API reads it; it holds nothing), never
#                                             overwritten, LAUNCHPAD_SIGNER_PATH added to engine.env. Prints its public key. Works for both instances.
# Nothing secret is printed or put on a command line. The devnet instance's keys came from the Mac (DEPLOY.md step 4) and
# this script refuses to touch them. Paths come from the instance's engine.env, so the wallet made here is the one the engine opens.
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
. "$HERE/instance.sh"

die() { echo "keys-setup: $*" >&2; exit 1; }
[ "$(id -u)" = 0 ] || die "run as root (sudo)"
[ $# -eq 2 ] || die "usage: keys-setup.sh <instance> keeper|treasury|pin|seed|seedcheck|status|signer"
instance_load "$1" || exit 2
[ "$I_MODE" = mainnet ] || [ "$2" = signer ] || die "only the mainnet instance: the devnet keys were copied from the Mac (ops/DEPLOY.md step 4); the signer step works for both"
ENV_FILE="$I_ETC/engine.env"
[ -f "$ENV_FILE" ] || die "$ENV_FILE does not exist: provision the instance first"

setting() { # <NAME> <default>: a non-secret setting from the instance's engine.env
  local v
  v="$(sed -n "s/^$1=//p" "$ENV_FILE" | head -1)"
  echo "${v:-$2}"
}
KEEPER_KEY="$(setting KEEPER_KEYPAIR_PATH "$I_KEYS/keeper-mainnet.json")"
WALLET="$(setting TREASURY_WALLET_DIR "$I_DATA/zcash/treasury-main")"
IDENTITY="$(setting TREASURY_IDENTITY_FILE "$I_KEYS/treasury.identity.age")"
LIGHTWALLETD="$(setting ZCASH_LIGHTWALLETD zec.rocks:443)"
DEVTOOL="$(setting ZCASH_DEVTOOL_BIN "$I_BIN/zcash-devtool")"
SEED_FILE="/root/$I_NAME-treasury-seed.txt"

under() { # <path> <dir>: the path is inside the dir (no .. tricks), so a bad settings file cannot aim this at another place
  case "$1" in *..*) return 1 ;; "$2"/*) return 0 ;; *) return 1 ;; esac
}
under "$KEEPER_KEY" "$I_KEYS" || die "KEEPER_KEYPAIR_PATH is not under $I_KEYS"
under "$IDENTITY" "$I_KEYS" || die "TREASURY_IDENTITY_FILE is not under $I_KEYS"
under "$WALLET" "$I_DATA/zcash" || die "TREASURY_WALLET_DIR is not under $I_DATA/zcash"

# Runs as the instance's user with only what the binary needs; umask 077 so everything it creates is private.
as_user() { runuser -u "$I_USER" -- env -i HOME="$I_DATA" PATH=/usr/local/bin:/usr/bin:/bin RUST_LOG=warn sh -c 'umask 077; exec "$@"' sh "$@"; }

devtool_pinned() { # the binary holds the treasury key: it must be the one whose checksum was recorded when it was built (G8)
  local recorded actual
  [ "$DEVTOOL" = "$I_BIN/zcash-devtool" ] || die "ZCASH_DEVTOOL_BIN is not $I_BIN/zcash-devtool"
  # the record is "<sha256>  zcash-devtool  (commit <hash>)": the first field is the checksum (it is what engine.env pins)
  recorded="$(cut -d' ' -f1 "$I_BIN/zcash-devtool.sha256")"
  actual="$(sha256sum "$DEVTOOL" | cut -d' ' -f1)"
  [ -n "$recorded" ] && [ "$recorded" = "$actual" ] || die "$DEVTOOL does not match the checksum in $I_BIN/zcash-devtool.sha256; refusing to run it"
}

# Prints the public key; makes the key file only when it does not exist (flag wx), mode 0600, owned by the instance's user.
KEEPER_JS='
import { Keypair } from "@solana/web3.js";
import { readFileSync, writeFileSync } from "node:fs";
const path = process.env.KEYPATH;
let kp;
try {
  kp = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(path, "utf8"))));
} catch (e) {
  if (e && e.code === "ENOENT") {
    kp = Keypair.generate();
    writeFileSync(path, JSON.stringify(Array.from(kp.secretKey)), { mode: 0o600, flag: "wx" });
  } else {
    console.error("the key file exists but is not a readable keypair; nothing was changed");
    process.exit(1);
  }
}
console.log(kp.publicKey.toBase58());
'

cmd_keeper() {
  local pub
  # umask 077: the key file and anything bun creates in the service user's home stay private
  pub="$(runuser -u "$I_USER" -- env -C "$I_REPO/engine" -i HOME="$I_DATA" PATH=/usr/bin:/bin KEYPATH="$KEEPER_KEY" sh -c 'umask 077; exec "$@"' sh "$I_BIN/bun" -e "$KEEPER_JS")" \
    || die "could not make or read the keeper key"
  echo "$pub" | grep -qE '^[1-9A-HJ-NP-Za-km-z]{32,44}$' || die "unexpected answer instead of a public key"
  stat -c '%a %U:%G' "$KEEPER_KEY" | grep -qx "600 $I_USER:$I_USER" || die "$KEEPER_KEY is not 0600 $I_USER"
  echo "keeper public key (Solana): $pub"
}

wallet_ua() { # the wallet's default unified address (public), or nothing
  as_user "$DEVTOOL" wallet -w "$WALLET" list-addresses 2>/dev/null | sed -n 's/.*Default Address:[[:space:]]*\([^[:space:]]*\).*/\1/p' | head -1
}

cmd_treasury() {
  devtool_pinned
  install -d -m 700 -o "$I_USER" -g "$I_USER" "$I_DATA/zcash"
  if [ -f "$WALLET/data.sqlite" ]; then
    echo "the treasury wallet already exists: not touched"
  else
    local log
    log="$(mktemp)"; chmod 600 "$log"
    # Output is withheld on purpose: nothing a wallet-creating command prints should reach a terminal or a log.
    as_user "$DEVTOOL" wallet -w "$WALLET" init --name pad-treasury -i "$IDENTITY" -n main -s "$LIGHTWALLETD" > "$log" 2>&1 \
      || { rm -f "$log"; die "zcash-devtool wallet init failed (output withheld; check $LIGHTWALLETD is reachable and $WALLET is empty or absent)"; }
    rm -f "$log"
  fi
  chmod 600 "$IDENTITY"
  local ua
  ua="$(wallet_ua)"
  echo "$ua" | grep -qE '^u1[a-z0-9]{50,}$' || die "the wallet did not list a mainnet unified address (u1...)"
  echo "treasury unified address (Zcash mainnet): $ua"
}

cmd_seed() {
  devtool_pinned
  [ -f "$WALLET/data.sqlite" ] || die "no treasury wallet at $WALLET: run the treasury step first"
  [ ! -e "$SEED_FILE" ] || die "$SEED_FILE already exists: the seed is written once. Read it and destroy it first (see ops/DEPLOY.md), or shred it by hand."
  # The redirect is done by this root shell, so the file is root's, mode 0600; the phrase never reaches a terminal.
  if ! (umask 077; as_user "$DEVTOOL" wallet -w "$WALLET" display-mnemonic -i "$IDENTITY" --enable > "$SEED_FILE" 2>/dev/null); then
    shred -u "$SEED_FILE" 2>/dev/null || rm -f "$SEED_FILE"
    die "zcash-devtool display-mnemonic failed; nothing was written"
  fi
  local phrase_lines words
  phrase_lines="$(grep -cE '^([a-z]+ ){11,23}[a-z]+$' "$SEED_FILE" || true)"
  words="$(wc -w < "$SEED_FILE" | tr -d ' ')"
  [ "$phrase_lines" = 1 ] || die "the file does not hold exactly one line of 12-24 lowercase words (it has $phrase_lines such lines, $words words in all); it is kept at $SEED_FILE for you to check"
  stat -c '%a %U' "$SEED_FILE" | grep -qx '600 root' || die "$SEED_FILE is not 0600 root"
  echo "seed phrase written: one line, $words words, $SEED_FILE (0600 root). Not printed anywhere."
}

set_once() { # <NAME> <value>: fill an empty setting in engine.env, leave an equal one, refuse to overwrite a different one
  local current tmp
  current="$(setting "$1" "")"
  if [ -z "$current" ]; then
    tmp="$(mktemp)"
    sed "s|^$1=.*|$1=$2|" "$ENV_FILE" > "$tmp"
    grep -qx "$1=$2" "$tmp" || { rm -f "$tmp"; die "could not set $1 in $ENV_FILE (is the line missing?)"; }
    cat "$tmp" > "$ENV_FILE" # same file, so its owner and mode stay as they are
    rm -f "$tmp"
    echo "set $1"
  elif [ "$current" = "$2" ]; then
    echo "$1 is already set to this value"
  else
    die "$1 is already set to a different value: edit $ENV_FILE by hand if that is intended"
  fi
}

cmd_pin() {
  devtool_pinned
  local ua sum
  ua="$(wallet_ua)"
  echo "$ua" | grep -qE '^u1[a-z0-9]{50,}$' || die "no treasury wallet with a mainnet unified address yet: run the treasury step first"
  sum="$(cut -d' ' -f1 "$I_BIN/zcash-devtool.sha256")"
  echo "$sum" | grep -qE '^[0-9a-f]{64}$' || die "$I_BIN/zcash-devtool.sha256 does not start with a sha256"
  set_once TREASURY_ZCASH_ADDRESS "$ua"
  set_once ZCASH_DEVTOOL_SHA256 "$sum"
}

SIGNER_DIR="$I_ETC/api-keys"
SIGNER_KEY="$(setting LAUNCHPAD_SIGNER_PATH "$SIGNER_DIR/launchpad-signer.json")"
under "$SIGNER_KEY" "$SIGNER_DIR" || die "LAUNCHPAD_SIGNER_PATH is not under $SIGNER_DIR"

cmd_signer() {
  local pub
  # the API runs as the instance's user and may read this directory (the keeper's key directory stays closed to it, api.service InaccessiblePaths)
  install -d -m 700 -o "$I_USER" -g "$I_USER" "$SIGNER_DIR"
  pub="$(runuser -u "$I_USER" -- env -C "$I_REPO/engine" -i HOME="$I_DATA" PATH=/usr/bin:/bin KEYPATH="$SIGNER_KEY" sh -c 'umask 077; exec "$@"' sh "$I_BIN/bun" -e "$KEEPER_JS")" \
    || die "could not make or read the launch signer"
  echo "$pub" | grep -qE '^[1-9A-HJ-NP-Za-km-z]{32,44}$' || die "unexpected answer instead of a public key"
  stat -c '%a %U:%G' "$SIGNER_KEY" | grep -qx "600 $I_USER:$I_USER" || die "$SIGNER_KEY is not 0600 $I_USER"
  if [ -z "$(setting LAUNCHPAD_SIGNER_PATH "")" ]; then
    if grep -q '^LAUNCHPAD_SIGNER_PATH=' "$ENV_FILE"; then set_once LAUNCHPAD_SIGNER_PATH "$SIGNER_KEY"; else printf 'LAUNCHPAD_SIGNER_PATH=%s\n' "$SIGNER_KEY" >> "$ENV_FILE"; fi
  fi
  echo "launch signer public key (Solana): $pub"
  echo "restart the API to pick it up: systemctl restart $I_NAME-api"
}

cmd_seedcheck() {
  devtool_pinned
  [ -f "$SEED_FILE" ] || die "no $SEED_FILE: it was never exported, or the owner has destroyed it"
  local want got
  want="$(wallet_ua)"
  # derive-address takes the phrase as an argument, so for a moment it is on that one process's command line, readable by root only
  # (hidepid=2 hides it from every other user). Nothing is printed.
  got="$("$DEVTOOL" wallet derive-address --mnemonic "$(cat "$SEED_FILE")" -n main 2>/dev/null | sed -n 's/^Unified Address:[[:space:]]*//p' | head -1)"
  [ -n "$want" ] && [ "$got" = "$want" ] || die "the seed file does NOT derive the treasury wallet's default address: do not rely on it"
  echo "seed file derives the treasury's default address: match (nothing printed)"
}

cmd_status() {
  ls -l "$I_KEYS" | sed 1d | awk '{print $1, $3":"$4, $9}'
  [ -f "$WALLET/data.sqlite" ] && echo "wallet: present at $WALLET ($(stat -c '%a %U:%G' "$WALLET"))" || echo "wallet: none at $WALLET"
  [ -e "$SEED_FILE" ] && echo "seed export: $SEED_FILE exists ($(stat -c '%a %U' "$SEED_FILE"))" || echo "seed export: none"
}

case "$2" in
  keeper) cmd_keeper ;;
  treasury) cmd_treasury ;;
  seed) cmd_seed ;;
  pin) cmd_pin ;;
  seedcheck) cmd_seedcheck ;;
  status) cmd_status ;;
  signer) cmd_signer ;;
  *) die "unknown step '$2' (keeper, treasury, pin, seed, seedcheck, status, signer)" ;;
esac
