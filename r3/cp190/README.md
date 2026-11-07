# R3 P0: Directory active run reference candidate

Status: `LOCAL_NONCANONICAL_CANDIDATE`

This is a read-only contract and resolver rehearsal. It does not write the Project Directory, canonical control, Mission, Production, PR297/298/299, or a remote branch. It grants no dispatch authority.

## Fresh baseline

- Repository: `PT-Original-Point/ptysd-vnext42-governance-sandbox` (repo id `1352411536`).
- Project Directory ref: `refs/heads/governance/project-directory` at `f22a9eb9e75d6b2d89dc9b950109910af8d290bb`.
- Canonical control ref: `refs/heads/v45/factory-control` at `209e0ad9040a08965a49109e18f783cfd9c7c7f4`.
- The Directory descriptor is `csg.directory-root.v1`, descriptor version 2, exact alias-hash lookup, `SINGLE_WRITER_GUARDED_CAS_NO_DUAL_WRITE`; legacy Postgres is read-only after cutover.
- The governance project record is `csg.project.v1`, Directory revision 4, binding generation 2, runtime `GITHUB_ACTIONS_BOUNDED`. It has neither `active_run_id` nor `active_run_ref`.
- The v45 project schema and validator accept only `csg.project.v1` and an exact key set. The current v1 Directory record matches that shape.
- The current control is `csg.pointer.v1`, checkpoint sequence 190, path `governance/csg/checkpoints/000190.json`, payload digest `sha256:7925c06ea87b9cd98cdd8b45fb8fe0766a99abd6cb520a76890749afce02dd2e`.
- Checkpoint 190 contains the canonical `run_ref`, task `GOV-HARDENING-P5`, attempt `GOV-HARDENING-P5-ATTEMPT-067`, epoch 67, and an empty `unresolved_effect_refs` array. These values were read from the pinned control commit; the candidate does not copy a run id into Directory.
- The raw checkpoint also contains the historical top-level `authorization_mode` key. It is accepted only by the versioned `CSG_CHECKPOINT_V1_LEGACY_AUTHORIZATION_MODE_PROFILE`, pinned to CP190's exact ref, commit, path, Git blob OID, raw SHA-256, sequence, transition, payload digest, and authorization-mode canonical digest. The current checkpoint key set remains strict; every other checkpoint, unknown field, or changed CP190 byte fails closed. See `CP190-LEGACY-COMPATIBILITY.md` and the embedded source readback.

Exact current Directory, control, checkpoint, and schema-validator reads are retained under `evidence/source-readback/`; Git blob OIDs and raw SHA-256 values are recorded there. `evidence/reader-writer-inventory.json` records the earlier source scan. The external Directory adapter inventory remains unresolved. This candidate does not claim canonical acceptance or a complete Host reader inventory.

## Contract

The proposed v2 Directory record keeps every v1 field and adds required `active_run_ref`, which may be `null` when there is no resolvable active run. The nested reference is `csg.active-run-ref.v1`; it contains project/binding identity, the Directory revision, a fixed resolution mode, and the exact canonical control locator. It contains no `run_id` or `active_run_id` field.

The resolver accepts current v1 records for ordinary Directory lookup. An active-run request against v1 fails with `ACTIVE_RUN_REF_MISSING`; it never falls back to legacy ids or synthesizes one. Unknown project schema versions, reference versions, locator shapes, pointer schemas, and checkpoint schemas fail closed.

Resolution reads the Directory descriptor and project record at one Directory commit, follows `active_run_ref` to the descriptor-matched control locator, pins the control and checkpoint reads to one immutable control commit, verifies the pointer/checkpoint sequence and canonical payload digest, then rereads both branch refs. Any movement fails closed. On a schema-valid checkpoint, the result returns its run reference, task/attempt identity, active jobs, and unresolved effect references. It is labeled read-only and never constitutes a permit or dispatch decision.

## Compatibility and rollout boundary

This candidate reader supports legacy v1 Directory records and the proposed v2 shape. Existing v1-only CSG readers fail closed on v2, so a real Directory writer must not publish v2 until every active reader/writer has an exact tested compatibility route and the guarded single-writer CAS procedure is authorized. The external Directory adapter inventory is unresolved. This candidate does not change that state or claim canonical acceptance.

## Local checks

Run from this directory:

```powershell
node --test tests/active-run-ref.test.mjs
```

Recorded rehearsal result: 18 passed, 0 failed. The exact live Directory v1 bytes still fail active-run resolution with `ACTIVE_RUN_REF_MISSING`, because that record has no `active_run_ref`. A separately labeled local v2 overlay resolves read-only through the exact current control and exact CP190 bytes using the pinned legacy profile. That overlay is not persisted Directory state and carries no dispatch authority. The original `LOCAL_SYNTHETIC` unit test remains separate from the exact-source readback test.
