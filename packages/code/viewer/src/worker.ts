/**
 * The viewer's verification worker (plan 049 §6 milestone 1). Everything that
 * vouches for the repository runs here, in the visitor's browser: the bundle
 * is downloaded, every Original verified through the SDK unchanged, the code
 * checks run, and pages rendered with `createRepositoryView` from the
 * verified entries only. The host serves bytes and nothing else.
 */
/// <reference lib="webworker" />
import { ObjectNotLoadedError, openRepository, openSplitRepository, type OpenedRepository, type OpenedSplitRepository } from "../../src/index.js";
import { createRepositoryView } from "../../src/view.js";
import type { FromWorker, Status, ToWorker } from "./protocol.js";

declare const self: DedicatedWorkerGlobalScope;

let opened: OpenedRepository | OpenedSplitRepository | undefined;
let view: ReturnType<typeof createRepositoryView> | undefined;
let status: Status | undefined;

const post = (m: FromWorker, transfer: Transferable[] = []) => self.postMessage(m, transfer);
const isSplit = (o: OpenedRepository | undefined): o is OpenedSplitRepository => !!o && "split" in o;

async function download(url: string): Promise<Uint8Array> {
  const r = await fetch(url, { credentials: "omit", cache: "no-cache" });
  if (!r.ok) throw new Error(`${url}: HTTP ${r.status}`);
  return new Uint8Array(await r.arrayBuffer());
}

/** A split bundle's files, relative to its directory. 404 is absence; any other failure is an error. */
function splitFetch(base: string) {
  return async (path: string): Promise<Uint8Array | undefined> => {
    const r = await fetch(new URL(path, base), { credentials: "omit" });
    if (r.status === 404) return undefined;
    if (!r.ok) throw new Error(`${path}: HTTP ${r.status}`);
    return new Uint8Array(await r.arrayBuffer());
  };
}

function summarize(layout: Status["layout"], source: string, seconds: number, checkedAll: boolean): Status {
  const r = opened!.report;
  const verified = !!r.repo.report?.validAsOf && r.repo.code?.history.status === "valid";
  return {
    layout,
    source,
    seconds,
    repo: { verified, status: r.repo.code?.history.status ?? r.repo.report?.history.status ?? "unverified" },
    ...(isSplit(opened) ? { objects: opened.split.counts() } : {}),
    checkedAll,
  };
}

async function open(layout: Status["layout"], source: string, load: () => Promise<OpenedRepository>): Promise<void> {
  const started = performance.now();
  post({ type: "progress", text: layout === "zip" ? "Verifying the bundle…" : "Verifying the logs and trees…" });
  opened = await load();
  view = createRepositoryView(opened);
  status = summarize(layout, source, (performance.now() - started) / 1000, layout === "zip");
  post({ type: "ready", status });
}

async function handle(m: ToWorker): Promise<void> {
  switch (m.type) {
    case "open-url": {
      if (m.kind === "zip") {
        post({ type: "progress", text: `Downloading ${m.url}…` });
        const bytes = await download(m.url);
        await open("zip", m.url, () => openRepository(bytes));
      } else {
        post({ type: "progress", text: `Downloading the logs from ${m.url}…` });
        await open("split", m.url, () => openSplitRepository(splitFetch(m.url)));
      }
      return;
    }
    case "open-bytes":
      await open("zip", m.name, () => openRepository(m.bytes));
      return;
    case "render": {
      if (!view) throw new Error("no bundle is open");
      try {
        const r = await view.handle(m.route);
        post({ type: "page", id: m.id, status: r.status, html: typeof r.body === "string" ? r.body : new TextDecoder().decode(r.body) });
      } catch (e) {
        if (!(e instanceof ObjectNotLoadedError)) throw e;
        post({ type: "not-loaded", id: m.id, digest: e.digest, reason: e.reason });
      }
      if (isSplit(opened)) post({ type: "objects", objects: opened.split.counts() });
      return;
    }
    case "raw": {
      try {
        const bytes = (await opened?.objects(m.digest)) ?? null;
        const text = !!bytes && !bytes.subarray(0, 8000).includes(0);
        post({ type: "raw", id: m.id, bytes, text });
      } catch (e) {
        if (!(e instanceof ObjectNotLoadedError)) throw e;
        post({ type: "not-loaded", id: m.id, digest: e.digest, reason: e.reason });
      }
      return;
    }
    case "check-all": {
      if (!isSplit(opened) || !status) return;
      const split = opened;
      const started = performance.now();
      await split.split.loadAll({
        concurrency: 12,
        onProgress: (done, total) => {
          if (done % 50 === 0 || done === total) post({ type: "progress", text: `Fetching and checking files: ${done} of ${total}…` });
        },
      });
      post({ type: "progress", text: "Verifying again over every file…" });
      await split.reverify();
      view = createRepositoryView(split);
      const counts = split.split.counts();
      status = summarize("split", status.source, status.seconds + (performance.now() - started) / 1000, counts.notLoaded === 0);
      post({ type: "ready", status });
      return;
    }
  }
}

self.onmessage = (ev: MessageEvent<ToWorker>) => {
  handle(ev.data).catch((e: unknown) => post({ type: "failed", message: e instanceof Error ? e.message : String(e) }));
};
