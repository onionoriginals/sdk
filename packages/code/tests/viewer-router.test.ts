/**
 * The static viewer's routing (plan 049 §6 milestone 1, CODE-36): the
 * `serve` paths carried in the location hash so the site works under any
 * path prefix; links the view renders resolved without ever leaving the
 * viewer for a non-web scheme, and raw bytes never treated as markup.
 */
import { describe, expect, test } from "bun:test";
import { bundleSource, hashOf, resolveLink, routeOf } from "../viewer/src/router.js";

describe("CODE-36 the static viewer's router", () => {
  test("routes live in the hash", () => {
    expect(routeOf("")).toBe("/");
    expect(routeOf("#")).toBe("/");
    expect(routeOf("#/b/0/commits?page=2")).toBe("/b/0/commits?page=2");
    expect(routeOf("#//evil.example/x")).toBe("/evil.example/x");
    expect(routeOf("#L12")).toBe("/");
    expect(hashOf("/verify")).toBe("#/verify");
    expect(hashOf("b/0")).toBe("#/b/0");
  });

  test("view links become hash routes, resolved against the current route", () => {
    expect(resolveLink("/b/0/tree/v1/src", "/")).toEqual({ kind: "route", route: "/b/0/tree/v1/src", hash: "#/b/0/tree/v1/src" });
    expect(resolveLink("?page=3", "/b/0/commits?page=2")).toEqual({ kind: "route", route: "/b/0/commits?page=3", hash: "#/b/0/commits?page=3" });
    expect(resolveLink("?plain=1", "/b/1/blob/v/README.md")).toMatchObject({ route: "/b/1/blob/v/README.md?plain=1" });
    // The Markdown "Preview" toggle is `?`: it clears the query.
    expect(resolveLink("?", "/b/1/blob/v/README.md?plain=1")).toMatchObject({ route: "/b/1/blob/v/README.md" });
    expect(resolveLink("/b/0/blob/v/a%20b.md", "/")).toMatchObject({ route: "/b/0/blob/v/a%20b.md" });
  });

  test("anchors, raw bytes and web links", () => {
    expect(resolveLink("#L12", "/b/0/blob/v/a.ts")).toEqual({ kind: "anchor", id: "L12" });
    expect(resolveLink("/raw/zQmAbc", "/b/0")).toEqual({ kind: "raw", digest: "zQmAbc" });
    expect(resolveLink("https://example.com/x", "/")).toEqual({ kind: "external", href: "https://example.com/x" });
    expect(resolveLink("mailto:a@example.com", "/")).toEqual({ kind: "external", href: "mailto:a@example.com" });
  });

  test("other schemes and authorities are dropped", () => {
    for (const href of ["javascript:alert(1)", " JavaScript:alert(1)", "data:text/html,x", "vbscript:x", "//evil.example/x", "\\\\evil", "file:///etc/passwd", "", "#"]) {
      expect(resolveLink(href, "/")).toEqual({ kind: "none" });
    }
  });

  test("the bundle comes from ?bundle=, beside the page by default; zip or split by its URL", () => {
    const page = "https://o.github.io/sdk/code/?x=1#/b/0";
    expect(bundleSource("", page)).toEqual({ kind: "split", url: "https://o.github.io/sdk/code/bundle/", explicit: false });
    expect(bundleSource("?bundle=../other", page)).toEqual({ kind: "split", url: "https://o.github.io/sdk/other/", explicit: true });
    expect(bundleSource("?bundle=https://h.example/r/repo.zip", page)).toEqual({ kind: "zip", url: "https://h.example/r/repo.zip", explicit: true });
    expect(() => bundleSource("?bundle=javascript:alert(1)", page)).toThrow();
    expect(() => bundleSource("?bundle=file:///x/", page)).toThrow();
  });
});
