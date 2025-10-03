# DID:WebVH Migration Runbook

## Overview

This runbook guides you through migrating user authentication from `did:privy` to `did:webvh` identifiers using the `didwebvh-ts` library. The migration is designed for zero-downtime deployment with comprehensive safety mechanisms.

## Table of Contents

1. [Prerequisites](#prerequisites)
2. [Migration Phases](#migration-phases)
3. [Pre-Migration Checklist](#pre-migration-checklist)
4. [Step-by-Step Migration](#step-by-step-migration)
5. [Monitoring & Validation](#monitoring--validation)
6. [Rollback Procedure](#rollback-procedure)
7. [Post-Migration Cleanup](#post-migration-cleanup)
8. [Troubleshooting](#troubleshooting)

## Prerequisites

### Required Access
- Access to production environment variables
- Database write permissions
- Ability to restart application servers
- Access to monitoring dashboards

### Environment Variables
```bash
# Required
PRIVY_APP_ID=your_app_id
PRIVY_APP_SECRET=your_app_secret
DID_DOMAIN=your.domain.com  # or localhost:5000 for development

# Migration flags (will be configured during migration)
AUTH_DID_WEBVH_ENABLED=false          # Initially false
AUTH_DID_DUAL_READ_ENABLED=true       # Keep true during migration
AUTH_DID_DUAL_WRITE_ENABLED=true      # Keep true during migration
```

### Verification
```bash
# Verify didwebvh-ts is installed
cd apps/originals-explorer
bun install
bun run server/cli-did-admin.ts --help

# Verify tests pass
bun test server/__tests__/didwebvh-service.test.ts
bun test server/__tests__/auth-middleware.test.ts
bun test server/__tests__/backfill-did-webvh.test.ts
```

## Migration Phases

### Phase 1: Dual-Write Mode ✍️
- **Duration**: 1-7 days
- **Goal**: Create `did:webvh` for all new and active users
- **Behavior**: 
  - New DIDs created as both `did:privy` and `did:webvh`
  - Tokens still use `did:privy` as `sub`
  - Auth accepts both DID types

### Phase 2: Backfill Mode 🔄
- **Duration**: Hours to days (depends on user count)
- **Goal**: Migrate all existing users to `did:webvh`
- **Behavior**:
  - Batch process all users without `did:webvh`
  - Idempotent and resumable
  - No user-facing impact

### Phase 3: Cutover Mode 🚀
- **Duration**: Instant
- **Goal**: Switch to `did:webvh` as primary identifier
- **Behavior**:
  - Tokens use `did:webvh` as `sub`
  - Optional `legacy_sub` with `did:privy`
  - Both DIDs still accepted (dual-read)

### Phase 4: Cleanup Mode 🧹
- **Duration**: After stability window (14-30 days)
- **Goal**: Remove legacy `did:privy` support
- **Behavior**:
  - Only `did:webvh` accepted
  - Legacy fields deprecated

## Pre-Migration Checklist

### 1. Staging Environment Testing
```bash
# Run full test suite
cd apps/originals-explorer
bun test

# Test CLI tools
bun run server/cli-did-admin.ts status
bun run server/backfill-did-webvh.ts --dry-run

# Verify monitoring
# - Check metrics collection
# - Verify audit logs
# - Test alerting
```

### 2. Database Backup
```bash
# Create backup of production database
# (Commands vary by database system)
pg_dump originals_db > backup_pre_migration_$(date +%Y%m%d).sql
```

### 3. Monitoring Setup
- [ ] Configure alerts for:
  - `auth.verify.error` rate > 1%
  - `didwebvh.create.error` rate > 0.1%
  - `didwebvh.resolve.latency` p95 > 300ms
- [ ] Set up dashboard for migration progress
- [ ] Enable audit log collection

### 4. Communication Plan
- [ ] Notify downstream services of migration timeline
- [ ] Prepare rollback communication
- [ ] Document expected behavior changes

## Step-by-Step Migration

### Step 1: Enable Dual-Write Mode (Day 0)

**Objective**: Start creating `did:webvh` for new users

```bash
# 1. Set environment variables
export AUTH_DID_DUAL_WRITE_ENABLED=true
export AUTH_DID_DUAL_READ_ENABLED=true
export AUTH_DID_WEBVH_ENABLED=false  # Still using privy as primary

# 2. Deploy updated application
# (Your deployment process)

# 3. Verify dual-write is working
bun run server/cli-did-admin.ts status
# Expected: Both DIDs being created for new users

# 4. Monitor for 24-48 hours
# - Check error rates
# - Verify DID creation success rate
# - Monitor performance impact
```

**Success Criteria**:
- Error rate < 0.1%
- New users have both `did:webvh` and `did:privy`
- No performance degradation

### Step 2: Run Backfill (Day 2-3)

**Objective**: Create `did:webvh` for all existing users

```bash
# 1. Dry run to estimate impact
bun run server/backfill-did-webvh.ts --dry-run

# Review output:
# - Total users to migrate
# - Estimated duration
# - Potential issues

# 2. Run backfill in production
bun run server/backfill-did-webvh.ts --execute --batch-size 50 --delay 1000

# Monitor:
# - Progress logs
# - Success/failure ratio
# - System resource usage

# 3. Verify completion
bun run server/cli-did-admin.ts status
# Expected: 100% of users have did:webvh
```

**Success Criteria**:
- All users have `did:webvh`
- Error rate during backfill < 1%
- No service disruption

### Step 3: Enable DID:WebVH (Day 4-7)

**Objective**: Switch to `did:webvh` as primary identifier

```bash
# 1. Final verification
bun run server/cli-did-admin.ts status
# Ensure 100% migration complete

# 2. Enable DID:WebVH
bun run server/cli-did-admin.ts cutover --enable

# 3. Update environment and deploy
export AUTH_DID_WEBVH_ENABLED=true
export AUTH_DID_DUAL_READ_ENABLED=true   # Keep for safety
export AUTH_DID_DUAL_WRITE_ENABLED=true  # Keep for safety

# Restart application
# (Your deployment process)

# 4. Verify tokens using did:webvh
# Test login and check token payload:
# - `sub` should be `did:webvh:...`
# - Optional: `legacy_sub` with `did:privy:...`

# 5. Monitor for 7-14 days
# - Auth success rate
# - DID verification latency
# - Error patterns
```

**Success Criteria**:
- Tokens issued with `did:webvh` as `sub`
- Auth success rate ≥ 99.9%
- p95 latency < 300ms

### Step 4: Deprecate Legacy Support (Day 21+)

**Objective**: Remove `did:privy` acceptance (optional)

```bash
# 1. Verify stability (14+ days of production use)
# - No significant issues
# - All downstream services updated
# - Token validation working correctly

# 2. Disable dual-read (optional)
export AUTH_DID_DUAL_READ_ENABLED=false

# 3. Deploy and monitor
# WARNING: After this step, only did:webvh will be accepted

# 4. After another stability period, clean up schema
# - Remove did_privy column (optional)
# - Archive old data
```

## Monitoring & Validation

### Key Metrics to Monitor

```bash
# DID Creation
didwebvh.create.success         # Should be close to 100%
didwebvh.create.error           # Should be < 0.1%

# DID Resolution
didwebvh.resolve.latency        # p95 < 300ms
didwebvh.resolve.cache_miss     # Track cache hit rate
didwebvh.resolve.error          # Should be minimal

# Authentication
auth.verify.success             # Should be ≥ 99.9%
auth.verify.error               # Should be < 0.1%
auth.verify.latency             # p95 < 50ms (cached), < 300ms (uncached)

# Token Issuance
tokens.issued_by_scheme{webvh}  # Should increase over time
tokens.issued_by_scheme{privy}  # Should decrease to 0
```

### Validation Commands

```bash
# Check migration status
bun run server/cli-did-admin.ts status

# Validate specific DID
bun run server/cli-did-admin.ts validate "did:webvh:example.com:u-abc123"

# Create DID for specific user
bun run server/cli-did-admin.ts create "user-id"

# Re-run backfill (safe to run multiple times)
bun run server/backfill-did-webvh.ts --execute
```

### Health Checks

```bash
# 1. DID Resolution Test
curl -H "Authorization: Bearer $TOKEN" \
  http://localhost:5000/api/user | jq .

# 2. Token Validation Test
# Login and decode JWT to verify `sub` field

# 3. Audit Log Review
grep "AUDIT" logs/application.log | tail -100
```

## Rollback Procedure

### Immediate Rollback (< 1 hour since cutover)

```bash
# 1. Disable DID:WebVH
export AUTH_DID_WEBVH_ENABLED=false
export AUTH_DID_DUAL_READ_ENABLED=true

# 2. Restart application
# Tokens will immediately use did:privy as sub

# 3. Verify rollback
bun run server/cli-did-admin.ts status
# Should show webvh disabled

# 4. Monitor for stability
# - Auth success rate
# - Error logs
```

### Data Rollback (if corruption detected)

```bash
# 1. Stop application

# 2. Restore from backup
psql originals_db < backup_pre_migration_YYYYMMDD.sql

# 3. Disable DID:WebVH
export AUTH_DID_WEBVH_ENABLED=false

# 4. Restart and verify
```

### Partial Rollback (keep did:webvh but revert to privy)

```bash
# Keep did:webvh data but use privy for auth
export AUTH_DID_WEBVH_ENABLED=false
export AUTH_DID_DUAL_READ_ENABLED=true
export AUTH_DID_DUAL_WRITE_ENABLED=true

# This allows you to keep the migration progress
# and retry cutover later
```

## Post-Migration Cleanup

### After 30 Days of Stability

```bash
# 1. Disable dual-write (no longer creating did:privy)
export AUTH_DID_DUAL_WRITE_ENABLED=false

# 2. Disable dual-read (only accept did:webvh)
export AUTH_DID_DUAL_READ_ENABLED=false

# 3. Archive legacy data
# - Export did:privy mapping for historical reference
# - Optionally remove did_privy column from database

# 4. Update documentation
# - Remove references to did:privy
# - Update API documentation
# - Notify downstream services
```

## Troubleshooting

### Issue: High Error Rate During Backfill

**Symptoms**: > 1% of users failing DID creation

**Diagnosis**:
```bash
# Check error logs
grep "didwebvh.create.error" logs/application.log

# Review backfill stats
bun run server/backfill-did-webvh.ts --dry-run
```

**Resolution**:
1. Identify specific error patterns
2. Fix underlying issue (Privy API, network, etc.)
3. Re-run backfill (idempotent)
4. May need to adjust batch size or delays

### Issue: DID Verification Failures

**Symptoms**: `auth.didwebvh_verification_failed` alerts

**Diagnosis**:
```bash
# Test specific DID
bun run server/cli-did-admin.ts validate "did:webvh:..."

# Check resolution latency
# Review cache hit/miss ratio
```

**Resolution**:
1. Verify DID format is correct
2. Check network connectivity to DID resolution endpoint
3. Increase cache TTL if resolution is slow
4. Fallback to dual-read mode if persistent

### Issue: Performance Degradation

**Symptoms**: High latency in auth endpoints

**Diagnosis**:
```bash
# Check resolution latency
grep "didwebvh.resolve.latency" logs/metrics.log

# Review cache effectiveness
grep "didwebvh.resolve.cache_miss" logs/metrics.log
```

**Resolution**:
1. Increase cache size and TTL
2. Implement distributed cache (Redis)
3. Pre-warm cache for active users
4. Consider CDN for DID document serving

### Issue: Token Incompatibility

**Symptoms**: Downstream services rejecting tokens

**Diagnosis**:
```bash
# Decode and inspect token
echo $TOKEN | jwt decode -

# Check sub field format
```

**Resolution**:
1. Ensure downstream services support new DID format
2. Use `legacy_sub` claim during transition
3. Update service documentation
4. Coordinate deployment with downstream teams

### Issue: Duplicate DIDs

**Symptoms**: Same user with multiple `did:webvh`

**Diagnosis**:
```bash
# Check for duplicates in database
# (Query depends on DB)
```

**Resolution**:
1. Should not happen due to unique constraints
2. If detected, use CLI to identify and merge
3. Audit backfill logs for race conditions

## Support

For issues or questions:
- Check audit logs: `grep "AUDIT" logs/application.log`
- Review metrics dashboard
- Contact: your-team@example.com
- On-call: pagerduty/originals-platform

## Appendix

### A. Environment Variable Reference

| Variable | Default | Description |
|----------|---------|-------------|
| `AUTH_DID_WEBVH_ENABLED` | `false` | Enable did:webvh as primary identifier |
| `AUTH_DID_DUAL_READ_ENABLED` | `true` | Accept both did:webvh and did:privy |
| `AUTH_DID_DUAL_WRITE_ENABLED` | `true` | Create both did:webvh and did:privy |
| `DID_DOMAIN` | `localhost:5000` | Domain for did:webvh resolution |

### B. CLI Command Reference

```bash
# Status
bun run server/cli-did-admin.ts status

# Create DID
bun run server/cli-did-admin.ts create <user-id>

# Validate DID
bun run server/cli-did-admin.ts validate <did>

# Cutover
bun run server/cli-did-admin.ts cutover --enable|--disable

# Backfill
bun run server/backfill-did-webvh.ts --execute
```

### C. Useful Queries

```sql
-- Count users by DID type
SELECT 
  COUNT(*) as total_users,
  COUNT(did_webvh) as with_webvh,
  COUNT(did_privy) as with_privy,
  COUNT(*) FILTER (WHERE did_webvh IS NOT NULL AND did_privy IS NOT NULL) as with_both
FROM users;

-- Find users without did:webvh
SELECT id, username, did_privy
FROM users
WHERE did_webvh IS NULL
LIMIT 10;

-- Verify DID uniqueness
SELECT did_webvh, COUNT(*)
FROM users
WHERE did_webvh IS NOT NULL
GROUP BY did_webvh
HAVING COUNT(*) > 1;
```
