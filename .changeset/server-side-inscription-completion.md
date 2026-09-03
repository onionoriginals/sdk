---
"@originals/landing": minor
---

**The server now finishes a confirmed-commit inscription without waiting for a browser tab.**

Measured on mainnet: a commit confirmed at 07:00Z and its reveal was not broadcast until 04:45Z the next day — **21.7 hours** — because reveal recovery ran only on the `/me` list poll, and the creator had closed the page. Nothing was wrong with the reveal; it was signed and persisted the whole time. The hourly server sweep could see the record but only warned about it.

For a creator with a tab open that is slow. For a stranger who closes the tab it is spent money and no inscription, permanently: there is no email, no notification, and no other path back.

The hourly sweep now completes what it safely can. For each record at `commit_broadcast` whose commit is confirmed on-chain, it broadcasts the persisted reveal through the same idempotent path the manual "Finish inscription" button uses.

Three rules it holds to, since this spends real funds with nobody present:

- **An unconfirmed commit is left alone.** The reveal spends the commit's output 0, so pushing early is a guaranteed rejection.
- **An already-known transaction counts as success.** The client poll may push the same reveal at the same moment; both sides racing to finish one inscription is the expected case, and the record still advances so it is not swept again every hour.
- **A failed push does not advance the record.** Claiming `reveal_broadcast` for a reveal that never landed would hide it from this sweep forever.

Every push, skip and failure goes to the money log under four new events, disclosed on the privacy page — a test enforces that the disclosure lists exactly the events the code can emit.
