---
"@originals/landing": patch
---

**Fix: the signing bootstrap now says which step failed, at error level.**

Three unrelated subsystems failed into one catch — the browser's IndexedDB key,
Turnkey's OTP_LOGIN, and the Bitcoin funding account — and all three reported
the same `console.warn`. Warn is hidden by the default "Errors" console filter,
which is the filter in use when someone is debugging a broken page, so the one
line explaining the failure was the one line they could not see.

It now reports at error level and names the step and the origin (fresh sign-in
vs. restore-on-reload), with the error object passed through unflattened so
Turnkey's own fields stay inspectable.

Also closes the last silent path: on a real-network build, a missing browser
key or a missing `verificationToken` returned early with signing left at
`'none'`, which renders "sign in again to get one" for a browser that just did
— the same defect as the gate, one layer earlier, and reporting nothing at all.
Both now report and set `unavailable`.
