/**
 * The static viewer's page (plan 049 §6 milestone 1): routing, the bundle
 * picker and the status bar. Verification and rendering happen in the worker;
 * this side only places the rendered page into the document.
 *
 * Pages are built by `createRepositoryView`, which escapes all repository
 * content. As a second line, the page is parsed inert and stripped of any
 * script, style, frame, form or event attribute before it is shown, every
 * link is rewritten to a hash route, and the Content Security Policy allows
 * no inline script or style.
 */
import { bundleSource, hashOf, resolveLink, routeOf } from "./router.js";
import type { FromWorker, Status, ToWorker } from "./protocol.js";

const app = document.getElementById("app")!;
const bar = document.getElementById("status")!;
const worker = new Worker(new URL("./worker.js", import.meta.url), { type: "module" });
let ready = false;
let status: Status | undefined;
let seq = 0;
const pending = new Map<number, (m: FromWorker) => void>();

const send = (m: ToWorker, transfer: Transferable[] = []) => worker.postMessage(m, transfer);

function el<K extends keyof HTMLElementTagNameMap>(tag: K, props: Partial<Record<string, string>> = {}, ...children: Array<Node | string>): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) if (v !== undefined) e.setAttribute(k, v);
  e.append(...children);
  return e;
}

// ---- the status bar: results stay separate, not-loaded is never verified ----

function renderStatus(): void {
  bar.replaceChildren();
  if (!status) return;
  const s = status;
  const parts: Node[] = [
    el("span", { class: `badge ${s.repo.verified ? "good" : "bad"}` }, el("b", {}, "repo "), s.repo.verified ? "verified in this browser" : s.repo.status),
    el("span", { class: "muted" }, ` ${s.layout === "zip" ? "Zip bundle" : "Split bundle"} · verified in ${s.seconds.toFixed(1)} s · no key · nothing current (P7.10) `),
  ];
  if (s.objects) {
    const o = s.objects;
    parts.push(
      el("span", { class: `badge ${o.failed ? "bad" : o.notLoaded ? "warn" : "good"}`, title: "Each file is fetched by digest when opened and checked on arrival. A file not loaded is not verified." },
        el("b", {}, "files "),
        `${o.loaded} of ${o.loose} loaded and checked · ${o.notLoaded} not loaded (not verified)${o.failed ? ` · ${o.failed} failed` : ""}`),
    );
    if (o.notLoaded > 0) {
      const b = el("button", { class: "btn sm", type: "button" }, "Fetch and check every file");
      b.addEventListener("click", () => {
        b.setAttribute("disabled", "");
        send({ type: "check-all" });
      });
      parts.push(b);
    }
  }
  const other = el("button", { class: "btn sm", type: "button" }, "Open another bundle");
  other.addEventListener("click", () => picker(""));
  parts.push(el("span", { class: "grow" }), other);
  bar.append(el("div", { class: "wrap bar" }, ...parts));
}

function progress(text: string): void {
  bar.replaceChildren(el("div", { class: "wrap bar" }, el("span", { class: "muted" }, text)));
}

// ---- placing a rendered page ----

const DROP = "script,style,link,meta,base,iframe,frame,object,embed,form,input,button,textarea,select,svg,math,template";

function place(html: string, route: string): void {
  // The view's inline stylesheet is served as style.css here; parsing it inline would only trip the CSP.
  // (Repository content is escaped by the view, so no `<style` in it survives as markup.)
  const doc = new DOMParser().parseFromString(html.replace(/<style\b[\s\S]*?<\/style>/gi, ""), "text/html");
  for (const n of doc.querySelectorAll(DROP)) n.remove();
  for (const n of doc.querySelectorAll("*")) {
    for (const a of [...n.attributes]) if (/^on/i.test(a.name) || a.name === "style" || a.name === "srcdoc" || a.name === "src" || a.name === "action" || a.name === "formaction") n.removeAttribute(a.name);
  }
  for (const a of doc.querySelectorAll("a[href]")) {
    const link = resolveLink(a.getAttribute("href") ?? "", route);
    a.removeAttribute("href");
    if (link.kind === "route") a.setAttribute("href", link.hash);
    else if (link.kind === "anchor") {
      a.setAttribute("href", "#");
      a.setAttribute("data-anchor", link.id);
    } else if (link.kind === "raw") {
      a.setAttribute("href", "#");
      a.setAttribute("data-raw", link.digest);
    } else if (link.kind === "external") {
      a.setAttribute("href", link.href);
      a.setAttribute("rel", "noopener noreferrer nofollow");
      a.setAttribute("target", "_blank");
    }
  }
  document.title = doc.title || "originals code";
  app.replaceChildren(...[...doc.body.childNodes].map((n) => document.adoptNode(n)));
  window.scrollTo(0, 0);
}

