# Task FE-01: Asset Creation UI Update

**Estimated Time**: 4-6 hours  
**Priority**: 🔴 Critical  
**Dependencies**: TASK_BE01_ASSET_CREATION.md must be complete

---

## Objective

Update the frontend asset creation UI to use the new SDK-integrated endpoint (`POST /api/assets/create-with-did`) instead of the old endpoint that doesn't generate DID identifiers.

---

## Context Files to Read

Read these files **first**:

```bash
# Current frontend form (needs updating)
apps/originals-explorer/client/src/pages/create-asset-simple.tsx

# Working SDK-integrated example (bulk upload)
apps/originals-explorer/client/src/pages/spreadsheet-upload.tsx

# Backend endpoint created in BE-01
apps/originals-explorer/server/routes.ts (search for /api/assets/create-with-did)

# Schema for type safety
apps/originals-explorer/shared/schema.ts

# Layer badge component (to display did:peer badge)
apps/originals-explorer/client/src/components/LayerBadge.tsx
```

---

## Current Problem

The current `create-asset-simple.tsx` page:
1. Uses `POST /api/assets` (old endpoint without SDK)
2. Doesn't display the generated DID
3. Doesn't show credentials or provenance
4. Doesn't indicate the asset is in "did:peer" layer

---

## Requirements

### 1. Update API Call

**Before**:
```typescript
const response = await fetch('/api/assets', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    title: formData.title,
    description: formData.description,
    // ...
  })
});
```

**After**:
```typescript
// If using FormData for file upload
const formData = new FormData();
formData.append('title', data.title);
formData.append('description', data.description);
formData.append('category', data.category);
formData.append('tags', JSON.stringify(data.tags));
if (file) {
  formData.append('mediaFile', file);
} else if (data.mediaUrl) {
  formData.append('mediaUrl', data.mediaUrl);
}
formData.append('metadata', JSON.stringify(data.metadata || {}));

const response = await fetch('/api/assets/create-with-did', {
  method: 'POST',
  credentials: 'include',
  body: formData
});

const result = await response.json();
// result contains: { asset, originalsAsset }
```

### 2. Update Form Schema

Add file upload support:

```typescript
import { useState } from 'react';

const [selectedFile, setSelectedFile] = useState<File | null>(null);
const [previewUrl, setPreviewUrl] = useState<string | null>(null);

// File input handler
const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
  const file = e.target.files?.[0];
  if (file) {
    setSelectedFile(file);
    // Create preview
    const reader = new FileReader();
    reader.onloadend = () => {
      setPreviewUrl(reader.result as string);
    };
    reader.readAsDataURL(file);
  }
};
```

### 3. Add File Upload UI

Add to the form:

```tsx
<div className="space-y-2">
  <label className="text-sm font-medium">Media File</label>
  <div className="flex flex-col gap-4">
    {/* File input */}
    <input
      type="file"
      accept="image/*"
      onChange={handleFileChange}
      className="block w-full text-sm text-gray-500
        file:mr-4 file:py-2 file:px-4
        file:rounded-sm file:border-0
        file:text-sm file:font-medium
        file:bg-gray-50 file:text-gray-700
        hover:file:bg-gray-100"
    />
    
    {/* Preview */}
    {previewUrl && (
      <div className="relative w-full h-48 border border-gray-200 rounded-sm overflow-hidden">
        <img 
          src={previewUrl} 
          alt="Preview" 
          className="w-full h-full object-contain"
        />
      </div>
    )}
    
    {/* OR URL input */}
    <div className="text-sm text-gray-500 text-center">OR</div>
    <input
      type="url"
      placeholder="Enter media URL"
      className="input"
      {...register('mediaUrl')}
    />
  </div>
</div>
```

### 4. Display Success State with DID Information

After successful creation, show:

```tsx
{successResult && (
  <div className="mt-6 p-6 bg-green-50 border border-green-200 rounded-sm">
    <div className="flex items-center gap-2 mb-4">
      <Check className="w-5 h-5 text-green-600" />
      <h3 className="font-medium text-green-900">Asset Created Successfully!</h3>
    </div>
    
    {/* Layer Badge */}
    <div className="mb-4">
      <LayerBadge layer="did:peer" size="md" />
    </div>
    
    {/* DID Information */}
    <div className="space-y-3">
      <div>
        <div className="text-xs text-green-700 mb-1">DID Identifier</div>
        <div className="font-mono text-sm text-green-900 break-all bg-white p-2 rounded-sm border border-green-200">
          {successResult.asset.didPeer}
        </div>
      </div>
      
      {/* Credentials */}
      {successResult.asset.credentials && (
        <div>
          <div className="text-xs text-green-700 mb-1">Verifiable Credentials</div>
          <div className="text-xs font-mono text-green-800 bg-white p-2 rounded-sm border border-green-200 max-h-32 overflow-y-auto">
            {JSON.stringify(successResult.asset.credentials, null, 2)}
          </div>
        </div>
      )}
      
      {/* Provenance */}
      {successResult.asset.provenance && (
        <div>
          <div className="text-xs text-green-700 mb-1">Provenance</div>
          <div className="text-xs text-green-800 bg-white p-2 rounded-sm border border-green-200">
            {successResult.asset.provenance.events?.length || 0} event(s) recorded
          </div>
        </div>
      )}
    </div>
    
    {/* Actions */}
    <div className="flex gap-3 mt-4">
      <Link href="/dashboard">
        <Button size="sm" variant="outline">View Dashboard</Button>
      </Link>
      <Link href={`/assets/${successResult.asset.id}`}>
        <Button size="sm">View Asset</Button>
      </Link>
      <Button 
        size="sm" 
        variant="outline"
        onClick={() => {
          setSuccessResult(null);
          reset();
        }}
      >
        Create Another
      </Button>
    </div>
  </div>
)}
```

