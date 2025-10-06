# Task FE-03: Inscribe on Bitcoin UI

**Estimated Time**: 5-6 hours  
**Priority**: 🟠 Medium  
**Dependencies**: TASK_BE03 must be complete

---

## Objective

Add UI functionality for users to inscribe their assets on Bitcoin, including fee estimation, cost display, transaction monitoring, and explorer links.

---

## Context Files to Read

```bash
# Backend inscribe endpoint
apps/originals-explorer/server/routes.ts (search for /inscribe-on-bitcoin)

# Fee estimation endpoint
apps/originals-explorer/server/routes.ts (search for /bitcoin/fee-estimate)

# Asset detail/view page
apps/originals-explorer/client/src/pages/asset-detail.tsx

# Layer components
apps/originals-explorer/client/src/components/LayerBadge.tsx
```

---

## Requirements

### 1. Add Inscribe Button

Only visible for assets in `did:webvh` layer:

```tsx
{asset.currentLayer === 'did:webvh' && asset.userId === currentUser.id && (
  <Button 
    onClick={handleInscribeClick}
    className="minimal-button"
    disabled={isInscribing}
  >
    {isInscribing ? (
      <>
        <Loader2 className="w-4 h-4 mr-2 animate-spin" />
        Inscribing on Bitcoin...
      </>
    ) : (
      <>
        <Bitcoin className="w-4 h-4 mr-2" />
        Inscribe on Bitcoin
      </>
    )}
  </Button>
)}
```

### 2. Fee Estimation Modal

Show fee options before inscribing:

```tsx
import { Dialog, DialogContent } from "@/components/ui/dialog";

const [showFeeModal, setShowFeeModal] = useState(false);
const [feeEstimates, setFeeEstimates] = useState<any>(null);
const [selectedFeeRate, setSelectedFeeRate] = useState<'slow' | 'medium' | 'fast'>('medium');
const [isLoadingFees, setIsLoadingFees] = useState(false);

const handleInscribeClick = async () => {
  setShowFeeModal(true);
  setIsLoadingFees(true);
  
  try {
    const response = await fetch(`/api/bitcoin/fee-estimate?assetId=${asset.id}`, {
      credentials: 'include'
    });
    
    if (!response.ok) throw new Error('Failed to load fees');
    
    const data = await response.json();
    setFeeEstimates(data.estimates);
  } catch (error) {
    console.error('Fee estimation error:', error);
    // Handle error
  } finally {
    setIsLoadingFees(false);
  }
};

<Dialog open={showFeeModal} onOpenChange={setShowFeeModal}>
  <DialogContent className="max-w-lg">
    <DialogHeader>
      <DialogTitle>Inscribe on Bitcoin</DialogTitle>
      <DialogDescription>
        This will permanently inscribe your asset on the Bitcoin blockchain.
      </DialogDescription>
    </DialogHeader>
    
    {isLoadingFees ? (
      <div className="py-8 text-center">
        <Loader2 className="w-6 h-6 mx-auto animate-spin mb-2" />
        <p className="text-sm text-gray-600">Estimating fees...</p>
      </div>
    ) : feeEstimates ? (
      <div className="space-y-4">
        {/* Network info */}
        <div className="bg-blue-50 border border-blue-200 rounded-sm p-3">
          <div className="flex items-center gap-2">
            <Info className="w-4 h-4 text-blue-600" />
            <div className="text-sm text-blue-900">
              <span className="font-medium">Network:</span> {feeEstimates.currentNetwork || 'testnet'}
            </div>
          </div>
        </div>
        
        {/* Fee options */}
        <div className="space-y-2">
          <label className="text-sm font-medium">Select Fee Rate:</label>
          
          {['slow', 'medium', 'fast'].map((speed) => {
            const estimate = feeEstimates[speed];
            if (!estimate) return null;
            
            return (
              <button
                key={speed}
                onClick={() => setSelectedFeeRate(speed)}
                className={`w-full p-4 border rounded-sm text-left transition-colors ${
                  selectedFeeRate === speed
                    ? 'border-blue-500 bg-blue-50'
                    : 'border-gray-200 hover:border-gray-300'
                }`}
              >
                <div className="flex items-center justify-between mb-2">
                  <div className="flex items-center gap-2">
                    {selectedFeeRate === speed && (
                      <CheckCircle className="w-4 h-4 text-blue-600" />
                    )}
                    <span className="font-medium capitalize">{speed}</span>
                  </div>
                  <span className="text-sm text-gray-600">
                    {estimate.estimatedTime}
                  </span>
                </div>
                
                <div className="flex items-baseline gap-2">
                  <span className="text-lg font-semibold">
                    {estimate.totalSats.toLocaleString()} sats
                  </span>
                  <span className="text-sm text-gray-600">
                    (≈ {estimate.totalBtc} BTC)
                  </span>
                </div>
                
                <div className="text-xs text-gray-500 mt-1">
                  {estimate.feeRate} sat/vB
                </div>
              </button>
            );
          })}
        </div>
        
        {/* Warning */}
        <div className="bg-yellow-50 border border-yellow-200 rounded-sm p-3">
          <div className="flex gap-2">
            <AlertTriangle className="w-4 h-4 text-yellow-600 flex-shrink-0 mt-0.5" />
            <div className="text-sm text-yellow-900">
              <p className="font-medium mb-1">Important:</p>
              <ul className="space-y-1 text-xs">
                <li>• This costs real Bitcoin (on mainnet)</li>
                <li>• Inscription is permanent and cannot be reversed</li>
                <li>• Transaction may take 10-60 minutes to confirm</li>
              </ul>
            </div>
          </div>
        </div>
      </div>
    ) : null}
    
    <DialogFooter>
      <Button 
        variant="outline" 
        onClick={() => setShowFeeModal(false)}
        disabled={isInscribing}
      >
        Cancel
      </Button>
      <Button 
        onClick={confirmInscribe}
        disabled={isInscribing || !feeEstimates}
      >
        {isInscribing ? 'Inscribing...' : 'Confirm Inscription'}
      </Button>
    </DialogFooter>
  </DialogContent>
</Dialog>
```

