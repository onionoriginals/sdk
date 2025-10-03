#!/bin/bash
# Verification script for DID:WebVH migration implementation

echo "============================================================"
echo "DID:WebVH Migration Implementation Verification"
echo "============================================================"
echo ""

# Color codes
GREEN='\033[0;32m'
RED='\033[0;31m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# Check function
check_file() {
    if [ -f "$1" ]; then
        echo -e "${GREEN}✓${NC} $1"
        return 0
    else
        echo -e "${RED}✗${NC} $1 - MISSING"
        return 1
    fi
}

# Check directory
check_dir() {
    if [ -d "$1" ]; then
        echo -e "${GREEN}✓${NC} $1/"
        return 0
    else
        echo -e "${RED}✗${NC} $1/ - MISSING"
        return 1
    fi
}

echo "1. Checking Core Implementation Files..."
echo "----------------------------------------"
check_file "server/didwebvh-service.ts"
check_file "server/auth-middleware.ts"
check_file "server/backfill-did-webvh.ts"
check_file "server/cli-did-admin.ts"
check_file "shared/schema.ts"
check_file "server/storage.ts"
check_file "server/routes.ts"
echo ""

echo "2. Checking Test Files..."
echo "----------------------------------------"
check_dir "server/__tests__"
check_file "server/__tests__/didwebvh-service.test.ts"
check_file "server/__tests__/auth-middleware.test.ts"
check_file "server/__tests__/backfill-did-webvh.test.ts"
echo ""

echo "3. Checking Documentation..."
echo "----------------------------------------"
check_file "MIGRATION_RUNBOOK.md"
check_file "DID_WEBVH_INTEGRATION.md"
check_file "DID_MIGRATION_SUMMARY.md"
check_file ".env.migration.example"
echo ""

echo "4. Checking Dependencies..."
echo "----------------------------------------"
if [ -f "package.json" ]; then
    if grep -q "didwebvh-ts" package.json 2>/dev/null || \
       grep -q "@originals/sdk" package.json 2>/dev/null; then
        echo -e "${GREEN}✓${NC} didwebvh-ts dependency (via @originals/sdk)"
    else
        echo -e "${YELLOW}⚠${NC} didwebvh-ts not found in package.json"
    fi
    
    if grep -q "@privy-io/server-auth" package.json 2>/dev/null; then
        echo -e "${GREEN}✓${NC} @privy-io/server-auth dependency"
    else
        echo -e "${RED}✗${NC} @privy-io/server-auth - MISSING"
    fi
else
    echo -e "${RED}✗${NC} package.json - MISSING"
fi
echo ""

echo "5. Checking Key Functions..."
echo "----------------------------------------"

# Check for key function signatures
if grep -q "createUserDIDWebVH" server/didwebvh-service.ts 2>/dev/null; then
    echo -e "${GREEN}✓${NC} createUserDIDWebVH function"
else
    echo -e "${RED}✗${NC} createUserDIDWebVH function - NOT FOUND"
fi

if grep -q "verifyDIDWebVH" server/didwebvh-service.ts 2>/dev/null; then
    echo -e "${GREEN}✓${NC} verifyDIDWebVH function"
else
    echo -e "${RED}✗${NC} verifyDIDWebVH function - NOT FOUND"
fi

if grep -q "resolveDIDWebVH" server/didwebvh-service.ts 2>/dev/null; then
    echo -e "${GREEN}✓${NC} resolveDIDWebVH function"
else
    echo -e "${RED}✗${NC} resolveDIDWebVH function - NOT FOUND"
fi

if grep -q "createAuthMiddleware" server/auth-middleware.ts 2>/dev/null; then
    echo -e "${GREEN}✓${NC} createAuthMiddleware function"
else
    echo -e "${RED}✗${NC} createAuthMiddleware function - NOT FOUND"
fi

if grep -q "backfillDIDWebVH" server/backfill-did-webvh.ts 2>/dev/null; then
    echo -e "${GREEN}✓${NC} backfillDIDWebVH function"
else
    echo -e "${RED}✗${NC} backfillDIDWebVH function - NOT FOUND"
fi
echo ""

echo "6. Checking Feature Flags..."
echo "----------------------------------------"
if grep -q "AUTH_DID_WEBVH_ENABLED" server/didwebvh-service.ts 2>/dev/null; then
    echo -e "${GREEN}✓${NC} AUTH_DID_WEBVH_ENABLED flag"
else
    echo -e "${RED}✗${NC} AUTH_DID_WEBVH_ENABLED flag - NOT FOUND"
fi

if grep -q "AUTH_DID_DUAL_READ_ENABLED" server/didwebvh-service.ts 2>/dev/null; then
    echo -e "${GREEN}✓${NC} AUTH_DID_DUAL_READ_ENABLED flag"
