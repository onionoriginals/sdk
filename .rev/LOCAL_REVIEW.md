Local Claude reviews are staged alongside the existing REV gate. The Mac worker reviews one PR at a time after CI passes; Actions verifies signed results against current head/base/request. No Claude credentials are stored in Actions.

Operations and manual commands: https://github.com/aviarytech/rev/blob/0880e30c5da57265bf77cf79421fd3e163922762/docs/local-review.md

Do not replace required checks until live positive and negative validation is complete.
