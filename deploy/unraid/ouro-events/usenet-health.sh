#!/bin/bash

LOG="/var/log/usenet_health.log"
SAB_INI="/mnt/user/appdata/sabnzbd/sabnzbd.ini"
EVENT_PRODUCER="/boot/config/custom/ouro-events/emit-event.mjs"
EVENT_ADAPTER="/boot/config/custom/ouro-events/emit-usenet-event.sh"

while (($# > 0)); do
    case "$1" in
        --sab-ini) SAB_INI="${2:?missing --sab-ini value}"; shift 2 ;;
        --log) LOG="${2:?missing --log value}"; shift 2 ;;
        --producer) EVENT_PRODUCER="${2:?missing --producer value}"; shift 2 ;;
        --adapter) EVENT_ADAPTER="${2:?missing --adapter value}"; shift 2 ;;
        *) echo "usenet health guard: invalid argument: $1" >&2; exit 2 ;;
    esac
done

log() { echo "$(date '+%Y-%m-%d %H:%M:%S') $1" >> "$LOG"; }

emit_transition() {
    if ! /bin/bash "$EVENT_ADAPTER" "$@" >> "$LOG" 2>&1; then
        log "[EVENT] Canonical Butler event emission failed; Unraid UI and this log retain the observation or verified action."
    fi
}

/usr/local/bin/node "$EVENT_PRODUCER" --maintain >> "$LOG" 2>&1 || log "[EVENT] Spool maintenance failed; unsafe or unparseable artifacts were preserved."

SAB_KEY=$(grep -m1 '^api_key' "$SAB_INI" 2>/dev/null | cut -d= -f2 | tr -d ' ')
if [ -z "$SAB_KEY" ]; then
    log "[SAB] CRITICAL — cannot read api_key from $SAB_INI; check is blind. Exiting."
    exit 1
fi

WARN=$(curl -s --max-time 15 "http://localhost:8090/api?mode=warnings&output=json&apikey=$SAB_KEY")
AUTH_FAIL=$(echo "$WARN" | jq -r '[.warnings[]? | select(.text | test("Authentication Failed|Failed login"; "i"))] | length' 2>/dev/null)
[ -z "$AUTH_FAIL" ] && AUTH_FAIL=0

Q=$(curl -s --max-time 15 "http://localhost:8090/api?mode=queue&output=json&apikey=$SAB_KEY")
Q_STATUS=$(echo "$Q" | jq -r '.queue.status // "?"' 2>/dev/null)
Q_SLOTS=$(echo "$Q" | jq -r '.queue.noofslots // 0' 2>/dev/null)
STALLED=0
if [ "$Q_STATUS" = "Idle" ] && [ "${Q_SLOTS:-0}" -gt 0 ]; then STALLED=1; fi

# Protected spend-guard logic: volume is allowed; sustained article failure is not.
MIN_ARTICLES=50000
MIN_RATE=30
TODAY=$(date +%Y-%m-%d)
STATS=$(curl -s --max-time 20 "http://localhost:8090/api?mode=server_stats&output=json&apikey=$SAB_KEY")
TRIED=$(echo "$STATS" | jq -r --arg d "$TODAY" '[.servers[].articles_tried[$d] // 0] | add // 0' 2>/dev/null)
OKAY=$(echo "$STATS" | jq -r --arg d "$TODAY" '[.servers[].articles_success[$d] // 0] | add // 0' 2>/dev/null)
BYTES=$(echo "$STATS" | jq -r --arg d "$TODAY" '[.servers[].daily[$d] // 0] | add // 0' 2>/dev/null)
GB=$(( ${BYTES:-0} / 1000000000 ))

