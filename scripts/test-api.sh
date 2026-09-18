#!/usr/bin/env bash
# End-to-end check of a running stack (API on $API, at least one worker). Every step asserts the
# status code and body it expects and the script exits non-zero on the first failure.
set -euo pipefail

API="${API:-http://localhost:8080/api/v1}"
CURL=(curl -sS --max-time 30)

# The worker seeds transactions over the last 90 days and user activity over the last 30, relative
# to the day it starts, so the date windows are derived from today.
days_ago() { date -u -d "-$1 days" +%F 2>/dev/null || date -u -v-"$1"d +%F; }
TODAY=$(date -u +%F)
SALES_FROM=$(days_ago 60)
KEY="smoke-$(date -u +%s)-$$"
CID="smoke-$(date -u +%H%M%S)"

pass() { echo "  ok   $1"; }
fail() { echo "  FAIL $1" >&2; exit 1; }
json() { python3 -c "import sys,json; d=json.load(sys.stdin); print($1)"; }

# request METHOD PATH [BODY] -> sets STATUS, BODY, HEADERS
request() {
  local method=$1 path=$2 data=${3:-}
  local out
  if [[ -n "$data" ]]; then
    out=$("${CURL[@]}" -D - -o /dev/stderr -X "$method" -H "Content-Type: application/json" -H "X-Correlation-ID: $CID" \
          -d "$data" "$API$path" 2>/tmp/smoke-body.$$)
  else
    out=$("${CURL[@]}" -D - -o /dev/stderr -X "$method" -H "X-Correlation-ID: $CID" "$API$path" 2>/tmp/smoke-body.$$)
  fi
  HEADERS=$out
  BODY=$(cat /tmp/smoke-body.$$)
  STATUS=$(printf '%s' "$out" | head -1 | awk '{print $2}')
}
trap 'rm -f /tmp/smoke-body.$$' EXIT

echo "TaskForge smoke test against $API (correlation id $CID)"

echo "1. Health"
request GET /health
[[ "$STATUS" == 200 ]] || fail "health returned $STATUS"
[[ "$(printf '%s' "$BODY" | json "d['status']")" == UP ]] || fail "health status is not UP: $BODY"
pass "status UP, queue depth $(printf '%s' "$BODY" | json "d['queueDepth']"), dead-letter depth $(printf '%s' "$BODY" | json "d['deadLetterDepth']")"

echo "2. Submit a sales summary ($SALES_FROM..$TODAY, region North, key $KEY)"
request POST /reports "{\"type\":\"SALES_SUMMARY\",\"parameters\":{\"dateFrom\":\"$SALES_FROM\",\"dateTo\":\"$TODAY\",\"region\":\"North\"},\"idempotencyKey\":\"$KEY\"}"
[[ "$STATUS" == 202 ]] || fail "submit returned $STATUS: $BODY"
ID=$(printf '%s' "$BODY" | json "d['id']")
printf '%s' "$HEADERS" | grep -qi "^Location: /api/v1/reports/$ID" || fail "no Location header"
printf '%s' "$HEADERS" | grep -qi "^X-Correlation-ID: $CID" || fail "correlation id not echoed"
pass "202, job $ID, status $(printf '%s' "$BODY" | json "d['status']")"

echo "3. Same key again"
request POST /reports "{\"type\":\"SALES_SUMMARY\",\"parameters\":{},\"idempotencyKey\":\"$KEY\"}"
[[ "$STATUS" == 409 ]] || fail "duplicate returned $STATUS: $BODY"
[[ "$(printf '%s' "$BODY" | json "d['existingReportId']")" == "$ID" ]] || fail "409 does not name the existing job: $BODY"
pass "409 with existingReportId $ID"

echo "4. Invalid parameters"
request POST /reports '{"type":"USER_ACTIVITY","parameters":{"userId":"abc","dateFrom":"nope"}}'
[[ "$STATUS" == 400 ]] || fail "invalid parameters returned $STATUS"
[[ "$(printf '%s' "$BODY" | json "len(d['details'])")" == 2 ]] || fail "expected two problems: $BODY"
pass "400 with $(printf '%s' "$BODY" | json "len(d['details'])") problems listed"

echo "5. Malformed JSON"
request POST /reports '{"type":'
[[ "$STATUS" == 400 ]] || fail "malformed JSON returned $STATUS"
pass "400: $(printf '%s' "$BODY" | json "d['details'][0]")"

echo "6. Wait for the worker"
for i in $(seq 1 60); do
  request GET "/reports/$ID"
  S=$(printf '%s' "$BODY" | json "d['status']")
  [[ "$S" == COMPLETED ]] && break
  [[ "$S" == FAILED ]] && fail "job failed: $(printf '%s' "$BODY" | json "d['errorMessage']")"
  sleep 1
done
[[ "$S" == COMPLETED ]] || fail "job still $S after 60 s"
URL=$(printf '%s' "$BODY" | json "d['downloadUrl']")
pass "COMPLETED after $i s in $(printf '%s' "$BODY" | json "d['executionTimeMs']") ms, attempt $(printf '%s' "$BODY" | json "d['attemptCount']")"

echo "7. Download"
request GET "/reports/$ID/download"
[[ "$STATUS" == 302 ]] || fail "download returned $STATUS"
CSV_STATUS=$("${CURL[@]}" -o /tmp/smoke-report.$$.csv -w '%{http_code}' "$URL")
[[ "$CSV_STATUS" == 200 ]] || fail "presigned URL returned $CSV_STATUS"
head -1 /tmp/smoke-report.$$.csv | grep -q '^product,region,' || fail "unexpected CSV header: $(head -1 /tmp/smoke-report.$$.csv)"
pass "302 to S3; presigned URL served $(wc -c < /tmp/smoke-report.$$.csv) bytes of CSV"
rm -f /tmp/smoke-report.$$.csv

echo "8. List"
request GET "/reports?status=COMPLETED&limit=50"
[[ "$STATUS" == 200 ]] || fail "list returned $STATUS"
printf '%s' "$BODY" | json "[r['id'] for r in d]" | grep -q "$ID" || fail "completed job missing from the list"
pass "listed with downloadUrl: $(printf '%s' "$BODY" | json "[r['downloadUrl'] is not None for r in d if r['id']=='$ID'][0]")"

echo "All checks passed."
