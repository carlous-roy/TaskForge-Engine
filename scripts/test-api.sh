#!/bin/bash
set -e

API="http://localhost:8080/api/v1"

echo "═══ TaskForge API Tests ═══"
echo ""

echo "1. Health Check"
curl -s "$API/health" | python3 -m json.tool
echo ""

echo "2. Submit Sales Summary Report"
SALES=$(curl -s -X POST "$API/reports" \
  -H "Content-Type: application/json" \
  -d '{"type":"SALES_SUMMARY","parameters":{"dateFrom":"2025-12-01","dateTo":"2026-02-28","region":"North"}}')
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
  -d '{"type":"USER_ACTIVITY","parameters":{"dateFrom":"2026-02-01","dateTo":"2026-02-28"}}' | python3 -m json.tool
echo ""

echo "5. Idempotency Test (same key twice)"
curl -s -X POST "$API/reports" \
  -H "Content-Type: application/json" \
  -d '{"type":"SALES_SUMMARY","parameters":{},"idempotencyKey":"test-key-1"}' | python3 -m json.tool
echo "  Second request (expect 409):"
curl -s -w "\n  HTTP Status: %{http_code}\n" -X POST "$API/reports" \
  -H "Content-Type: application/json" \
  -d '{"type":"SALES_SUMMARY","parameters":{},"idempotencyKey":"test-key-1"}'
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
