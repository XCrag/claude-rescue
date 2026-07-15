# Explicit API Anomaly-Only Detection Design

## Context

`claude-rescue` currently marks a live session as `slow` / “无响应” when its
session record has not updated for more than five minutes. That condition is
only an inactivity heuristic: normal idle sessions, long-running tools,
permission waits, and other legitimate waits can all satisfy it. Presenting
that signal as a definite anomaly can cause users to start unnecessary rescue
sessions or interrupt valid work.

The requested behavior is to report an anomaly only when the transcript
contains explicit evidence of an API retry or API error. Inactivity alone must
never create an anomaly.

## Goals

- Remove all time-based and process-liveness-based anomaly classification.
- Keep explicit API retry and API error detection.
- Treat anomaly state as current state, not permanent error history.
- Clear a prior retry or error after a newer successful assistant response.
- Keep terminal selection and unrelated behavior unchanged.
- Update tests and user-facing documentation to match the new semantics.

## Non-goals

- Detecting hangs, stalled tools, permission waits, or slow model responses.
- Adding new warning levels such as “inactive” or “possibly stuck.”
- Persisting anomaly history or adding telemetry.
- Changing rescue or terminal-launch behavior.

## Classification Model

The transcript tail remains the only anomaly evidence source. Classification
examines parsed records from newest to oldest and returns on the newest record
that provides a decisive API state:

1. A `system` record with subtype `api_error` means `retrying`.
2. An assistant record with `isApiErrorMessage === true` means `error`.
3. A newer assistant record that is not an API error means `ok`; it proves the
   conversation progressed after an earlier retry or error.
4. User messages, tool results, duration records, and other metadata are not
   decisive and do not clear or create an anomaly.
5. If no decisive record exists, the result is `ok`.

This newest-decisive-record rule preserves an explicit error while the session
only receives later user or tool metadata, but clears it once the assistant
successfully responds again.

## Code Changes

### Transcript classification

Refactor `detectAbnormalUncached` to evaluate decisive records in reverse
chronological order. Its possible results become:

- `{ kind: 'ok', reason: null }`
- `{ kind: 'retrying', reason: ... }`
- `{ kind: 'error', reason: ... }`

The existing retry and error reason formatting remains unchanged.

### Session annotation

Remove `SLOW_MS` and the `alive + updatedAt` timeout branch from
`annotateSessions`. Annotation simply applies the transcript classifier result.
`alive` and `updatedAt` remain available for display and sorting but no longer
affect anomaly state.

Remove the `slow` branch from `abnormalLabel` and update nearby comments to list
only `ok`, `retrying`, and `error`.

### Documentation

Update user-facing documentation and package metadata that claim the tool
detects stuck or unresponsive sessions. The revised wording will state that it
flags explicit API retries and errors. Remove `slow` / “无响应” from anomaly
tables, filtering examples, and JSON field descriptions.

## Tests

Add Node built-in test coverage using real temporary transcript and session
files:

1. A live session with a very old `updatedAt` and no API evidence remains `ok`.
2. A latest `system/api_error` record is `retrying` with its reason.
3. A latest assistant API error message is `error` with its reason.
4. A newer normal assistant response clears an earlier API error.
5. A newer normal assistant response clears an earlier API retry.
6. Existing terminal-selection tests continue to pass.

The first test must fail against the current implementation before production
code changes are made, proving that it captures the reported false positive.

## Success Criteria

- No session is marked abnormal solely because it is alive and inactive.
- Only explicit current API retry or error evidence produces `abnormal: true`.
- A newer successful assistant response restores `abnormalKind: 'ok'`.
- No runtime output or documentation advertises `slow` / “无响应” detection.
- The complete Node test suite passes with no failures.
