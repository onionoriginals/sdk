/** Public discovery projection. Account, funding and claimed Bitcoin state never enter this DTO. */
export interface PublishedOriginal {
  did: string;
  assetDid: string;
  title: string;
  createdAt: string;
  controller: string;
  resourceCount: number;
  resourceHash: string;
  resourceContentType?: string;
  resourceUrl?: string;
  logUrl: string;
  celUrl: string;
}
export interface ExplorePage {
  originals: PublishedOriginal[];
  total: number;
  nextOffset: number | null;
}