### 3. Inscription Handler

```tsx
const [isInscribing, setIsInscribing] = useState(false);
const [inscriptionResult, setInscriptionResult] = useState<any>(null);
const [inscriptionError, setInscriptionError] = useState<string | null>(null);

const confirmInscribe = async () => {
  setIsInscribing(true);
  setInscriptionError(null);
  
  try {
    const estimate = feeEstimates[selectedFeeRate];
    
    const response = await fetch(`/api/assets/${asset.id}/inscribe-on-bitcoin`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({
        feeRate: estimate.feeRate
      })
    });
    
    if (!response.ok) {
      const error = await response.json();
      throw new Error(error.error || 'Failed to inscribe');
    }
    
    const result = await response.json();
    setInscriptionResult(result);
    setShowFeeModal(false);
    
    // Refresh asset data
    await refetchAsset();
    
    // Show success notification
    toast.success('Asset inscribed on Bitcoin!');
    
  } catch (error) {
    console.error('Inscription error:', error);
    setInscriptionError(error.message);
  } finally {
    setIsInscribing(false);
  }
};
```

### 4. Success Display with Transaction Info

```tsx
{inscriptionResult && (
  <div className="mt-6 p-6 bg-orange-50 border border-orange-200 rounded-sm">
    <div className="flex items-center gap-2 mb-4">
      <CheckCircle className="w-5 h-5 text-orange-600" />
      <h3 className="font-medium text-orange-900">Inscribed on Bitcoin!</h3>
    </div>
    
    <div className="space-y-4">
      {/* Layer Badge */}
      <div>
        <div className="text-xs text-orange-700 mb-1">Current Layer</div>
        <LayerBadge layer="did:btco" size="md" />
      </div>
      
      {/* Bitcoin DID */}
      <div>
        <div className="text-xs text-orange-700 mb-1">Bitcoin DID</div>
        <div className="font-mono text-sm text-orange-900 bg-white p-2 rounded-sm border border-orange-200 break-all">
          {inscriptionResult.asset.didBtco}
        </div>
      </div>
      
      {/* Transaction ID */}
      <div>
        <div className="text-xs text-orange-700 mb-1">Transaction ID</div>
        <div className="font-mono text-xs text-orange-900 bg-white p-2 rounded-sm border border-orange-200 break-all">
          {inscriptionResult.originalsAsset.inscriptionDetails.txid}
        </div>
      </div>
      
      {/* Explorer Link */}
      <div>
        <a 
          href={inscriptionResult.originalsAsset.inscriptionDetails.explorerUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex items-center gap-2 text-sm text-orange-600 hover:text-orange-800 underline"
        >
          <ExternalLink className="w-4 h-4" />
          View on Block Explorer
        </a>
      </div>
      
      {/* Cost Info */}
      <div className="pt-3 border-t border-orange-200">
        <div className="text-xs text-orange-700">Inscription Cost</div>
        <div className="text-sm text-orange-900 font-medium">
          {inscriptionResult.originalsAsset.inscriptionDetails.totalCost.toLocaleString()} sats
          <span className="text-xs text-orange-700 ml-2">
            @ {inscriptionResult.originalsAsset.inscriptionDetails.feeRate} sat/vB
          </span>
        </div>
      </div>
      
      {/* Confirmation Status */}
      <div className="bg-yellow-50 border border-yellow-200 rounded-sm p-3">
        <div className="flex items-center gap-2">
          <Clock className="w-4 h-4 text-yellow-600" />
          <span className="text-xs text-yellow-800">
            Waiting for blockchain confirmation... (This may take 10-60 minutes)
          </span>
        </div>
      </div>
    </div>
  </div>
)}
```

