# Dual-Pane Explorer UI - Implementation Guide

## Overview

A modern, dual-pane file explorer interface built with React, TypeScript, Tailwind CSS, and Shadcn UI components. The explorer provides an intuitive way to browse, search, and manage digital assets across three layers: Private (did:peer), Public (did:webvh), and Property (did:btco).

## Features

### ✨ Core Features

- **Dual-Pane Layout**: Classic two-panel design with resizable panels
  - Left pane: Directory tree with expandable folders
  - Right pane: Asset grid/list view with details panel

- **Responsive Design**: Works seamlessly across desktop and tablet devices

- **View Modes**:
  - Grid view: Visual card-based layout
  - List view: Compact table-like layout
  - Details panel: In-depth asset information

- **Search & Filter**: Real-time search across asset titles and content

- **Sorting**: Sort by name, date modified, type, or size (ascending/descending)

- **Panel Resizing**: Drag-to-resize panels with customizable widths

### 🎨 UI Components Used

All components are from Shadcn UI (built on Radix UI primitives):

- `ResizablePanelGroup`, `ResizablePanel`, `ResizableHandle` - Panel layout and resizing
- `ScrollArea` - Smooth scrolling for content areas
- `Breadcrumb` - Navigation path display
- `Button` - Action buttons and interactive elements
- `Input` - Search functionality
- `Card` - Asset cards in grid view
- `Badge` - Layer indicators (Private/Public/Property)
- `Separator` - Visual dividers
- `DropdownMenu` - Sort options menu
- Lucide React icons - File type and action icons

## Architecture

### Component Structure

```
DualPaneExplorer (Main orchestrator)
├── ExplorerTopBar
│   ├── Breadcrumb navigation
│   ├── Search input
│   ├── View mode toggles
│   ├── Sort dropdown
│   └── Action buttons (Refresh, New Asset, Upload)
│
├── ResizablePanelGroup
│   ├── DirectoryTree (Left pane)
│   │   ├── Folder sections (Private/Public/Property)
│   │   ├── Expandable/collapsible folders
│   │   └── Asset list per folder
│   │
│   └── ContentPane (Right pane)
│       ├── Grid/List view of assets
│       └── Asset details panel (when selected)
```

### File Structure

```
client/src/components/explorer/
├── types.ts                 # TypeScript interfaces and types
├── utils.ts                 # Utility functions
├── DualPaneExplorer.tsx    # Main component
├── ExplorerTopBar.tsx      # Top navigation bar
├── DirectoryTree.tsx       # Left pane folder tree
├── ContentPane.tsx         # Right pane content view
└── index.ts                # Public exports
```

## Data Model

### Asset Interface

```typescript
interface Asset {
  id: string;
  title: string;
  content?: string;
  type: 'document' | 'image' | 'audio' | 'video' | 'other';
  layer: 'private' | 'public' | 'property';
  updatedAt: string;
  createdAt: string;
  size?: number;
  mimeType?: string;
  thumbnailUrl?: string;
  metadata?: Record<string, unknown>;
}
```

### Folder Structure

```typescript
interface FolderNode {
  id: string;
  name: string;
  layer: 'private' | 'public' | 'property';
  icon: string;
  color: string;
  description: string;
  expanded: boolean;
  assets: Asset[];
}
```

## Integration

### Usage in Homepage

The explorer is integrated into the homepage as the main feature:

```tsx
import { DualPaneExplorer } from "@/components/explorer";

export default function Homepage() {
  return (
    <div className="h-[calc(100vh-4rem)] w-full">
      <DualPaneExplorer />
    </div>
  );
}
```

### Data Source

Currently, the explorer reads assets from localStorage:
- Key: `originals-documents`
- Format: Array of document objects
- Auto-refresh on storage events

### Extending the Explorer

#### Adding New Asset Types

1. Update `AssetType` in `types.ts`:
```typescript
export type AssetType = 'document' | 'image' | 'audio' | 'video' | 'pdf' | 'other';
```

2. Add icon mapping in `ContentPane.tsx`:
```typescript
import { FileCode } from 'lucide-react';

const assetTypeIcons: Record<AssetType, typeof File> = {
  // ... existing types
  pdf: FileCode,
};
```

3. Update detection logic in `utils.ts`:
```typescript
export function detectAssetType(title: string, mimeType?: string): AssetType {
  // ... existing logic
  const pdfExts = ['pdf'];
  if (pdfExts.includes(ext)) return 'pdf';
}
```

#### Adding New Folders/Layers

1. Add layer type to `types.ts`:
```typescript
export type AssetLayer = 'private' | 'public' | 'property' | 'archived';
```

2. Update folder creation in `utils.ts`:
```typescript
export function createFolderStructure(assets: Asset[]): FolderNode[] {
  return [
    // ... existing folders
    {
      id: 'archived',
      name: 'Archived',
      layer: 'archived',
      icon: 'Archive',
      color: 'gray',
      description: 'Archived assets',
      expanded: false,
      assets: assets.filter(a => a.layer === 'archived'),
    },
  ];
}
```

