# CP190 legacy checkpoint compatibility profile

Status: `LOCAL_NONCANONICAL_CANDIDATE`. This profile is an explicit, versioned exception for one immutable historical checkpoint. It does not edit CP190, widen the current schema, publish a Directory record, or grant dispatch authority.

## Qualified source identity

`CSG_CHECKPOINT_V1_LEGACY_AUTHORIZATION_MODE_PROFILE` version 1 applies only to repository `1352411536`, ref `refs/heads/v45/factory-control`, commit `209e0ad9040a08965a49109e18f783cfd9c7c7f4`, path `governance/csg/checkpoints/000190.json`, Git blob `8991abd3e19757698b393ccd4b09fcad5f230651`, and raw UTF-8 SHA-256 `2591b20875405c4711397dff8b31d9d13ab77f10452c43d239ea567d40cdff8a`. The profile also pins project ID, sequence 190, transition ID, pointer payload digest, and the canonical digest of the full legacy field object.

The exact allowed top-level `authorization_mode` shape and values are embedded in `profiles/csg-checkpoint-v1-legacy-authorization-mode.profile.json`. That object has exact keys `mode`, `envelope_ref`, `do_not_reask_for`, `human_reserved`, `barrier`, `recorded_at`, and `evidence_refs`; the nested values and every evidence reference are pinned by its canonical digest. A changed key, value, array member, evidence ref, or byte fails closed.

## Resolution rules

- CP190 is accepted only when the source read supplies the exact repository, control ref, immutable control commit, checkpoint path, raw SHA-256, computed Git blob OID, pointer identity, and checkpoint identity above.
- The existing `csg.checkpoint.v1` key set is unchanged. Checkpoints without the legacy field use the exact current key set and current payload-digest validation.
- Unknown checkpoint keys remain rejected. A checkpoint at any other commit, path, blob, sequence, transition, or digest cannot use this profile.
- New checkpoints continue through the strict current schema. Adding `authorization_mode` to CP191 fails.
- Duplicate JSON keys and malformed JSON fail before schema evaluation.
- The resolver remains read-only and grants no permit.

## Exact Directory result

The exact current Directory commit is `f22a9eb9e75d6b2d89dc9b950109910af8d290bb`; its project record is `csg.project.v1`, revision 4, and has no `active_run_ref`. Using only that persisted record, fresh-session active-run resolution fails closed with `ACTIVE_RUN_REF_MISSING`.

A separate test supplies a versioned local v2 project overlay derived from that exact source record. It then reads the exact control pointer and CP190 bytes from commit `209e0ad9040a08965a49109e18f783cfd9c7c7f4`. The resolver returns `LOCAL_NONCANONICAL_DIRECTORY_OVERLAY_RESOLUTION`, sequence 190, profile name above, and `dispatch_authority=false`. No synthetic checkpoint, pointer, or commit is used in this test. The local overlay is not current persisted Directory state.

## Test result

`node --test tests/active-run-ref.test.mjs` completed with 18 passed and 0 failed. The suite covers exact CP190 profile resolution, arbitrary top-level extras, exact CP191 strict-schema acceptance, rejection of the legacy field on a newer checkpoint, wrong historical revision, changed checkpoint bytes/blob, duplicate and malformed JSON, and existing Directory/ref movement and identity checks.
