---
"@originals/landing": patch
---

Fix a production outage where every request to `originals.build/` (pathname `/`) returned 500 with `EISDIR: illegal operation on a directory, read`. The durable Originals `serve()`/`read()` mapped a directory-resolving key (e.g. `<host>/` for `/`, which exists once anything is hosted) through `readFileSync`, throwing `EISDIR` and crashing the request instead of falling through to the SPA. Both now guard with `statSync(path).isFile()` inside a try/catch (also closing the `existsSync`→`stat` TOCTOU), so a directory or vanished key is a clean miss/404.
