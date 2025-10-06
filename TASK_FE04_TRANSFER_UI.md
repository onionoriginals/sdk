# Task FE-04: Transfer Ownership UI

**Estimated Time**: 4-5 hours  
**Priority**: 🟡 Medium  
**Dependencies**: TASK_BE04 must be complete

---

## Objective

Add UI functionality for users to transfer asset ownership to other users, including recipient selection, confirmation, and transfer history display.

---

## Context Files to Read

```bash
# Backend transfer endpoint
apps/originals-explorer/server/routes.ts (search for /transfer)

# Asset detail page
apps/originals-explorer/client/src/pages/asset-detail.tsx

# User search/selection component (if exists)
apps/originals-explorer/client/src/components/user-search.tsx
```

---

## Requirements

### 1. Add Transfer Button

Only visible for assets owned by current user:

```tsx
{asset.userId === currentUser.id && (
  <Button 
    onClick={handleTransferClick}
    variant="outline"
    className="border-gray-200"
  >
    <Send className="w-4 h-4 mr-2" />
    Transfer Ownership
  </Button>
)}
```

### 2. Transfer Modal with Recipient Selection

```tsx
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";

const [showTransferModal, setShowTransferModal] = useState(false);
const [recipientDid, setRecipientDid] = useState('');
const [recipientUsername, setRecipientUsername] = useState('');
const [transferNotes, setTransferNotes] = useState('');
const [isSearchingUser, setIsSearchingUser] = useState(false);
const [foundUser, setFoundUser] = useState<any>(null);

<Dialog open={showTransferModal} onOpenChange={setShowTransferModal}>
  <DialogContent className="max-w-md">
    <DialogHeader>
      <DialogTitle>Transfer Asset Ownership</DialogTitle>
      <DialogDescription>
        Transfer "{asset.title}" to another user
      </DialogDescription>
    </DialogHeader>
    
    <div className="space-y-4 pt-4">
      {/* Recipient Search */}
      <div>
        <label className="text-sm font-medium mb-2 block">
          Recipient Username or DID
        </label>
        <div className="flex gap-2">
          <Input
            value={recipientUsername}
            onChange={(e) => setRecipientUsername(e.target.value)}
            placeholder="Enter username or did:webvh:..."
            className="flex-1"
          />
          <Button 
            onClick={searchRecipient}
            disabled={isSearchingUser || !recipientUsername}
            size="sm"
          >
            {isSearchingUser ? <Loader2 className="w-4 h-4 animate-spin" /> : 'Find'}
          </Button>
        </div>
      </div>
      
      {/* Found User Display */}
      {foundUser && (
        <div className="bg-green-50 border border-green-200 rounded-sm p-3">
          <div className="flex items-center gap-2 mb-2">
            <CheckCircle className="w-4 h-4 text-green-600" />
            <span className="text-sm font-medium text-green-900">Recipient Found</span>
          </div>
          <div className="text-sm text-green-800">
            <div className="font-medium">{foundUser.username}</div>
            <div className="font-mono text-xs mt-1 break-all">{foundUser.did}</div>
          </div>
        </div>
      )}
      
      {/* Transfer Notes */}
      <div>
        <label className="text-sm font-medium mb-2 block">
          Notes (Optional)
        </label>
        <Textarea
          value={transferNotes}
          onChange={(e) => setTransferNotes(e.target.value)}
          placeholder="Add a message with this transfer..."
          rows={3}
        />
      </div>
      
      {/* Current Owner Info */}
      <div className="bg-gray-50 border border-gray-200 rounded-sm p-3">
        <div className="text-xs text-gray-600 mb-1">Current Owner</div>
        <div className="text-sm text-gray-900 font-medium">{currentUser.username}</div>
      </div>
      
      {/* Warning */}
      <div className="bg-yellow-50 border border-yellow-200 rounded-sm p-3">
        <div className="flex gap-2">
          <AlertTriangle className="w-4 h-4 text-yellow-600 flex-shrink-0 mt-0.5" />
          <div className="text-xs text-yellow-900">
            <p className="font-medium mb-1">Important:</p>
            <p>Once transferred, you will no longer be able to manage this asset. This action cannot be undone.</p>
          </div>
        </div>
      </div>
    </div>
    
    <DialogFooter className="mt-6">
      <Button 
        variant="outline" 
        onClick={() => setShowTransferModal(false)}
        disabled={isTransferring}
      >
        Cancel
      </Button>
      <Button 
        onClick={confirmTransfer}
        disabled={!foundUser || isTransferring}
      >
        {isTransferring ? 'Transferring...' : 'Transfer Asset'}
      </Button>
    </DialogFooter>
  </DialogContent>
</Dialog>
```

