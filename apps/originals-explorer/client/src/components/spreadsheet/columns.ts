export type AssetRow = {
  id: string;
  title: string;
  assetType: string;
  status: string;
  category?: string | null;
  tags?: string[] | null;
  mediaUrl?: string | null;
  metadata?: Record<string, unknown> | null;
  createdAt: string | Date;
  updatedAt: string | Date;
};

export type SpreadsheetColumn<T> = {
  key: string;
  header: string;
  field?: keyof T;
  accessor?: (row: T) => React.ReactNode;
  width?: string;
  align?: 'left' | 'right' | 'center';
};

export const defaultAssetColumns: SpreadsheetColumn<AssetRow>[] = [
  { key: 'title', header: 'Title', field: 'title' },
  { key: 'assetType', header: 'Type', field: 'assetType' },
  { key: 'status', header: 'Status', field: 'status' },
  { key: 'category', header: 'Category', accessor: (r) => r.category || '—' },
  {
    key: 'tags',
    header: 'Tags',
    accessor: (r) => (r.tags && r.tags.length ? r.tags.join(', ') : '—'),
  },
  {
    key: 'createdAt',
    header: 'Created',
    accessor: (r) => new Date(r.createdAt).toLocaleDateString(),
  },
  {
    key: 'updatedAt',
    header: 'Updated',
    accessor: (r) => new Date(r.updatedAt).toLocaleDateString(),
  },
];


