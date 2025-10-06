#!/bin/bash

# Test script for the new /api/assets/create-with-did endpoint
# This script requires a running server with authentication

set -e

echo "=================================================="
echo "Testing /api/assets/create-with-did endpoint"
echo "=================================================="
echo ""

# Check if AUTH_TOKEN is set
if [ -z "$AUTH_TOKEN" ]; then
  echo "❌ ERROR: AUTH_TOKEN environment variable is required"
  echo "   Please set it to a valid Privy JWT token:"
  echo "   export AUTH_TOKEN='your-token-here'"
  exit 1
fi

API_URL="${API_URL:-http://localhost:5000}"

echo "📋 Test 1: Create asset with external URL"
echo "-------------------------------------------"

RESPONSE=$(curl -s -w "\nHTTP_CODE:%{http_code}" -X POST "$API_URL/api/assets/create-with-did" \
  -H "Authorization: Bearer $AUTH_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "title": "Test Digital Art",
    "description": "A beautiful test artwork",
    "category": "art",
    "tags": ["test", "digital", "art"],
    "mediaUrl": "https://via.placeholder.com/300x300.png",
    "metadata": {
      "artist": "Test Artist",
      "year": "2025"
    }
  }')

HTTP_CODE=$(echo "$RESPONSE" | grep "HTTP_CODE:" | cut -d: -f2)
BODY=$(echo "$RESPONSE" | sed '/HTTP_CODE:/d')

echo "Response Code: $HTTP_CODE"

if [ "$HTTP_CODE" = "201" ]; then
  echo "✅ Asset created successfully!"
  echo ""
  echo "Response:"
  echo "$BODY" | jq '.'
  
  # Extract and verify key fields
  DID_PEER=$(echo "$BODY" | jq -r '.asset.didPeer')
  CURRENT_LAYER=$(echo "$BODY" | jq -r '.asset.currentLayer')
  
  echo ""
  echo "Verification:"
  echo "  DID Peer: $DID_PEER"
  echo "  Current Layer: $CURRENT_LAYER"
  
  if [[ "$DID_PEER" == did:peer:* ]]; then
    echo "  ✅ DID format is valid"
  else
    echo "  ❌ DID format is invalid"
    exit 1
  fi
  
  if [ "$CURRENT_LAYER" = "did:peer" ]; then
    echo "  ✅ Current layer is correct"
  else
    echo "  ❌ Current layer is incorrect"
    exit 1
  fi
  
else
  echo "❌ Request failed!"
  echo "Response:"
  echo "$BODY" | jq '.'
  exit 1
fi

echo ""
echo "=================================================="
echo "📋 Test 2: Create asset with file upload"
echo "-------------------------------------------"
echo ""

# Create a test image file
TEST_IMAGE="/tmp/test-image.png"
echo "Creating test image..."
# Create a simple 1x1 PNG (smallest valid PNG)
printf '\x89PNG\r\n\x1a\n\x00\x00\x00\rIHDR\x00\x00\x00\x01\x00\x00\x00\x01\x08\x02\x00\x00\x00\x90wS\xde\x00\x00\x00\x0cIDATx\x9cc\x00\x01\x00\x00\x05\x00\x01\r\n-\xb4\x00\x00\x00\x00IEND\xaeB`\x82' > "$TEST_IMAGE"

RESPONSE2=$(curl -s -w "\nHTTP_CODE:%{http_code}" -X POST "$API_URL/api/assets/create-with-did" \
  -H "Authorization: Bearer $AUTH_TOKEN" \
  -F "title=Test Upload Image" \
  -F "description=Uploaded via multipart form" \
  -F "category=test" \
  -F "tags=[\"upload\", \"test\"]" \
  -F "mediaFile=@$TEST_IMAGE")

HTTP_CODE2=$(echo "$RESPONSE2" | grep "HTTP_CODE:" | cut -d: -f2)
BODY2=$(echo "$RESPONSE2" | sed '/HTTP_CODE:/d')

echo "Response Code: $HTTP_CODE2"

if [ "$HTTP_CODE2" = "201" ]; then
  echo "✅ Asset with file upload created successfully!"
  echo ""
  echo "Response:"
  echo "$BODY2" | jq '.'
  
  DID_PEER2=$(echo "$BODY2" | jq -r '.asset.didPeer')
  echo ""
  echo "  DID Peer: $DID_PEER2"
  
  if [[ "$DID_PEER2" == did:peer:* ]]; then
    echo "  ✅ DID format is valid"
  else
    echo "  ❌ DID format is invalid"
    exit 1
  fi
else
  echo "❌ Request failed!"
  echo "Response:"
  echo "$BODY2" | jq '.'
  exit 1
fi

# Cleanup
rm -f "$TEST_IMAGE"

echo ""
echo "=================================================="
echo "✅ All tests passed!"
echo "=================================================="
