/**
 * Client-side routing for the static viewer (plan 049 §6 milestone 1). The
 * pages are `createRepositoryView`'s, addressed by the same paths as
 * `originals-code serve` (`/b/0/tree/…`), carried in the location hash so
 * the site works under any path prefix with no server rewrite:
 *
 *   https://host/prefix/?bundle=bundle/#/b/0/commits?page=2
 *
 * The query string belongs to the page (which bundle); the hash is the route.
 */

/** The view route a location hash names: `#/b/0` → `/b/0`; empty → `/`. */
export function routeOf(hash: string): string {
  const h = hash.startsWith("#") ? hash.slice(1) : hash;
  if (!h.startsWith("/")) return "/";
  // A route never carries an authority or a scheme: `//evil` is a path here.
  return `/${h.replace(/^\/+/, "")}`;
}

/** The location hash for a view route. */
export function hashOf(route: string): string {
  return `#${route.startsWith("/") ? route : `/${route}`}`;
}

export type Link =
  /** Another page of the viewer. */
  | { kind: "route"; route: string; hash: string }
  /** A position in the current page (`#L12`). */
  | { kind: "anchor"; id: string }
  /** An object's raw bytes (`/raw/<digest>`), shown as plain text or downloaded, never as markup. */
  | { kind: "raw"; digest: string }
  /** A web link from a README, opened in a new tab without access to this page. */
  | { kind: "external"; href: string }
  /** Anything else is dropped. */
  | { kind: "none" };

const BASE = "http://viewer.invalid";

function decode(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

/** What an `href` in a rendered page means, relative to the current route. */
export function resolveLink(href: string, current: string): Link {
  const h = href.trim();
  if (h === "") return { kind: "none" };
  if (/^(https?:|mailto:)/i.test(h)) return { kind: "external", href: h };
  if (h.startsWith("#")) return h.length > 1 ? { kind: "anchor", id: decode(h.slice(1)) } : { kind: "none" };
  if (/^[a-z][a-z0-9+.-]*:/i.test(h) || h.startsWith("//") || h.startsWith("\\")) return { kind: "none" };
  let u: URL;
  try {
    u = new URL(h, `${BASE}${current.startsWith("/") ? current : `/${current}`}`);
  } catch {
    return { kind: "none" };
  }
  if (u.origin !== BASE) return { kind: "none" };
  const raw = /^\/raw\/([^/]+)$/.exec(u.pathname);
  if (raw) return { kind: "raw", digest: decode(raw[1]) };
  // `?` alone (the Markdown "Preview" toggle) clears the query.
  const route = `${u.pathname}${u.search === "?" ? "" : u.search}`;
  return { kind: "route", route, hash: hashOf(route) };
}

/**
 * Where the bundle is, from the page's query string: `?bundle=<url>`
 * (relative to the page), or `bundle/` beside the page. A URL ending in
 * `.zip` is a zip bundle; anything else is a split bundle's directory.
 */
export function bundleSource(search: string, page: string): { kind: "zip" | "split"; url: string; explicit: boolean } {
  const given = new URLSearchParams(search).get("bundle")?.trim();
  const url = new URL(given ? given : "bundle/", page);
  if (url.protocol !== "https:" && url.protocol !== "http:") throw new Error("the bundle URL must be http(s)");
  url.hash = "";
  if (/\.zip$/i.test(url.pathname)) return { kind: "zip", url: url.href, explicit: !!given };
  if (!url.pathname.endsWith("/")) url.pathname += "/";
  return { kind: "split", url: url.href, explicit: !!given };
}
