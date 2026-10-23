---
'@originals/landing': minor
---

A staging build with `VITE_ACCEPTANCE_HOSTED_PUBLICATION=1` and a `VITE_WEBVH_HOST` other than `originals.build` turns hosted publication on for the #976 section B run. It is ignored on the production host, and `hostedPublication` stays off everywhere else. The signed-out copy now says the key is made in the page and discarded, that nothing is saved, and that publishing needs sign-in; it no longer describes a browser-held identity key, a backup file or anonymous publication.
