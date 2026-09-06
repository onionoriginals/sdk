---
"@originals/landing": patch
---

**Deposit screen: pay first, read second — plus a QR and a copy button.**

The amount was stated, then five paragraphs of disclosure, then the address.
Someone who had already decided to pay had to read ~250 words of terms to
reach the string they needed — which is how a person learns to scroll past
terms rather than read them.

Now the action comes first: amount, address, copy button, and a scannable
BIP-21 QR in one block. Below it, the substance of the two money risks (no
withdraw or refund, no reversing a broadcast fee) in a form that needs no
click. Below that, the full R27 text — complete and unedited — in a `<details>`
on the same screen.

Nothing was deleted and nothing moved off the page. A test asserts every line
of the disclosure contract is still rendered, and that the short lines are
additions rather than replacements.

Also: the deposit address had no copy button, on the one screen in the app
where a string has to be exact because real money depends on it, while three
other screens had one. The `bitcoin:` link carries the address and the exact
amount, so paying involves no transcription at all.
