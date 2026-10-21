---
'@originals/sdk': minor
'@originals/vh': minor
---

Editors (Originals spec P5.15–P5.18, a432aa6). The author grants editors in the asset state (`editors: [{ did, name, metadata, resources }]`, PROVISIONAL names) and grants, narrows or revokes them with author entries; an editor signs its own entries with its own DID through `sdk.edit(did, { parent, editor, signer, ... })`, checked against the grant in the parent's state, with the parent's author reference, empty parameters and only the content the grant allows. Only author entries change grants, aliases, lifecycle or parameters, or create, anchor or deactivate. Reports list each editor's identity evidence and freshness in `identityEvidence.editors`; P7.9 and per-signer version order apply to editor keys. Evidence packages carry every signer's DID history (`missing` identity items gain `role`). New error category `outside-grant`. Signing requests name the signer (`summary.signer`) and carry `display` text from the new `describeEntry`; `keySigner` gains `confirm` and refuses summaries that misstate the entry. `EditInput.author` is optional for editor edits. `ORIGINALS_LIMITS.editors` caps grants.