### 5. Display All Three DIDs

For assets that have been through all layers:

```tsx
<div className="space-y-3">
  <h3 className="text-sm font-medium text-gray-700">DID History</h3>
  
  {asset.didPeer && (
    <div className="flex items-start gap-3">
      <LayerBadge layer="did:peer" size="sm" />
      <div className="flex-1 min-w-0">
        <div className="font-mono text-xs text-gray-600 break-all">
          {asset.didPeer}
        </div>
      </div>
    </div>
  )}
  
  {asset.didWebvh && (
    <div className="flex items-start gap-3">
      <LayerBadge layer="did:webvh" size="sm" />
      <div className="flex-1 min-w-0">
        <div className="font-mono text-xs text-gray-600 break-all">
          {asset.didWebvh}
        </div>
      </div>
    </div>
  )}
  
  {asset.didBtco && (
    <div className="flex items-start gap-3">
      <LayerBadge layer="did:btco" size="sm" />
      <div className="flex-1 min-w-0">
        <div className="font-mono text-xs text-gray-900 font-medium break-all">
          {asset.didBtco}
        </div>
        {asset.metadata?.inscription?.explorerUrl && (
          <a 
            href={asset.metadata.inscription.explorerUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="text-xs text-blue-600 hover:underline flex items-center gap-1 mt-1"
          >
            <ExternalLink className="w-3 h-3" />
            View on explorer
          </a>
        )}
      </div>
    </div>
  )}
</div>
```

### 6. Error Handling

```tsx
{inscriptionError && (
  <div className="mt-4 p-4 bg-red-50 border border-red-200 rounded-sm">
    <div className="flex items-center gap-2 mb-2">
      <AlertCircle className="w-4 h-4 text-red-600" />
      <h4 className="font-medium text-red-900">Inscription Failed</h4>
    </div>
    <p className="text-sm text-red-700">{inscriptionError}</p>
    {inscriptionError.includes('insufficient') && (
      <p className="text-xs text-red-600 mt-2">
        Please ensure you have enough Bitcoin to cover the inscription cost.
      </p>
    )}
    <Button
      size="sm"
      variant="outline"
      className="mt-3"
      onClick={() => setInscriptionError(null)}
    >
      Dismiss
    </Button>
  </div>
)}
```

---

## Validation Checklist

- [ ] Inscribe button visible only for did:webvh assets
- [ ] Fee estimation loads and displays correctly
- [ ] Three fee options (slow/medium/fast) shown
- [ ] Selected fee highlighted
- [ ] Warning about costs displayed
- [ ] Inscription creates did:btco identifier
- [ ] Success state shows transaction details
- [ ] Explorer link works
- [ ] All three DIDs displayed in history
- [ ] Error handling comprehensive
- [ ] Loading states clear
- [ ] Responsive on mobile
- [ ] No TypeScript errors

---

## Testing

### Manual Test Flow:

1. **Create and Publish Asset** (to get to did:webvh)
2. **View Asset** → Inscribe button visible
3. **Click Inscribe** → Fee modal appears
4. **Verify** fees load (slow/medium/fast)
5. **Select fee** (e.g., medium)
6. **Confirm** → Loading state shows
7. **Wait** → Success message appears
8. **Verify**:
   - Layer badge shows "Inscribed" (did:btco)
   - Bitcoin DID displayed
   - Transaction ID shown
   - Explorer link clickable
   - All three DIDs in history
9. **Click explorer link** → Opens mempool.space (or equivalent)
10. **Verify transaction** on block explorer

---

## Success Criteria

✅ Task is complete when:
1. UI shows inscribe button for did:webvh assets
2. Fee estimation displays correctly
3. User can select fee rate
4. Inscription updates layer to did:btco
5. Success state shows transaction details
6. Explorer link works
7. DID history displays all layers
8. Error handling comprehensive
9. Responsive design works
10. Manual testing passes

---

## Next Task

After completion, proceed to:
- **TASK_TEST03_INSCRIBE_TESTS.md** - Add tests for inscription flow
