/** Public discovery projection. Account and funding details never enter this DTO. Bitcoin discovery hints require client verification. */
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
  /** Untrusted satoshi discovery hint; verify fresh Bitcoin history against the hosted asset before treating it as a publication. */
  sat?: string;
}
export interface ExplorePage {
  originals: PublishedOriginal[];
  total: number;
  nextOffset: number | null;
}
