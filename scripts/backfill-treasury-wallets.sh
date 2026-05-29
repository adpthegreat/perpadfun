#!/usr/bin/env bash
#
# Backfill tokens.treasury_wallet_address so the column can be made NOT NULL.
# Closes cause H / fix 2c (KEEPER_P1_FIXES.md) and LAUNCH_REFACTOR.md follow-up #1.
# Full write-up: TREASURY_WALLET_BACKFILL.md.
#
# The backfill logic lives server-side in the app route
#   src/routes/api/admin/backfill-treasury-wallets.ts
# (it needs the treasury secret + supabaseAdmin, which only exist in the app
# runtime). This script just drives that endpoint safely: dry-run -> review ->
# apply -> verify, then tells you the exact migration command.
#
# Requirements: bash, curl, jq.
#
# Usage:
#   APP_URL=https://perpad.fun KEEPER_SECRET=xxxx scripts/backfill-treasury-wallets.sh            # dry-run only (safe default)
#   APP_URL=https://perpad.fun KEEPER_SECRET=xxxx scripts/backfill-treasury-wallets.sh --apply     # write, with confirmation
set -euo pipefail

APP_URL="${APP_URL:?set APP_URL, e.g. https://perpad.fun (no trailing slash)}"
KEEPER_SECRET="${KEEPER_SECRET:?set KEEPER_SECRET}"
ENDPOINT="${APP_URL%/}/api/admin/backfill-treasury-wallets"
MODE="${1:-}"
HDR=(-H "x-keeper-secret: ${KEEPER_SECRET}")

command -v jq >/dev/null || { echo "jq is required"; exit 1; }

echo "==> 1/4 Dry-run (no writes)"
DRY="$(curl -fsS -X POST "${ENDPOINT}?dryRun=1" "${HDR[@]}")"
COUNT="$(echo "${DRY}" | jq -r '.count')"

echo "   null-wallet tokens: ${COUNT}"
echo "${DRY}" | jq -r '.plan | group_by(.cohort)[] | "   cohort=\(.[0].cohort): \(length)"'

if [ "${COUNT}" = "0" ]; then
  echo "==> Nothing to backfill. Safe to apply the constraint migration now (step 4)."
  exit 0
fi

echo
echo "   --- plan (review these) ---"
printf "   %-14s %-11s %-26s %-9s %s\n" COHORT STATUS CREATED_AT LAUNCHED TICKER/ID
echo "${DRY}" | jq -r '.plan[] | "   \(.cohort)\t\(.status)\t\(.created_at)\t\(.launched)\t\(.ticker // .id)"' | column -t -s $'\t'
echo
echo "   REVIEW RULE:"
echo "     - every 'subwallet' row should be RECENT (created after sub-wallets shipped)."
echo "     - every 'legacy_master' row should be status=deprecated."
echo "     - a NON-deprecated row with an OLD created_at is the one risky case -> stop and investigate."

if [ "${MODE}" != "--apply" ]; then
  echo
  echo "==> Dry-run only. Re-run with --apply to write these ${COUNT} rows."
  exit 0
fi

echo
read -r -p "Apply backfill to ${COUNT} rows? [y/N] " ANS
[ "${ANS}" = "y" ] || [ "${ANS}" = "Y" ] || { echo "aborted"; exit 1; }

echo "==> 2/4 Applying backfill"
echo "$(curl -fsS -X POST "${ENDPOINT}" "${HDR[@]}")" | jq

echo "==> 3/4 Verifying 0 nulls remain"
REMAIN="$(curl -fsS -X POST "${ENDPOINT}?dryRun=1" "${HDR[@]}" | jq -r '.count')"
echo "   remaining null-wallet tokens: ${REMAIN}"
if [ "${REMAIN}" != "0" ]; then
  echo "ERROR: ${REMAIN} rows still null. Do NOT apply the NOT NULL migration. Investigate first."
  exit 1
fi

echo
echo "==> 4/4 Backfill complete. Apply the constraint to lock it in:"
echo "      supabase db push   # applies supabase/migrations/20260529160000_token_wallet_not_null.sql"
echo "   (or run the single migration via your normal Supabase deploy flow)"
