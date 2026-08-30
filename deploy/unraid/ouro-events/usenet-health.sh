#!/bin/bash

LOG="/var/log/usenet_health.log"
SAB_INI="/mnt/user/appdata/sabnzbd/sabnzbd.ini"
NZB_INDEXER_NAME="NZBgeek"
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

notify_unraid() {
    local subject="$1" desc="$2" sev="${3:-warning}"
    if [ -x /usr/local/emhttp/webGui/scripts/notify ]; then
        /usr/local/emhttp/webGui/scripts/notify -e "usenet_health" -s "$subject" -d "$desc" -i "$sev" >/dev/null 2>&1
    fi
}

emit_transition() {
    if ! /bin/bash "$EVENT_ADAPTER" "$@" >> "$LOG" 2>&1; then
        log "[EVENT] Canonical Butler event emission failed; Unraid UI and this log retain the verified action."
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
            notify_unraid "Usenet spend guard: downloads paused" "The queue was verified paused after at least 50,000 articles fell below 30% success. The Butler will investigate." "alert"
            emit_transition "sabnzbd.pause" "spend-guard" "spend-pause:${TODAY}:verified" "sabnzbd:pause:${TODAY}:spend-guard" "Downloads were paused after article success fell below the spend guard." "At least 50,000 articles were attempted at less than 30% success; an independent queue read verified paused=true." "true" "$VERIFICATION_DIGEST" "$VERIFIED_AT"
        else
            log "[SPEND] CRITICAL — pause request was not independently verified; only a verification-failure event was emitted."
            emit_transition "sabnzbd.pause" "spend-guard" "spend-pause:${TODAY}:unverified" "sabnzbd:pause-request:${TODAY}:spend-guard" "The spend guard requested a download pause but could not verify it." "An independent SAB queue read returned paused=false; treat the protective action as unverified and investigate." "false" "$VERIFICATION_DIGEST" "$VERIFIED_AT"
        fi
    else
        log "[SPEND] OK — ${GB} GB today at ${RATE}% article success."
    fi
fi

if [ "$AUTH_FAIL" -eq 0 ] && [ "$STALLED" -eq 0 ]; then
    PROWL_DIR=$(docker inspect prowlarr --format '{{range .Mounts}}{{if eq .Destination "/config"}}{{.Source}}{{end}}{{end}}' 2>/dev/null)
    PKEY=$(grep -oP '(?<=<ApiKey>)[^<]+' "$PROWL_DIR/config.xml" 2>/dev/null)
    if [ -n "$PKEY" ]; then
        STILL_OFF=$(curl -s --max-time 15 -H "X-Api-Key: $PKEY" "http://localhost:9696/api/v1/indexer" | jq -r --arg n "$NZB_INDEXER_NAME" '[.[] | select(.name==$n and .enable==false)] | length' 2>/dev/null)
        if [ "${STILL_OFF:-0}" -gt 0 ]; then log "[USENET] Server auth is healthy again, but $NZB_INDEXER_NAME is still disabled; recovery remains a Butler/operator decision."; fi
    fi
    tail -300 "$LOG" > "${LOG}.tmp" 2>/dev/null && mv "${LOG}.tmp" "$LOG"
    exit 0
fi

if [ "$AUTH_FAIL" -gt 0 ]; then
    SAMPLE=$(echo "$WARN" | jq -r '[.warnings[]? | select(.text | test("Authentication Failed|Failed login"; "i"))] | last | .text' 2>/dev/null)
    log "[USENET] CRITICAL — SABnzbd cannot authenticate to the news server: ${SAMPLE:0:120}"
else
    log "[USENET] CRITICAL — SABnzbd is Idle with $Q_SLOTS job(s) queued and nothing downloading."
fi

PROWL_DIR=$(docker inspect prowlarr --format '{{range .Mounts}}{{if eq .Destination "/config"}}{{.Source}}{{end}}{{end}}' 2>/dev/null)
PKEY=$(grep -oP '(?<=<ApiKey>)[^<]+' "$PROWL_DIR/config.xml" 2>/dev/null)
if [ -z "$PKEY" ]; then
    log "[USENET] Could not read Prowlarr API key — no protective indexer action was attempted."
    tail -300 "$LOG" > "${LOG}.tmp" 2>/dev/null && mv "${LOG}.tmp" "$LOG"
    exit 1
fi

IDX=$(curl -s --max-time 15 -H "X-Api-Key: $PKEY" "http://localhost:9696/api/v1/indexer" | jq -c --arg n "$NZB_INDEXER_NAME" '.[] | select(.name==$n)' 2>/dev/null)
if [ -z "$IDX" ]; then
    log "[USENET] Indexer '$NZB_INDEXER_NAME' not found; no action was attempted."
elif [ "$(echo "$IDX" | jq -r '.enable')" = "false" ]; then
    log "[USENET] $NZB_INDEXER_NAME already disabled — no new action."
else
    IID=$(echo "$IDX" | jq -r '.id')
    CODE=$(printf '%s\n' "$IDX" | jq -c '.enable = false' | curl -4 -s -o /dev/null -w '%{http_code}' --connect-timeout 8 --max-time 25 --retry 3 --retry-delay 2 --retry-all-errors -X PUT -H "X-Api-Key: $PKEY" -H 'Content-Type: application/json' --data-binary @- "http://localhost:9696/api/v1/indexer/$IID")
    VERIFIED_OFF=$(curl -s --max-time 15 -H "X-Api-Key: $PKEY" "http://localhost:9696/api/v1/indexer" | jq -r --arg n "$NZB_INDEXER_NAME" '[.[] | select(.name==$n and .enable==false)] | length' 2>/dev/null)
    VERIFIED_AT=$(date -u '+%Y-%m-%dT%H:%M:%S.000Z')
    VERIFICATION_DIGEST=$(printf 'prowlarr.indexer.%s.enabled=%s' "$NZB_INDEXER_NAME" "$([ "${VERIFIED_OFF:-0}" -eq 1 ] && echo false || echo unknown)" | sha256sum | cut -d' ' -f1)
    if { [ "$CODE" = "202" ] || [ "$CODE" = "200" ]; } && [ "${VERIFIED_OFF:-0}" -eq 1 ]; then
        curl -s -o /dev/null --max-time 20 -X POST -H "X-Api-Key: $PKEY" -H 'Content-Type: application/json' -d '{"name":"ApplicationIndexerSync"}' "http://localhost:9696/api/v1/command"
        log "[USENET] Verified $NZB_INDEXER_NAME disabled and requested downstream sync."
        notify_unraid "Usenet provider unavailable" "The usenet indexer was verified disabled after the provider failed. Torrents are unaffected; the Butler will investigate." "alert"
        emit_transition "prowlarr.disable-indexer" "provider-unavailable" "indexer-disable:${TODAY}:verified" "prowlarr:disable:${TODAY}:provider-unavailable" "The usenet indexer was disabled after provider failure." "A separate Prowlarr read verified the named indexer enable=false after the protective action." "true" "$VERIFICATION_DIGEST" "$VERIFIED_AT"
    else
        log "[USENET] Indexer disable was not independently verified; only a verification-failure event was emitted."
        emit_transition "prowlarr.disable-indexer" "provider-unavailable" "indexer-disable:${TODAY}:unverified" "prowlarr:disable-request:${TODAY}:provider-unavailable" "The guard requested an indexer disable but could not verify it." "A separate Prowlarr read did not verify the named indexer enable=false; investigate before reporting protection." "false" "$VERIFICATION_DIGEST" "$VERIFIED_AT"
    fi
fi

tail -300 "$LOG" > "${LOG}.tmp" 2>/dev/null && mv "${LOG}.tmp" "$LOG"
