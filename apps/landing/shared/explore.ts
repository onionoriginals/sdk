/** Public discovery projection. Account, funding and claimed Bitcoin state never enter this DTO. */
export interface PublishedOriginal {
  did: string;
  assetId: string;
  title: string;
  createdAt: string;
  controller: string;
  resourceCount: number;
  resourceHash: string;
  resourceContentType?: string;
  resourceUrl?: string;
  logUrl: string;
  celUrl: string;
  /** The satoshi number this Original is inscribed on, once migrated to Bitcoin. Absent for a webvh-only publication. */
  sat?: string;
}
export interface ExplorePage {
  originals: PublishedOriginal[];
  total: number;
  nextOffset: number | null;
}
