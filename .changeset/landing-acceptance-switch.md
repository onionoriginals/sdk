---
'@originals/landing': minor
---

A staging build with `VITE_ACCEPTANCE_HOSTED_PUBLICATION=1` and a `VITE_WEBVH_HOST` other than `originals.build` turns hosted publication on for the #976 section B run. It is ignored on the production host and on mainnet builds, and `hostedPublication` stays off everywhere else; the server reports the switch set on a mainnet or production-host instance. Signed out, the publish step is locked in every build, and the signed-out note shows whether or not publication is on. The signed-out copy now says the guest key is saved in this browser with the work, unencrypted, that anyone using the browser can sign as that guest, and that signing in signs with your own key and publishes; it no longer describes a browser-held identity key, a backup file or anonymous publication.