### 3. Recipient Search Handler

```tsx
const searchRecipient = async () => {
  setIsSearchingUser(true);
  setFoundUser(null);
  
  try {
    // Check if input is a DID or username
    const isDid = recipientUsername.startsWith('did:');
    
    const response = await fetch(
      isDid 
        ? `/api/users/by-did?did=${encodeURIComponent(recipientUsername)}`
        : `/api/users/by-username?username=${encodeURIComponent(recipientUsername)}`,
      { credentials: 'include' }
    );
    
    if (!response.ok) {
      throw new Error('User not found');
    }
    
    const user = await response.json();
    setFoundUser(user);
    setRecipientDid(user.did);
    
  } catch (error) {
    console.error('User search error:', error);
    toast.error('User not found. Please check the username or DID.');
  } finally {
    setIsSearchingUser(false);
  }
};
```

### 4. Transfer Handler

```tsx
const [isTransferring, setIsTransferring] = useState(false);
const [transferError, setTransferError] = useState<string | null>(null);
const [transferResult, setTransferResult] = useState<any>(null);

const confirmTransfer = async () => {
  if (!foundUser) {
    toast.error('Please select a recipient first');
    return;
  }
  
  setIsTransferring(true);
  setTransferError(null);
  
  try {
    const response = await fetch(`/api/assets/${asset.id}/transfer`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({
        recipientDid: recipientDid,
        recipientUserId: foundUser.id,
        notes: transferNotes || undefined
      })
    });
    
    if (!response.ok) {
      const error = await response.json();
      throw new Error(error.error || 'Transfer failed');
    }
    
    const result = await response.json();
    setTransferResult(result);
    setShowTransferModal(false);
    
    // Show success
    toast.success(`Asset transferred to ${foundUser.username}!`);
    
    // Redirect to dashboard (user no longer owns this asset)
    setTimeout(() => {
      navigate('/dashboard');
    }, 2000);
    
  } catch (error) {
    console.error('Transfer error:', error);
    setTransferError(error.message);
  } finally {
    setIsTransferring(false);
  }
};
```

### 5. Transfer Success Notification

```tsx
{transferResult && (
  <div className="fixed top-4 right-4 max-w-md bg-white border-2 border-green-500 rounded-sm shadow-lg p-4 z-50">
    <div className="flex items-center gap-2 mb-3">
      <CheckCircle className="w-5 h-5 text-green-600" />
      <h3 className="font-medium text-green-900">Transfer Successful!</h3>
    </div>
    
    <div className="text-sm text-gray-700 space-y-2">
      <p>
        "{asset.title}" has been transferred to{' '}
        <span className="font-medium">{foundUser.username}</span>
      </p>
      <p className="text-xs text-gray-500">
        Redirecting to dashboard...
      </p>
    </div>
  </div>
)}
```

### 6. Transfer History Display

Show transfer history on asset detail page:

