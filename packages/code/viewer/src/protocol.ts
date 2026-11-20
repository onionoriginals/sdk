/** Messages between the viewer page and its verification worker. */

export type ToWorker =
  | { type: "open-url"; kind: "zip" | "split"; url: string }
  | { type: "open-bytes"; name: string; bytes: Uint8Array }
  | { type: "render"; id: number; route: string }
  | { type: "raw"; id: number; digest: string }
  | { type: "check-all" };

/** What the page shows about the bundle, outside the rendered pages. */
export interface Status {
  layout: "zip" | "split";
  source: string;
  /** Seconds the verification took in this browser. */
  seconds: number;
  repo: { verified: boolean; status: string };
  /** Split bundles: loose objects (files) and where they stand. */
  objects?: { trees: number; loose: number; loaded: number; notLoaded: number; failed: number };
  /** True once every object was fetched and the bundle verified again over all of them. */
  checkedAll: boolean;
}

export type FromWorker =
  | { type: "progress"; text: string }
  | { type: "ready"; status: Status }
  | { type: "failed"; message: string }
  | { type: "page"; id: number; status: number; html: string }
  /** The page needs an object that could not be loaded: it is not shown, and not verified. */
  | { type: "not-loaded"; id: number; digest: string; reason: string }
  | { type: "raw"; id: number; bytes: Uint8Array | null; text: boolean }
  | { type: "objects"; objects: NonNullable<Status["objects"]> };