else
    echo -e "${RED}✗${NC} AUTH_DID_DUAL_READ_ENABLED flag - NOT FOUND"
fi

if grep -q "AUTH_DID_DUAL_WRITE_ENABLED" server/didwebvh-service.ts 2>/dev/null; then
    echo -e "${GREEN}✓${NC} AUTH_DID_DUAL_WRITE_ENABLED flag"
else
    echo -e "${RED}✗${NC} AUTH_DID_DUAL_WRITE_ENABLED flag - NOT FOUND"
fi
echo ""

echo "7. Checking Schema Changes..."
echo "----------------------------------------"
if grep -q "did_webvh" shared/schema.ts 2>/dev/null; then
    echo -e "${GREEN}✓${NC} did_webvh field in schema"
else
    echo -e "${RED}✗${NC} did_webvh field - NOT FOUND"
fi

if grep -q "did_privy" shared/schema.ts 2>/dev/null; then
    echo -e "${GREEN}✓${NC} did_privy field in schema"
else
    echo -e "${RED}✗${NC} did_privy field - NOT FOUND"
fi

if grep -q "didWebvhDocument" shared/schema.ts 2>/dev/null; then
    echo -e "${GREEN}✓${NC} didWebvhDocument field in schema"
else
    echo -e "${RED}✗${NC} didWebvhDocument field - NOT FOUND"
fi
echo ""

echo "8. Checking Test Coverage..."
echo "----------------------------------------"
# Count test cases
webvh_tests=$(grep -c "test(" server/__tests__/didwebvh-service.test.ts 2>/dev/null || echo "0")
auth_tests=$(grep -c "test(" server/__tests__/auth-middleware.test.ts 2>/dev/null || echo "0")
backfill_tests=$(grep -c "test(" server/__tests__/backfill-did-webvh.test.ts 2>/dev/null || echo "0")

total_tests=$((webvh_tests + auth_tests + backfill_tests))

echo "DID:WebVH Service tests: $webvh_tests"
echo "Auth Middleware tests: $auth_tests"
echo "Backfill Job tests: $backfill_tests"
echo "Total test cases: $total_tests"

if [ $total_tests -ge 30 ]; then
    echo -e "${GREEN}✓${NC} Comprehensive test coverage (${total_tests} tests)"
else
    echo -e "${YELLOW}⚠${NC} Test coverage could be improved (${total_tests} tests)"
fi
echo ""

echo "9. Checking CLI Tools..."
echo "----------------------------------------"
if [ -x "server/backfill-did-webvh.ts" ] || grep -q "#!/usr/bin/env node" server/backfill-did-webvh.ts 2>/dev/null; then
    echo -e "${GREEN}✓${NC} Backfill script executable/shebang"
else
    echo -e "${YELLOW}⚠${NC} Backfill script - may need chmod +x"
fi

if [ -x "server/cli-did-admin.ts" ] || grep -q "#!/usr/bin/env node" server/cli-did-admin.ts 2>/dev/null; then
    echo -e "${GREEN}✓${NC} Admin CLI executable/shebang"
else
    echo -e "${YELLOW}⚠${NC} Admin CLI - may need chmod +x"
fi
echo ""

echo "10. Documentation Completeness..."
echo "----------------------------------------"
if [ -f "MIGRATION_RUNBOOK.md" ]; then
    lines=$(wc -l < MIGRATION_RUNBOOK.md)
    if [ $lines -gt 500 ]; then
        echo -e "${GREEN}✓${NC} Migration Runbook ($lines lines)"
    else
        echo -e "${YELLOW}⚠${NC} Migration Runbook seems short ($lines lines)"
    fi
fi

if [ -f "DID_WEBVH_INTEGRATION.md" ]; then
    lines=$(wc -l < DID_WEBVH_INTEGRATION.md)
    if [ $lines -gt 500 ]; then
        echo -e "${GREEN}✓${NC} Technical Documentation ($lines lines)"
    else
        echo -e "${YELLOW}⚠${NC} Technical Documentation seems short ($lines lines)"
    fi
fi
echo ""

echo "============================================================"
echo "Verification Complete"
echo "============================================================"
echo ""
echo "Next Steps:"
echo "1. Review code and documentation"
echo "2. Run tests: bun test server/__tests__/*.test.ts"
echo "3. Check status: bun run server/cli-did-admin.ts status"
echo "4. Follow MIGRATION_RUNBOOK.md for deployment"
echo ""
echo "For detailed information:"
echo "- Migration Guide: MIGRATION_RUNBOOK.md"
echo "- Technical Docs: DID_WEBVH_INTEGRATION.md"
echo "- Summary: DID_MIGRATION_SUMMARY.md"
echo ""