if [ "${TRIED:-0}" -ge "$MIN_ARTICLES" ]; then
    RATE=$(( OKAY * 100 / TRIED ))
    if [ "$RATE" -lt "$MIN_RATE" ]; then
        curl -s -o /dev/null --max-time 15 "http://localhost:8090/api?mode=pause&apikey=$SAB_KEY"
        PAUSED_AFTER=$(curl -s --max-time 15 "http://localhost:8090/api?mode=queue&output=json&apikey=$SAB_KEY" | jq -r '.queue.paused // false')
        VERIFIED_AT=$(date -u '+%Y-%m-%dT%H:%M:%S.000Z')
        VERIFICATION_DIGEST=$(printf 'sabnzbd.queue.paused=%s' "$PAUSED_AFTER" | sha256sum | cut -d' ' -f1)
        if [ "$PAUSED_AFTER" = "true" ]; then
            log "[SPEND] CRITICAL — verified the download queue is PAUSED. ${GB} GB fetched today at ${RATE}% article success (threshold ${MIN_RATE}%)."
            emit_transition "sabnzbd.pause" "spend-guard" "spend-pause:${TODAY}:verified" "sabnzbd:pause:${TODAY}:spend-guard" "Downloads were paused after article success fell below the spend guard." "At least 50,000 articles were attempted at less than 30% success; an independent queue read verified paused=true." "true" "$VERIFICATION_DIGEST" "$VERIFIED_AT"
        else
            log "[SPEND] CRITICAL — pause request was not independently verified; only a verification-failure event was emitted."
            emit_transition "sabnzbd.pause" "spend-guard" "spend-pause:${TODAY}:unverified" "sabnzbd:pause-request:${TODAY}:spend-guard" "The spend guard requested a download pause but could not verify it." "An independent SAB queue read returned paused=false; treat the protective action as unverified and investigate." "false" "$VERIFICATION_DIGEST" "$VERIFIED_AT"
        fi
    else
        log "[SPEND] OK — ${GB} GB today at ${RATE}% article success."
    fi
fi

VERIFIED_AT=$(date -u '+%Y-%m-%dT%H:%M:%S.000Z')
OBSERVED_SLOT=$(date -u '+%Y%m%dT%H%M%SZ')
if [ "$AUTH_FAIL" -eq 0 ] && [ "$STALLED" -eq 0 ]; then
    VERIFICATION_DIGEST=$(printf 'sabnzbd.auth_fail=0\nsabnzbd.stalled=0' | sha256sum | cut -d' ' -f1)
    emit_transition "usenet.observe" "provider-health" "recovered:${OBSERVED_SLOT}" "usenet:provider-health:${OBSERVED_SLOT}:recovered" "Usenet provider health recovered." "SABnzbd reports no authentication failure and no queued download stall; the Butler should verify any remaining recovery work." "true" "$VERIFICATION_DIGEST" "$VERIFIED_AT"
    tail -300 "$LOG" > "${LOG}.tmp" 2>/dev/null && mv "${LOG}.tmp" "$LOG"
    exit 0
fi

if [ "$AUTH_FAIL" -gt 0 ]; then
    SAMPLE=$(echo "$WARN" | jq -r '[.warnings[]? | select(.text | test("Authentication Failed|Failed login"; "i"))] | last | .text' 2>/dev/null)
    log "[USENET] CRITICAL — SABnzbd cannot authenticate to the news server: ${SAMPLE:0:120}"
    VERIFICATION_DIGEST=$(printf 'sabnzbd.auth_fail=1' | sha256sum | cut -d' ' -f1)
    emit_transition "usenet.observe" "provider-health" "auth-failed:${OBSERVED_SLOT}" "usenet:provider-health:${OBSERVED_SLOT}:auth-failed" "The news provider rejected SABnzbd authentication." "SAB warning history contains an authentication failure; the Butler should investigate credentials, provider status, and next steps." "true" "$VERIFICATION_DIGEST" "$VERIFIED_AT"
else
    log "[USENET] CRITICAL — SABnzbd is Idle with $Q_SLOTS job(s) queued and nothing downloading."
    VERIFICATION_DIGEST=$(printf 'sabnzbd.queue.status=Idle\nsabnzbd.queue.slots=%s' "$Q_SLOTS" | sha256sum | cut -d' ' -f1)
    emit_transition "usenet.observe" "provider-health" "stalled:${OBSERVED_SLOT}" "usenet:provider-health:${OBSERVED_SLOT}:stalled" "Usenet downloads appear stalled." "SABnzbd is idle with queued jobs; the Butler should investigate the provider and download path before deciding what to do." "true" "$VERIFICATION_DIGEST" "$VERIFIED_AT"
fi

tail -300 "$LOG" > "${LOG}.tmp" 2>/dev/null && mv "${LOG}.tmp" "$LOG"
