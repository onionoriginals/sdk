# PRD: Google Drive Folder Import with DID:Peer Creation

**Status:** 🟡 High Priority  
**Timeline:** 1-2 days  
**Team:** 2 engineers (intermediate level)  
**Created:** October 15, 2025

---

## Introduction

Content creators need a fast way to onboard existing digital assets from Google Drive into the Originals ecosystem. This feature enables bulk import of images from Google Drive folders, automatically creating DID:Peer identifiers for each image while preserving their Google Drive references. This solves the migration pain point for users transitioning from traditional cloud storage to decentralized identity management.

---

## Goals

1. **Enable Bulk Onboarding:** Allow content creators to import 250+ images in under 5 minutes
2. **Seamless Google Integration:** Authenticate via OAuth and respect existing Google Drive permissions
3. **Decentralized Identity:** Generate unique DID:Peer for each imported image using the Originals SDK
4. **Reliable Background Processing:** Handle imports asynchronously with progress tracking and error resilience

---

## User Stories

**Story 1: Content Creator Bulk Import**
```
As a content creator,
I want to select a Google Drive folder containing my artwork,
So that I can quickly onboard my existing portfolio into Originals without manual uploads.
```

**Story 2: Subfolder Organization**
```
As a user with organized Google Drive folders,
I want the import to recursively find all images in subfolders,
So that I don't have to flatten my folder structure before importing.
```

**Story 3: Partial Import Success**
```
As a user importing a large collection,
I want imports to continue even if some files fail,
So that I don't lose progress from successfully imported files.
```

**Story 4: Permission-Aware Import**
```
As a user with shared Google Drive folders,
I want to only import files I have access to,
So that I don't encounter permission errors during import.
```

---

## Functional Requirements

### Google Drive Integration

**FR-1.1:** The system MUST authenticate users via Google OAuth 2.0 using the existing Privy integration
- Request scopes: `drive.readonly`, `drive.metadata.readonly`
- Handle token expiration gracefully during import

**FR-1.2:** The system MUST use Google Drive API v3 to list folder contents
- API endpoint: `drive.files.list`
- Include shared drives if user has access

**FR-1.3:** The system MUST recursively traverse subfolders when importing
- Use `parents` parameter to find nested files
- Maintain folder hierarchy metadata for display purposes

**FR-1.4:** The system MUST filter for image file types only
- Supported types: JPEG, PNG, GIF, WebP, SVG, HEIC, BMP, TIFF
- Use `mimeType` field to identify image files
- Filter: `mimeType contains 'image/'`

**FR-1.5:** The system MUST respect Google Drive file permissions
- Only import files where `capabilities.canDownload = true` OR `webViewLink` exists
- Skip files without read access and log them as warnings

**FR-1.6:** The system SHOULD provide folder picker UI using Google Picker API
- Allow users to select any folder they have access to
- Display folder name and file count before import

### DID:Peer Creation

**FR-2.1:** The system MUST create one DID:Peer per imported image file
- Use existing SDK method: `OriginalsSDK.createDIDPeer()`
- Generate unique peer DIDs (method 2 - numalgo=2)

**FR-2.2:** The system MUST store Google Drive file reference in DID document
- Include: `fileId`, `webViewLink`, `webContentLink` (if available)
- Store as service endpoint in DID document

**FR-2.3:** The system MUST include minimal file metadata in DID document
- Required: `name`, `mimeType`, `size`
- Optional: `thumbnailLink` from Google Drive
- Do NOT include: `modifiedTime`, `createdTime`, `owners`

**FR-2.4:** The system SHOULD generate deterministic key pairs for each DID:Peer
- Use file's Google Drive ID as seed for reproducibility
- Store private keys securely in originals-explorer database

**FR-2.5:** The system MUST link DIDs to the authenticated user's account
- Store in `assets` table with `userId` foreign key
- Mark as `source: 'google-drive-import'`

### User Interface

**FR-3.1:** The system MUST add "Import from Google Drive" button to main dashboard
- Location: Next to existing "Create Asset" actions
- Icon: Google Drive logo + import arrow
- Text: "Import from Google Drive"

**FR-3.2:** The system MUST display folder selection modal on button click
- Show Google Picker interface embedded in modal
- Display warning: "Only image files will be imported"
- Allow cancel at any time

**FR-3.3:** The system MUST show import confirmation dialog before starting
- Display: Folder name, estimated image count, processing time estimate
- Buttons: "Start Import" (primary), "Cancel" (secondary)

**FR-3.4:** The system MUST provide real-time progress tracking UI
- Show: `X of Y images processed`, percentage progress bar
- Display: Current file being processed (name)
- Update at least every 2 seconds

**FR-3.5:** The system MUST display import completion summary
- Success count: Number of DIDs created
- Error count: Number of failures with expandable error list
- Action buttons: "View Imported Assets", "Import Another Folder", "Close"

