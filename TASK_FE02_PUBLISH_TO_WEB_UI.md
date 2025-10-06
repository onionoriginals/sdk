# Task FE-02: Publish to Web UI

**Estimated Time**: 4-5 hours  
**Priority**: 🟠 Medium  
**Dependencies**: TASK_BE02 must be complete

---

## Objective

Add UI functionality to allow users to publish (migrate) their assets from `did:peer` (private) to `did:webvh` (public web layer).

---

## Context Files to Read

```bash
# Backend publish endpoint
apps/originals-explorer/server/routes.ts (search for /publish-to-web)

# Asset detail/view page (likely location for publish button)
apps/originals-explorer/client/src/pages/asset-detail.tsx
# Or find with: find . -name "*.tsx" | xargs grep -l "asset.*detail\|view.*asset"

# Dashboard (may need publish action there too)
apps/originals-explorer/client/src/pages/dashboard.tsx

# Layer components
apps/originals-explorer/client/src/components/LayerBadge.tsx
apps/originals-explorer/client/src/components/LayerFilter.tsx
```

---

## Requirements

### 1. Add Publish Button to Asset View

If an asset detail page exists, add a publish action. If not, add to dashboard asset cards.

**Visibility Rules**:
- Show ONLY for assets in `did:peer` layer
- Hide for assets already in `did:webvh` or `did:btco`
- Disable if user doesn't own the asset

```tsx
{asset.currentLayer === 'did:peer' && asset.userId === currentUser.id && (
  <Button 
    onClick={handlePublishToWeb}
    className="minimal-button"
    disabled={isPublishing}
  >
    {isPublishing ? (
      <>
        <Loader2 className="w-4 h-4 mr-2 animate-spin" />
        Publishing to Web...
      </>
    ) : (
      <>
        <Globe className="w-4 h-4 mr-2" />
        Publish to Web
      </>
    )}
  </Button>
)}
```

### 2. Confirmation Modal

Before publishing, show a confirmation modal explaining the action:

```tsx
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from "@/components/ui/dialog";

const [showPublishModal, setShowPublishModal] = useState(false);

<Dialog open={showPublishModal} onOpenChange={setShowPublishModal}>
  <DialogContent>
    <DialogHeader>
      <DialogTitle>Publish Asset to Web?</DialogTitle>
      <DialogDescription className="space-y-3 pt-4">
        <p>
          This will migrate your asset from <LayerBadge layer="did:peer" size="sm" /> 
          {' '}to <LayerBadge layer="did:webvh" size="sm" />
        </p>
        
        <div className="bg-blue-50 border border-blue-200 rounded-sm p-3">
          <h4 className="text-sm font-medium text-blue-900 mb-2">What happens:</h4>
          <ul className="text-sm text-blue-800 space-y-1 list-disc list-inside">
            <li>Asset becomes publicly accessible via HTTPS</li>
            <li>DID becomes resolvable on the web</li>
            <li>Provenance is updated with migration event</li>
            <li>Original did:peer is preserved for history</li>
          </ul>
        </div>
        
        <div className="bg-yellow-50 border border-yellow-200 rounded-sm p-3">
          <h4 className="text-sm font-medium text-yellow-900 mb-2">Note:</h4>
          <p className="text-sm text-yellow-800">
            Once published, your asset will be publicly visible. This action cannot be reversed.
          </p>
        </div>
      </DialogDescription>
    </DialogHeader>
    
    <DialogFooter>
      <Button 
        variant="outline" 
        onClick={() => setShowPublishModal(false)}
      >
        Cancel
      </Button>
      <Button 
        onClick={confirmPublish}
        disabled={isPublishing}
      >
        {isPublishing ? 'Publishing...' : 'Publish to Web'}
      </Button>
    </DialogFooter>
  </DialogContent>
</Dialog>
```

### 3. Publish Handler

```tsx
const [isPublishing, setIsPublishing] = useState(false);
const [publishError, setPublishError] = useState<string | null>(null);
const [publishResult, setPublishResult] = useState<any | null>(null);

const handlePublishToWeb = () => {
  setShowPublishModal(true);
};

const confirmPublish = async () => {
  setIsPublishing(true);
  setPublishError(null);
  
  try {
    const response = await fetch(`/api/assets/${asset.id}/publish-to-web`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({
        // Optional: domain: 'custom.domain.com'
      })
    });
    
    if (!response.ok) {
      const error = await response.json();
      throw new Error(error.error || 'Failed to publish');
    }
    
    const result = await response.json();
    setPublishResult(result);
    setShowPublishModal(false);
    
    // Refresh asset data
    await refetchAsset();
    
    // Show success notification
    toast.success('Asset published to web successfully!');
    
  } catch (error) {
    console.error('Publish error:', error);
    setPublishError(error.message);
  } finally {
    setIsPublishing(false);
  }
};
```

### 4. Success State Display

After successful publish, show the new DID and resolution URL:

```tsx
{publishResult && (
  <div className="mt-4 p-4 bg-blue-50 border border-blue-200 rounded-sm">
    <div className="flex items-center gap-2 mb-3">
      <CheckCircle className="w-5 h-5 text-blue-600" />
      <h4 className="font-medium text-blue-900">Published to Web!</h4>
    </div>
    
    <div className="space-y-3">
      {/* New Layer */}
      <div>
        <div className="text-xs text-blue-700 mb-1">Current Layer</div>
        <LayerBadge layer="did:webvh" size="md" />
      </div>
      
      {/* New DID */}
      <div>
        <div className="text-xs text-blue-700 mb-1">Web DID</div>
        <div className="font-mono text-sm text-blue-900 bg-white p-2 rounded-sm border border-blue-200 break-all">
          {publishResult.asset.didWebvh}
        </div>
      </div>
      
      {/* Resolution URL */}
      {publishResult.resolverUrl && (
        <div>
          <div className="text-xs text-blue-700 mb-1">Resolver URL</div>
          <a 
            href={publishResult.resolverUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="text-sm text-blue-600 hover:text-blue-800 underline flex items-center gap-1"
          >
            {publishResult.resolverUrl}
            <ExternalLink className="w-3 h-3" />
          </a>
        </div>
      )}
      
      {/* Provenance Update */}
      <div>
        <div className="text-xs text-blue-700 mb-1">Provenance</div>
        <div className="text-xs text-blue-800 bg-white p-2 rounded-sm border border-blue-200">
          Migration event recorded: {new Date().toLocaleString()}
        </div>
      </div>
    </div>
  </div>
)}
```

### 5. Update Asset Display

After publish, the asset should show its new layer:

```tsx
// Asset header/info section
<div className="flex items-center justify-between mb-6">
  <h1 className="text-2xl font-light">{asset.title}</h1>
  <LayerBadge layer={asset.currentLayer} size="lg" />
</div>

{/* Show both DIDs if asset has been migrated */}
<div className="space-y-4">
  {asset.didPeer && (
    <div>
      <div className="text-xs text-gray-500 mb-1">Original DID (did:peer)</div>
      <div className="font-mono text-xs text-gray-700 bg-gray-50 p-2 rounded-sm break-all">
        {asset.didPeer}
      </div>
    </div>
  )}
  
  {asset.didWebvh && (
    <div>
      <div className="text-xs text-gray-500 mb-1">Web DID (did:webvh)</div>
      <div className="font-mono text-xs text-gray-900 bg-blue-50 p-2 rounded-sm break-all">
        {asset.didWebvh}
      </div>
    </div>
  )}
</div>
```

### 6. Dashboard Updates

Update dashboard to reflect published assets:

```tsx
// In dashboard asset list, show migration action
{asset.currentLayer === 'did:peer' && (
  <button
    onClick={() => handleQuickPublish(asset.id)}
    className="text-xs text-blue-600 hover:text-blue-800"
  >
    Publish →
  </button>
)}
```

### 7. Error Handling

```tsx
{publishError && (
  <div className="mt-4 p-4 bg-red-50 border border-red-200 rounded-sm">
    <div className="flex items-center gap-2 mb-2">
      <AlertCircle className="w-4 h-4 text-red-600" />
      <h4 className="font-medium text-red-900">Publish Failed</h4>
    </div>
    <p className="text-sm text-red-700">{publishError}</p>
    <Button
      size="sm"
      variant="outline"
      className="mt-3"
      onClick={() => setPublishError(null)}
    >
      Dismiss
    </Button>
  </div>
)}
```

---

## Validation Checklist

Before marking complete:

- [ ] Publish button visible only for did:peer assets
- [ ] Confirmation modal explains the action clearly
- [ ] Publishing state shows loading indicator
- [ ] Success state displays new did:webvh
- [ ] Resolver URL is clickable and works
- [ ] Layer badge updates to "Published"
- [ ] Both DIDs displayed (original + web)
- [ ] Error handling shows helpful messages
- [ ] Dashboard reflects published assets
- [ ] Can navigate to resolver URL successfully
- [ ] UI is responsive on mobile
- [ ] No TypeScript errors
- [ ] Accessibility: keyboard navigation works

---

## Testing

### Manual Test Flow:

1. **Create an asset** (should be in did:peer)
2. **View asset** → Verify "Publish to Web" button visible
3. **Click publish** → Confirmation modal appears
4. **Confirm** → Loading state shows
5. **Wait** → Success message appears
6. **Verify**:
   - Layer badge shows "Published" (did:webvh)
   - New DID displayed
   - Resolver URL is clickable
   - Provenance shows migration
7. **Click resolver URL** → Opens DID document JSON
8. **Return to dashboard** → Asset shows webvh badge
9. **Try to publish again** → Button should not appear (already published)

### Edge Cases:

- Try publishing someone else's asset → Should not show button
- Try with asset already in did:webvh → Button not visible
- Disconnect internet mid-publish → Error handling works
- Cancel confirmation modal → No API call made

---

## Success Criteria

✅ Task is complete when:
1. Publish button appears for did:peer assets only
2. Confirmation modal provides clear information
3. Publishing updates asset layer to did:webvh
4. Success state displays new DID and resolver URL
5. Error handling is comprehensive
6. Dashboard reflects published assets
7. UI is responsive and accessible
8. Manual testing passes all scenarios
9. DID resolution URL works when clicked
10. No console errors or TypeScript warnings

---

## Next Task

After completion, proceed to:
- **TASK_TEST02_PUBLISH_TESTS.md** - Add tests for publish flow