function notLoaded(digest: string, reason: string): void {
  const retry = el("button", { class: "btn", type: "button" }, "Try again");
  retry.addEventListener("click", () => void show());
  app.replaceChildren(
    el("main", { class: "wrap" },
      el("div", { class: "box" },
        el("div", { class: "boxhead" }, el("span", { class: "badge bad" }, el("b", {}, "content "), "not loaded")),
        el("div", { class: "pad" },
          el("p", {}, "A file this page needs could not be loaded, so it is not shown and not verified."),
          el("p", {}, el("code", {}, digest), ": ", reason),
          retry,
        ),
      ),
    ),
  );
}

function request(m: ToWorker & { id: number }): Promise<FromWorker> {
  return new Promise((done) => {
    pending.set(m.id, done);
    send(m);
  });
}

async function show(): Promise<void> {
  if (!ready) return;
  const route = routeOf(location.hash);
  const r = await request({ type: "render", id: ++seq, route });
  if (r.type === "page") place(r.html, route);
  else if (r.type === "not-loaded") notLoaded(r.digest, r.reason);
}

async function raw(digest: string): Promise<void> {
  const r = await request({ type: "raw", id: ++seq, digest });
  if (r.type === "not-loaded") return notLoaded(r.digest, r.reason);
  if (r.type !== "raw" || !r.bytes) return;
  // Never as markup: text is shown as text/plain, anything else downloads.
  const blob = new Blob([r.bytes as BlobPart], { type: r.text ? "text/plain;charset=utf-8" : "application/octet-stream" });
  const url = URL.createObjectURL(blob);
  const a = el("a", { href: url, download: digest, rel: "noopener" });
  if (r.text) {
    a.removeAttribute("download");
    a.setAttribute("target", "_blank");
  }
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

app.addEventListener("click", (ev) => {
  const a = (ev.target as Element | null)?.closest("a");
  if (!a) return;
  const anchor = a.getAttribute("data-anchor");
  const digest = a.getAttribute("data-raw");
  if (anchor !== null) {
    ev.preventDefault();
    const target = document.getElementById(anchor);
    for (const t of document.querySelectorAll(".target")) t.classList.remove("target");
    target?.classList.add("target");
    target?.scrollIntoView({ block: "center" });
  } else if (digest !== null) {
    ev.preventDefault();
    void raw(digest);
  }
});

window.addEventListener("hashchange", () => void show());

// ---- choosing a bundle ----

function picker(message: string): void {
  ready = false;
  const url = el("input", { type: "url", name: "bundle", placeholder: "https://…/bundle/ or https://…/repo.zip", class: "input" });
  const go = el("button", { class: "btn", type: "button" }, "Open");
  go.addEventListener("click", () => {
    const q = new URLSearchParams({ bundle: url.value });
    location.search = q.toString();
  });
  const file = el("input", { type: "file", accept: ".zip,application/zip" });
  file.addEventListener("change", () => {
    const f = file.files?.[0];
    if (!f) return;
    progress(`Reading ${f.name}…`);
    void f.arrayBuffer().then((b) => {
      const bytes = new Uint8Array(b);
      send({ type: "open-bytes", name: f.name, bytes }, [bytes.buffer]);
    });
  });
  bar.replaceChildren();
  app.replaceChildren(
    el("main", { class: "wrap" },
      el("div", { class: "box" },
        el("div", { class: "boxhead" }, el("b", {}, "Open a repo bundle")),
        el("div", { class: "pad" },
          ...(message ? [el("p", { class: "bad-text" }, message)] : []),
          el("p", { class: "muted" }, "The bundle is verified here, in your browser, with no key: every Original through the Originals SDK, then the code checks. The site only serves bytes."),
          el("p", {}, el("label", {}, "A split bundle's directory or a repo.zip URL: ", url, " ", go)),
          el("p", {}, el("label", {}, "Or a repo.zip from your disk: ", file)),
        ),
      ),
    ),
  );
}

worker.onmessage = (ev: MessageEvent<FromWorker>) => {
  const m = ev.data;
  switch (m.type) {
    case "progress":
      progress(m.text);
      return;
    case "ready":
      ready = true;
      status = m.status;
      renderStatus();
      void show();
      return;
    case "failed":
      if (!ready) picker(`The bundle could not be verified or read: ${m.message}`);
      else progress(`Error: ${m.message}`);
      return;
    case "objects":
      if (status) {
        status = { ...status, objects: m.objects };
        renderStatus();
      }
      return;
    default: {
      const done = pending.get(m.id);
      pending.delete(m.id);
      done?.(m);
    }
  }
};

try {
  const source = bundleSource(location.search, location.href);
  progress("Starting…");
  if (!location.hash) history.replaceState(null, "", hashOf("/"));
  send({ type: "open-url", kind: source.kind, url: source.url });
} catch (e) {
  picker(e instanceof Error ? e.message : String(e));
}