**FR-3.6:** The system SHOULD show imported assets in main asset list
- Add filter: "Source: Google Drive"
- Display Google Drive icon badge on imported assets
- Link to original Google Drive file (webViewLink)

### Background Processing

**FR-4.1:** The system MUST process imports asynchronously
- Use Web Workers or server-side queue (decide based on architecture)
- Do not block UI during import

**FR-4.2:** The system MUST process files in batches
- Batch size: 10 files per batch (configurable)
- Rate limit: Respect Google Drive API quota (10 requests/second/user)

**FR-4.3:** The system MUST continue processing if individual files fail
- Log errors to database with file details
- Do not abort entire import on single file failure

**FR-4.4:** The system SHOULD implement retry logic for transient failures
- Retry count: 3 attempts per file
- Backoff: Exponential (1s, 2s, 4s)
- Retry on: Network errors, 429 rate limit, 500 server errors

**FR-4.5:** The system MUST persist import state to allow resumption
- Store in database: `importId`, `status`, `processedFiles[]`, `failedFiles[]`
- Allow user to resume if browser closes mid-import

**FR-4.6:** The system SHOULD send notification when import completes
- In-app toast notification if user still on site
- Optional: Email notification for imports > 100 files

### Error Handling

**FR-5.1:** The system MUST handle OAuth token expiration
- Detect 401 errors from Google Drive API
- Prompt user to re-authenticate without losing progress
- Resume import after successful re-auth

**FR-5.2:** The system MUST handle quota exceeded errors
- Detect 429 errors from Google Drive API
- Pause import and display estimated wait time
- Auto-resume when quota resets

**FR-5.3:** The system MUST validate folder selection
- Reject empty folders with helpful message
- Reject folders with no image files: "No images found in this folder"

**FR-5.4:** The system SHOULD handle network failures gracefully
- Save progress to local storage every 10 files
- Display "Network error - retrying..." message
- Auto-retry with exponential backoff

---

## Non-Goals (Out of Scope)

❌ **Explicitly NOT included:**
- **File downloads:** No downloading file contents to Originals servers - only storing references
- **Metadata preservation:** No importing Google Drive timestamps, owner info, or descriptions
- **Sync/watch functionality:** One-time import only, no automatic syncing of future changes
- **Non-image files:** No support for documents, videos, or other file types in v1
- **Folder structure recreation:** No recreating folder hierarchy in Originals (flat asset list)
- **Collaborative imports:** No sharing import progress between multiple users
- **Google Photos integration:** Only Google Drive, not Google Photos API
- **Bulk editing:** No batch editing of imported DIDs (future feature)
- **Export functionality:** No exporting back to Google Drive (future feature)

---

## Success Metrics

**Primary:**
- ✅ Import 250 images in under 5 minutes (end-to-end)
- ✅ 95%+ success rate on valid image files
- ✅ All imported files have valid DID:Peer identifiers
- ✅ Zero data loss on partial failures

**Secondary:**
- Progress UI updates within 2 seconds of actual progress
- OAuth flow completes in < 30 seconds
- Error messages are actionable (tell user what to do)
- Users can view imported assets immediately after completion

---

## Technical Considerations

### Architecture Decision

**Client-Side Processing (Recommended):**
- Use Tanstack Query for API calls + state management
- Web Workers for DID generation to avoid blocking UI
- IndexedDB for progress persistence

**Libraries:**
- `@googleapis/drive` - Google Drive API v3 client
- `@react-oauth/google` - OAuth flow (integrate with Privy)
- Existing SDK: `OriginalsSDK.createDIDPeer()`

### Source Files to Modify

**New Files:**
- `apps/originals-explorer/client/pages/ImportFromGoogleDrive.tsx` - Main import page
- `apps/originals-explorer/client/components/GoogleDrivePicker.tsx` - Folder picker
- `apps/originals-explorer/client/components/ImportProgress.tsx` - Progress UI
- `apps/originals-explorer/server/services/googleDriveImporter.ts` - Import logic
- `apps/originals-explorer/server/routes/import.ts` - API endpoints

**Modified Files:**
- `apps/originals-explorer/client/pages/Dashboard.tsx` - Add import button
- `apps/originals-explorer/server/storage.ts` - Add import tracking tables
- `apps/originals-explorer/shared/schema.ts` - Add import/asset source types

### Database Schema

**New Table: `google_drive_imports`**
```sql
CREATE TABLE google_drive_imports (
  id UUID PRIMARY KEY,
  user_id UUID REFERENCES users(id),
  folder_id TEXT NOT NULL,
  folder_name TEXT NOT NULL,
  status TEXT NOT NULL, -- 'pending', 'processing', 'completed', 'failed'
  total_files INTEGER,
  processed_files INTEGER,
  failed_files INTEGER,
  error_details JSONB,
  created_at TIMESTAMP DEFAULT NOW(),
  completed_at TIMESTAMP
);
```