```tsx
const [transferHistory, setTransferHistory] = useState<any[]>([]);

useEffect(() => {
  if (asset?.id) {
    loadTransferHistory();
  }
}, [asset?.id]);

const loadTransferHistory = async () => {
  try {
    const response = await fetch(`/api/assets/${asset.id}/transfer-history`, {
      credentials: 'include'
    });
    
    if (response.ok) {
      const data = await response.json();
      setTransferHistory(data.transfers || []);
    }
  } catch (error) {
    console.error('Failed to load transfer history:', error);
  }
};

// Display component
{transferHistory.length > 0 && (
  <div className="mt-8">
    <h3 className="text-sm font-medium text-gray-700 mb-3">Transfer History</h3>
    <div className="space-y-2">
      {transferHistory.map((transfer, index) => (
        <div 
          key={index}
          className="flex items-center gap-3 p-3 bg-gray-50 border border-gray-200 rounded-sm"
        >
          <Send className="w-4 h-4 text-gray-400" />
          <div className="flex-1 min-w-0">
            <div className="text-sm text-gray-900">
              <span className="font-medium">{transfer.fromUsername}</span>
              {' → '}
              <span className="font-medium">{transfer.toUsername}</span>
            </div>
            <div className="text-xs text-gray-500 mt-0.5">
              {new Date(transfer.timestamp).toLocaleString()}
            </div>
            {transfer.notes && (
              <div className="text-xs text-gray-600 mt-1 italic">
                "{transfer.notes}"
              </div>
            )}
          </div>
        </div>
      ))}
    </div>
  </div>
)}
```

### 7. Ownership Verification Badge

```tsx
const [ownershipVerified, setOwnershipVerified] = useState(false);

useEffect(() => {
  verifyOwnership();
}, [asset?.id]);

const verifyOwnership = async () => {
  try {
    const response = await fetch(`/api/assets/${asset.id}/verify-ownership`);
    if (response.ok) {
      const data = await response.json();
      setOwnershipVerified(true);
    }
  } catch (error) {
    console.error('Verification failed:', error);
  }
};

// Display
<div className="flex items-center gap-2 mb-4">
  <h2 className="text-xl font-light">{asset.title}</h2>
  {ownershipVerified && (
    <div className="inline-flex items-center gap-1 px-2 py-1 bg-green-50 border border-green-200 rounded-sm">
      <ShieldCheck className="w-3 h-3 text-green-600" />
      <span className="text-xs text-green-700">Verified Owner</span>
    </div>
  )}
</div>
```

### 8. Error Handling

```tsx
{transferError && (
  <div className="p-3 bg-red-50 border border-red-200 rounded-sm">
    <div className="flex items-center gap-2 mb-1">
      <AlertCircle className="w-4 h-4 text-red-600" />
      <span className="text-sm font-medium text-red-900">Transfer Failed</span>
    </div>
    <p className="text-sm text-red-700">{transferError}</p>
  </div>
)}
```

---

## Validation Checklist

- [ ] Transfer button visible only for owned assets
- [ ] Recipient search works (username and DID)
- [ ] Found user displays correctly
- [ ] Transfer notes can be added
- [ ] Warning about irreversibility shown
- [ ] Transfer updates ownership
- [ ] Success notification displays
- [ ] Redirects to dashboard after transfer
- [ ] Transfer history loads and displays
- [ ] Ownership verification badge works
- [ ] Error handling comprehensive
- [ ] Cannot transfer to self
- [ ] Responsive on mobile

---

## Testing

### Manual Test Flow:

1. **Login as User A**, create/own an asset
2. **View asset** → Transfer button visible
3. **Click transfer** → Modal opens
4. **Enter User B's username** → Click "Find"
5. **Verify** User B found and displayed
6. **Add notes** (optional)
7. **Click "Transfer Asset"** → Loading state
8. **Wait** → Success notification
9. **Verify** redirected to dashboard
10. **Login as User B** → Verify asset now in their assets
11. **View asset as User B** → Transfer button visible
12. **View transfer history** → Shows A → B transfer
13. **Login as User A** → Try to view asset → Should not see transfer button

---

## Success Criteria

✅ Task is complete when:
1. Transfer modal works correctly
2. Recipient search functional
3. Transfer updates ownership
4. Transfer history displays
5. Ownership verification works
6. Success/error states clear
7. Cannot transfer to self
8. Responsive design works
9. Manual testing passes
10. No TypeScript errors

---

## Next Task

After completion, proceed to:
- **TASK_TEST04_TRANSFER_TESTS.md** - Add tests for transfer flow