#### Custom Actions

Add custom actions to the details panel in `ContentPane.tsx`:

```tsx
<Button onClick={() => customAction(selectedAsset)}>
  <CustomIcon className="w-4 h-4 mr-2" />
  Custom Action
</Button>
```

## Styling & Theming

### Color Scheme

The explorer uses Tailwind CSS with Shadcn's neutral base color:

- Background: `bg-background` (adapts to light/dark mode)
- Muted backgrounds: `bg-muted/30`, `bg-muted/50`
- Text: `text-foreground`, `text-muted-foreground`
- Accents: `bg-accent`, `text-accent-foreground`
- Borders: `border`

### Layer Colors

- **Private**: Blue (`text-blue-500`, `bg-blue-100`)
- **Public**: Green (`text-green-500`, `bg-green-100`)
- **Property**: Orange (`text-orange-500`, `bg-orange-100`)

### Transitions

All interactive elements use smooth transitions:
- `transition-colors duration-150` for hover states
- `transition-all duration-150` for complex transitions

### Responsive Breakpoints

- Mobile: Base styles
- Tablet: `md:` prefix (768px+)
- Desktop: `lg:` prefix (1024px+)
- Large Desktop: `xl:` prefix (1280px+)

## Accessibility

### Keyboard Navigation

- Tab navigation through all interactive elements
- Enter/Space to activate buttons and select items
- Arrow keys for scrolling (via ScrollArea)

### Screen Readers

- Semantic HTML structure
- ARIA labels on icon-only buttons
- Descriptive breadcrumbs
- Proper heading hierarchy

### Visual Accessibility

- High contrast text and backgrounds
- Focus rings on interactive elements
- Sufficient color contrast ratios
- Resizable panels for customization

## Performance

### Optimizations

1. **Memoization**: Uses `useMemo` for filtered and sorted asset lists
2. **Virtualization Ready**: ScrollArea supports large lists efficiently
3. **Lazy Loading**: Can easily add pagination or infinite scroll
4. **Event Debouncing**: Search can be debounced for large datasets

### Bundle Size

- Main component bundle: ~5KB (gzipped)
- Dependencies: Already included in project (no new deps)
- Total impact: Minimal (uses existing Shadcn components)

## Browser Support

- Chrome/Edge: Latest 2 versions
- Firefox: Latest 2 versions
- Safari: Latest 2 versions
- Mobile browsers: iOS Safari 14+, Chrome Android

## Development

### Running the Explorer

```bash
cd apps/originals-explorer
bun run dev
```

Navigate to `http://localhost:5001` and the homepage will show the dual-pane explorer.

### Building

```bash
bun run build
```

### Type Checking

```bash
bun run check
```

## Future Enhancements

### Planned Features

- [ ] Drag & drop file upload to folders
- [ ] Multi-select assets with Ctrl/Cmd+Click
- [ ] Bulk operations (delete, move, migrate)
- [ ] Context menu (right-click) on assets and folders
- [ ] Asset preview for images, videos, audio
- [ ] Thumbnail generation and caching
- [ ] Advanced filters (by date range, file size, type)
- [ ] Custom folder creation and management
- [ ] Recent files and favorites
- [ ] Export/import asset collections

### Potential Integrations

- **Google Drive**: Import assets from Google Drive
- **Dropbox**: Sync with Dropbox folders
- **IPFS**: Upload assets to IPFS
- **Bitcoin**: Direct migration to did:btco
- **Verifiable Credentials**: Attach credentials to assets

## Troubleshooting

### Assets Not Showing

1. Check browser console for errors
2. Verify localStorage key: `originals-documents`
3. Ensure asset format matches `Asset` interface
4. Dispatch `originals-documents-updated` event after changes

### Panel Resizing Issues

1. Ensure parent container has defined height
2. Check ResizablePanelGroup direction prop
3. Verify min/max size constraints
4. Test in different browsers

### Search Not Working

1. Verify `searchQuery` state updates
2. Check `filterAssets` function in utils
3. Ensure assets have `title` and `content` fields
4. Test with different search terms

### Performance Issues

1. Add debouncing to search input
2. Implement pagination for large asset lists
3. Use React.memo for expensive components
4. Consider virtualization for 1000+ assets

## Credits

- **Design Inspiration**: Total Commander, Norton Commander, fman
- **UI Components**: Shadcn UI (https://ui.shadcn.com)
- **Icons**: Lucide React (https://lucide.dev)
- **Resizable Panels**: react-resizable-panels
- **Framework**: React 18 + TypeScript + Vite

## License

MIT License - Part of the Originals Protocol SDK

---

**Maintainer**: Originals Team
**Last Updated**: November 2025
**Version**: 1.0.0