**Modified Table: `assets`**
```sql
ALTER TABLE assets ADD COLUMN source TEXT DEFAULT 'manual';
ALTER TABLE assets ADD COLUMN source_metadata JSONB;
-- source_metadata example: {"googleDriveId": "1abc", "webViewLink": "..."}
```

### API Endpoints

**POST** `/api/import/google-drive/initiate`
- Body: `{ folderId, folderName, estimatedFiles }`
- Response: `{ importId, status }`

**POST** `/api/import/google-drive/process`
- Body: `{ importId, googleDriveFiles[] }`
- Response: `{ processedCount, errors[] }`

**GET** `/api/import/google-drive/status/:importId`
- Response: `{ status, progress, errors[] }`

### Testing Strategy

**Unit Tests:**
- Google Drive API client mocking
- DID:Peer generation with Google Drive metadata
- Error handling for various API failures

**Integration Tests:**
- End-to-end import with test folder (10 images)
- OAuth flow integration with Privy
- Database persistence of import state

**Performance Tests:**
- 250 image import under 5 minutes
- Concurrent imports by different users
- Rate limit handling

### Risks & Mitigation

**Risk 1:** Google Drive API rate limits
- **Mitigation:** Implement exponential backoff, batch requests efficiently

**Risk 2:** Large folder causing browser memory issues
- **Mitigation:** Process in batches, use Web Workers for heavy computation

**Risk 3:** OAuth token expiration mid-import
- **Mitigation:** Detect early, save progress, prompt re-auth seamlessly

**Risk 4:** DID:Peer generation slow for large batches
- **Mitigation:** Parallelize where possible, show realistic progress estimates

---

## Implementation Phases

### Phase 1: Google Drive Integration (4 hours)
- Set up OAuth with Privy
- Implement folder picker UI
- Test API connection and file listing

### Phase 2: DID:Peer Creation (4 hours)
- Integrate SDK `createDIDPeer()` method
- Create DID documents with Google Drive references
- Store in database with proper schema

### Phase 3: Background Processing (4 hours)
- Implement batch processing logic
- Add progress tracking and state persistence
- Error handling and retry logic

### Phase 4: UI/UX (3 hours)
- Build import button and modals
- Progress tracking interface
- Completion summary and asset display

### Phase 5: Testing & Polish (3 hours)
- Test with 250+ image folder
- Fix edge cases and errors
- Performance optimization

**Total Estimated Time:** 18 hours (2 days with buffer)

---

## Acceptance Criteria

This feature is DONE when:

- ✅ User can click "Import from Google Drive" and authenticate via OAuth
- ✅ User can select a folder using Google Picker interface
- ✅ System recursively finds all image files in selected folder and subfolders
- ✅ System creates one DID:Peer per image with Google Drive reference
- ✅ Progress bar updates in real-time showing X/Y processed
- ✅ Import continues if individual files fail (resilient)
- ✅ Completion summary shows success/error counts with details
- ✅ Imported assets appear in main dashboard with "Google Drive" badge
- ✅ 250 images import in under 5 minutes (measured)
- ✅ All tests passing (unit + integration)
- ✅ Error messages are clear and actionable
- ✅ OAuth token expiration handled gracefully
- ✅ No memory leaks with large imports (tested with 500+ images)

---

## Open Questions

❓ **Q1:** Should we cache OAuth tokens for future imports, or require re-auth each time?  
- **Owner:** Implementation team  
- **Due:** Before Phase 1  
- **Decision:** Cache tokens in secure HTTP-only cookie (30 day expiry)

❓ **Q2:** Should imported assets be in a separate "Imported" view or mixed with manually created assets?  
- **Owner:** UX decision during Phase 4  
- **Decision:** Mixed with filter option for "Source: Google Drive"

❓ **Q3:** What happens if user deletes file from Google Drive after import?  
- **Owner:** Future consideration  
- **Decision:** DID persists, but link may break (add dead link detection in future)

---

## Future Enhancements (Not in v1)

- 🔮 **Sync functionality:** Auto-update when Google Drive changes
- 🔮 **Bulk editing:** Edit metadata for multiple imported DIDs at once
- 🔮 **Google Photos integration:** Import from Google Photos albums
- 🔮 **Video support:** Extend to video files
- 🔮 **Export to Drive:** Reverse flow - export Originals assets to Google Drive
- 🔮 **Folder hierarchy:** Recreate folder structure as collections/tags
- 🔮 **Sharing preservation:** Import Google Drive sharing settings as VC permissions

---

**END OF PRD**

---

## Next Steps

1. ✅ PRD approved
2. ⏳ Create task tracking list: `tasks/task-google-drive-import.md`
3. ⏳ Set up Google Cloud project and enable Drive API
4. ⏳ Begin Phase 1 implementation

**Ready to start implementation? Let me know if any changes needed!** 🚀

