#!/bin/bash
set -e

API="http://localhost:8080/api/v1"

# DataSeeder seeds sample data relative to "now" - transactions over the last 90 days and user
# activity over the last 30 - so every date window below is derived from today rather than
# hardcoded. Hardcoded dates drift out of the seeded range and quietly return empty reports.
days_ago() {
  date -u -d "-$1 days" +%F 2>/dev/null || date -u -v-"$1"d +%F
}

TODAY=$(date -u +%F)
SALES_FROM=$(days_ago 60)     # inside the 90-day transaction window
ACTIVITY_FROM=$(days_ago 21)  # inside the 30-day user-activity window

# Idempotency is asserted by submitting the same key twice in one run, so the key has to be
# unique per run or a re-run collides with the previous run's job and the first POST returns 409.
IDEMPOTENCY_KEY="test-key-$(date -u +%s)-$$"

echo "═══ TaskForge API Tests ═══"
echo "  Sales window:    $SALES_FROM .. $TODAY"
echo "  Activity window: $ACTIVITY_FROM .. $TODAY"
echo ""

echo "1. Health Check"
curl -s "$API/health" | python3 -m json.tool
echo ""

echo "2. Submit Sales Summary Report"
SALES=$(curl -s -X POST "$API/reports" \
  -H "Content-Type: application/json" \
  -d "{\"type\":\"SALES_SUMMARY\",\"parameters\":{\"dateFrom\":\"$SALES_FROM\",\"dateTo\":\"$TODAY\",\"region\":\"North\"}}")
echo "$SALES" | python3 -m json.tool
SALES_ID=$(echo "$SALES" | python3 -c "import sys,json; print(json.load(sys.stdin)['id'])")
echo ""

echo "3. Submit Inventory Snapshot"
INV=$(curl -s -X POST "$API/reports" \
  -H "Content-Type: application/json" \
  -d '{"type":"INVENTORY_SNAPSHOT","parameters":{"lowStockThreshold":"15"}}')
echo "$INV" | python3 -m json.tool
INV_ID=$(echo "$INV" | python3 -c "import sys,json; print(json.load(sys.stdin)['id'])")
echo ""

echo "4. Submit User Activity Report"
curl -s -X POST "$API/reports" \
  -H "Content-Type: application/json" \
  -d "{\"type\":\"USER_ACTIVITY\",\"parameters\":{\"dateFrom\":\"$ACTIVITY_FROM\",\"dateTo\":\"$TODAY\"}}" | python3 -m json.tool
echo ""

echo "5. Idempotency Test (same key twice, key=$IDEMPOTENCY_KEY)"
curl -s -X POST "$API/reports" \
  -H "Content-Type: application/json" \
  -d "{\"type\":\"SALES_SUMMARY\",\"parameters\":{},\"idempotencyKey\":\"$IDEMPOTENCY_KEY\"}" | python3 -m json.tool
echo "  Second request (expect 409):"
curl -s -w "\n  HTTP Status: %{http_code}\n" -X POST "$API/reports" \
  -H "Content-Type: application/json" \
  -d "{\"type\":\"SALES_SUMMARY\",\"parameters\":{},\"idempotencyKey\":\"$IDEMPOTENCY_KEY\"}"
echo ""

echo "6. Waiting 5s for worker to process..."
sleep 5
echo ""

echo "7. Check Sales Summary Status"
curl -s "$API/reports/$SALES_ID" | python3 -m json.tool
echo ""

echo "8. Check Inventory Status"
curl -s "$API/reports/$INV_ID" | python3 -m json.tool
echo ""

echo "9. List All Reports"
curl -s "$API/reports" | python3 -m json.tool
echo ""

echo "10. Download Sales Report"
echo "  URL: $API/reports/$SALES_ID/download"
curl -s -o /dev/null -w "  HTTP Status: %{http_code} (302 = redirect to S3)\n" "$API/reports/$SALES_ID/download"
echo ""

echo "═══ All tests complete ═══"
