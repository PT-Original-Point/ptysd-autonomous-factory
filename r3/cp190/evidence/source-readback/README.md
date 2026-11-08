# Exact source readback

Read-only GitHub connector readback on 2026-09-25. Repository: PT-Original-Point/ptysd-vnext42-governance-sandbox (id 1352411536).

| Artifact | Ref / commit | Git blob OID | Raw SHA-256 |
|---|---|---|---|
| Directory descriptor | governance/project-directory @ f22a9eb9e75d6b2d89dc9b950109910af8d290bb | 468232e79905774296db9136a592858a06347bbc | 4d433c6a0d896bec6fe0369ba091eb37ae00388cf47acb6ea235cced59a484d0 |
| Governance project record | governance/project-directory @ f22a9eb9e75d6b2d89dc9b950109910af8d290bb | e08c5ff80183d6b09a8959826e536ad0a589bd96 | fc0c2b4c45003e6c159880e7ee8e5dd0917cbb637fcc6aff94392f97c56ac0f9 |
| Current control pointer (CP190) | v45/factory-control @ 209e0ad9040a08965a49109e18f783cfd9c7c7f4 | d0ef84c709d63e92ce723716152d19e321bbbda3 | bdfbc691b7a5fbca52e10a4c688b9b455356ac8b268a86b099b21c265a18a4d3 |
| CP190 raw checkpoint | v45/factory-control @ 209e0ad9040a08965a49109e18f783cfd9c7c7f4 | 8991abd3e19757698b393ccd4b09fcad5f230651 | 2591b20875405c4711397dff8b31d9d13ab77f10452c43d239ea567d40cdff8a |
| Current control pointer (CP191 candidate) | PR297 head 137518035f9c3c7f89176b20b12b9db548d3f79c | a3f1fa8c631491de4d1e86e480990cc5e5e90f01 | 1c93a3e57b1635ec622208cd463d801c5b56876216356409614c34097b0ff294 |
| CP191 checkpoint candidate | PR297 head 137518035f9c3c7f89176b20b12b9db548d3f79c | 0180e5eb9c65342675f4e4dd743c5a1a04430da1 | ecc7865c8c1c6679c6e774722fb1c368a332975e9f568fbc18a799880b17ecee |
| Strict schema validator source | v45/factory-control @ 209e0ad9040a08965a49109e18f783cfd9c7c7f4 | c58ec22fc4f44dd5892da74aa39db247d62796b2 | b6457a1ed187164f7cb4503655d0962725b2c7ec458b3767e7efaf78214ef5b2 |

The exact current Directory project is schema v1, revision 4, and has no active_run_ref or active_run_id. The CP190 exact-source resolver test therefore first records ACTIVE_RUN_REF_MISSING; a second test supplies an explicitly local v2 candidate overlay while reading the same pinned Directory descriptor/project, CP190 control pointer, and CP190 raw bytes. That successful route is LOCAL_NONCANONICAL and does not claim persisted Directory state.
