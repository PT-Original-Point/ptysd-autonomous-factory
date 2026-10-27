# W2: Make quota reset timestamp parsing timezone deterministic

## Objective

The Antigravity quota parser currently passes zone-less date/time strings to `Date.parse`. JavaScript interprets those strings in the host's local timezone, so identical quota data can produce different reset instants on hosts in different timezones. A read-only reproduction with `2026-10-28T12:00:00` yields `12:00Z` under UTC and `04:00Z` under Asia/Taipei.

Make quota reset parsing deterministic without changing the live CLI's explicit-UTC output format.

## Exact edit scope

- `native-bridge/antigravity-quota.mjs`
- `tests/antigravity-quota.test.mjs`

Do not edit other paths.

## Required behavior

- Accept string timestamps only when they carry an explicit timezone designator: `Z` or a valid signed RFC 3339 offset (`+HH:MM` or `-HH:MM`).
- Reject date-only and local date/time strings without a timezone using the existing sanitized `INVALID_TIMESTAMP` error code.
- Continue normalizing valid explicit-offset strings to UTC ISO-8601, including fractional seconds.
- Preserve the existing absolute-instant behavior for numeric epoch-millisecond values and valid `Date` objects.
- Preserve rejection of invalid calendar dates and malformed timestamps. Do not include raw input values in errors or returned data.

## Acceptance

Add focused tests showing that zone-less date/time and date-only strings are rejected, valid `Z` and offset strings normalize to the same expected UTC instants, and numeric/`Date` inputs retain their existing behavior. Run `node --test tests/antigravity-quota.test.mjs` and report the exact result.

## Model-session boundary

This is a pre-production parser and unit-test task. The model may edit only the two scoped files through the existing Antigravity workspace file tools. It must not invoke shell or network tools, read credentials, change OS state, publish GitHub changes, or modify any file outside the exact edit scope. The native Worker and Codex controller own task dispatch, test execution, publication, CI review, and acceptance.