### 5. Update Loading States

Add better loading feedback:

```tsx
const [isCreating, setIsCreating] = useState(false);

// During submission
{isCreating && (
  <div className="flex items-center gap-2 text-sm text-gray-600">
    <Loader2 className="w-4 h-4 animate-spin" />
    <span>Creating asset with DID identifier...</span>
  </div>
)}
```

### 6. Error Handling

Improve error messages:

```tsx
{error && (
  <div className="mt-4 p-4 bg-red-50 border border-red-200 rounded-sm">
    <div className="flex items-center gap-2 mb-2">
      <AlertCircle className="w-4 h-4 text-red-600" />
      <h4 className="font-medium text-red-900">Creation Failed</h4>
    </div>
    <p className="text-sm text-red-700">{error}</p>
    {errorDetails && (
      <details className="mt-2">
        <summary className="text-xs text-red-600 cursor-pointer">Technical details</summary>
        <pre className="mt-2 text-xs text-red-800 bg-white p-2 rounded-sm overflow-x-auto">
          {JSON.stringify(errorDetails, null, 2)}
        </pre>
      </details>
    )}
  </div>
)}
```

### 7. Form Validation

Add proper validation:

```typescript
const schema = z.object({
  title: z.string().min(1, "Title is required").max(100, "Title too long"),
  description: z.string().max(1000, "Description too long").optional(),
  category: z.string().optional(),
  tags: z.array(z.string()).optional(),
  mediaUrl: z.string().url("Invalid URL").optional(),
  metadata: z.record(z.any()).optional(),
});

// Either file OR URL must be provided
const validateSubmit = (data: any) => {
  if (!selectedFile && !data.mediaUrl) {
    setError("Please upload a file or provide a media URL");
    return false;
  }
  return true;
};
```

---

## Implementation Steps

1. **Update imports**: Add LayerBadge, file handling utilities
2. **Add state**: File selection, preview, success result
3. **Update form**: Add file input and URL input with OR logic
4. **Update submission**: Use FormData, call new endpoint
5. **Add success display**: Show DID, credentials, provenance
6. **Improve loading**: Better feedback during creation
7. **Test thoroughly**: Try file upload, URL input, error cases

---

## Validation Checklist

Before marking complete, verify:

- [ ] Can upload image files successfully
- [ ] Can provide external URL successfully
- [ ] File preview works correctly
- [ ] Form validates properly (requires file OR URL)
- [ ] Loading state shows during creation
- [ ] Success state displays DID identifier
- [ ] Layer badge shows "did:peer"
- [ ] Credentials are displayed (collapsible/expandable)
- [ ] Provenance info is shown
- [ ] Error handling works for all failure modes
- [ ] Can create another asset after success
- [ ] Can navigate to dashboard or asset detail
- [ ] No TypeScript errors
- [ ] Responsive design works on mobile

---

## Testing

### Manual Test Flow:

1. **Test File Upload**:
   - Go to `/create`
   - Select an image file
   - Fill in title, description
   - Submit form
   - Verify success state shows DID
   - Verify asset appears in dashboard with "did:peer" badge

2. **Test URL Input**:
   - Clear form
   - Enter a valid image URL (e.g., https://picsum.photos/400/300)
   - Fill in title
   - Submit form
   - Verify success

3. **Test Validation**:
   - Try submitting without file or URL → Should show error
   - Try invalid URL → Should show validation error
   - Try empty title → Should show validation error

4. **Test Error Handling**:
   - Try uploading a non-image file → Should show error
   - Try very large file (>10MB) → Should show error

---

## Success Criteria

✅ Task is complete when:
1. Form uses new SDK-integrated endpoint
2. File upload works correctly
3. URL input works as alternative
4. Success state shows DID, credentials, and provenance
5. Layer badge displays "did:peer"
6. Error handling is comprehensive
7. Loading states are clear
8. Responsive design works
9. Manual testing passes all scenarios
10. No console errors or TypeScript warnings

---

## Next Task

After completion, proceed to:
- **TASK_TEST01_ASSET_CREATION_TESTS.md** - Add comprehensive tests
