---
"@azx/ribo-adapter-snuggpro": minor
---

Add the pure write-body builder (`src/write/body.ts`) that turns a reviewed
Snugg Pro patch into the JSON body one of the vendor's write operations
accepts: filters to the operation's declared parameters, drops create-only
keys on update, stringifies numerics the spec types `string`, resolves
duct-insulation aliases to the vendor's quoted literals via
`resolveDuctInsulationVendorLiteral`, and refuses unresolved reference leaves
(`job.accountId`, `incentive.fromTemplateUuid`) rather than sending spoken
free text. Absent keys stay absent and explicit `null`s reach the wire as
`null` — the vendor leaves an absent field alone and clears a `null` one.
