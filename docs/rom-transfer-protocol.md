# ROM Transfer Protocol (`rom-transfer-v1`)

Status: implemented upload contract. This document describes the wire behavior
shared by `sc-web` and `sc-server`; it is not a proposal.

## Scope and versioning

ROM transfer uses a dedicated, reliable, ordered WebRTC DataChannel. The channel
label is the protocol version:

```text
rom-transfer-v1
```

A host MUST close channels with any other label. Changing message shapes,
framing, ordering, or state semantics requires a new label. ROM bytes never use
the gameplay/diagnostics channel.

Version 1 implements single-file **upload**. Download, bundles, checkpoints, and
resume are outside this version.

## Actors and trust boundaries

- **Browser:** an authenticated Sprite Cloud administrator.
- **sc-web:** authorizes the operation and relays SDP; ROM bytes do not pass
  through it.
- **sc-server:** receives bytes, stages the file beneath an operator-configured
  ROM root, verifies it, and atomically publishes it.
- **TURN/STUN:** transports encrypted WebRTC packets but is not trusted with
  plaintext ROM contents.

The browser, every network message, filenames, SDP, and control metadata are
untrusted. Filesystem paths supplied by a browser are never accepted.

## Authorization and capability lifecycle

1. An authenticated user with `admin` membership on the selected server sends
   `POST /api/servers/{server_id}/rom-transfers` with a basename, positive
   declared size, and optional allowlisted platform hint. CSRF and rate limits
   apply.
2. sc-web creates a random 32-byte secret and returns its 64-character hex
   representation exactly once. Only `SHA-256(secret)` is persisted in the
   command payload.
3. The capability expires five minutes after issuance. Before expiry, the
   browser supplies it to the SDP-offer endpoint. Constant-time hash comparison
   activates exactly one command from `preparing` to `pending`; the same offer
   cannot activate that command again.
4. The first and only accepted DataChannel's first text frame MUST redeem the same capability again.
   sc-server compares SHA-256 hashes in constant time.
5. Invalid, empty, oversized, repeated, or out-of-state authentication fails
   closed. The staged file is cancelled and the protocol enters `Done`.

The secret MUST NOT appear in logs, URLs, telemetry, or server results. Possession
of the secret authorizes only the already-bound server, basename, declared size,
operation, platform hint, and transfer command. It does not grant arbitrary
filesystem access.

| Capability invariant | Binding |
|---|---|
| Nonce | Random UUID `transfer_id` |
| Server | Command row `serverId` and signaling route |
| User | `authorized_user_id` captured from the authenticated admin session |
| Operation | Immutable `upload` value |
| Object | Validated basename plus optional allowlisted platform hint |
| Maximum bytes | Positive `declared_size`, capped at 2 GiB |
| Expiry | Five-minute `expires_at` checked before command activation |
| Secret storage | SHA-256 token hash only; plaintext returned once |

## Signaling sequence

```text
Browser                         sc-web                         sc-server
   | POST /rom-transfers           |                                |
   |------------------------------>| authorize admin; issue secret  |
   |<-- transfer_id, secret --------| queue command: preparing       |
   | create ordered v1 DC          |                                |
   | POST SDP offer + secret       |                                |
   |------------------------------>| verify capability + expiry     |
   |                               | command: pending -------------->|
   |                               |<-------------- SDP answer ------|
   | poll command result           |                                |
   |<-------------- SDP answer ----|                                |
   | set remote description        |                                |
   |================ encrypted WebRTC DataChannel ==================>|
```

## Frame discrimination

WebRTC's frame type is authoritative:

- **Text frame:** UTF-8 JSON control message, at most 8 KiB.
- **Binary frame:** ROM bytes, from 1 byte through 16 KiB inclusive.

Receivers MUST NOT guess the frame type from payload contents. In particular, a
binary ROM chunk that happens to contain valid JSON remains binary data.
Unknown fields and unknown commands are rejected rather than ignored.

## State machine

```text
AwaitingAuth -- valid auth --> Receiving -- transfer_complete --> Committing
     |                            |     |                              |
     +-- any invalid frame -------+     +-- cancel/invalid frame ------+
                                  |                                    |
                                  +----------- error ------------------+
                                                                       v
                                                                      Done
```

All frame handling for one transfer is serialized. Legal client controls are:

| State | Legal text control |
|---|---|
| `AwaitingAuth` | `auth` only |
| `Receiving` | `transfer_complete` or `cancel` |
| `Committing` | none |
| `Done` | none |

A binary frame is legal only in `Receiving`. Illegal transitions fail closed,
cancel staging, send the state-appropriate error when possible, and enter
`Done`. Frames received after `Done` have no effect.

## Control messages

Every JSON object has exactly the documented fields and a string `cmd`.

### Browser to host

Authenticate (first frame):

```json
{"cmd":"auth","capability_secret":"<64 hex characters>"}
```

The parser permits at most 512 UTF-8 bytes for the capability field; issued
secrets are 64 ASCII characters.

Complete upload:

```json
{"cmd":"transfer_complete"}
```

Optional client assertions are supported:

```json
{
  "cmd":"transfer_complete",
  "expected_size":1234,
  "expected_hash":"<64-character lowercase SHA-256 hex digest>"
}
```

The server always enforces the size authorized by sc-web. A client-provided size
must match that authorized value when present and cannot enlarge that authority.
If an expected hash is supplied, commit fails unless it is lowercase hexadecimal
and matches the computed SHA-256 digest.

Cancel:

```json
{"cmd":"cancel"}
```

### Host to browser

```json
{"cmd":"auth_ok"}
{"cmd":"auth_error","reason":"invalid capability"}
{"cmd":"transfer_ok","hash":"<sha256>","size":1234,"game_id":null}
{"cmd":"transfer_error","reason":"size mismatch"}
```

Browser validation requires:

- exact known fields and command names;
- non-empty error reasons no larger than 1 KiB;
- a 64-character lowercase hexadecimal SHA-256 on success;
- a non-negative safe-integer size;
- an absent, null, or bounded non-empty `game_id`.

Malformed or oversized host controls terminate the browser operation as an
error.

## Binary chunks, ordering, and backpressure

- The DataChannel is reliable and ordered.
- Offsets are **implicit**: each accepted chunk starts at the cumulative number
  of bytes already written. Version 1 has no client-selected offset field.
- The browser sends at most `min(16 KiB, negotiated SCTP maxMessageSize)` per
  message. The 16 KiB ceiling is required for interoperability with WebRTC
  stacks that do not support SCTP message interleaving reliably.
- The host rejects empty chunks and chunks larger than 16 KiB.
- The browser pauses while `bufferedAmount` exceeds two effective chunks.
- The host serializes frames and rejects cumulative bytes above the size
  authorized by sc-web.
- The upload limit is 2 GiB. Filename limits and extension allowlists are
  independently enforced by sc-web and sc-server.

The 16 KiB limit is enforced by both sender and receiver. A future protocol may
negotiate a different application ceiling only after cross-stack testing.

## Storage and completion

1. sc-server selects a writable configured ROM root.
2. It validates a basename only: empty names, separators, NULs, overlong names,
   and unsupported extensions are rejected.
3. Bytes are written to a randomized sibling `.partial` file.
4. SHA-256 and byte count are computed while streaming.
5. `transfer_complete` commits only when the authorized size and optional hash
   match.
6. Commit atomically renames the staged file and refuses to overwrite an
   existing ROM.
7. The local catalog is rescanned and synchronized before `transfer_ok` is
   emitted.

Cancellation, transport closure, parser failure, size overflow, and write error
cancel the active staged upload. `StagedUpload` also deletes its partial file on
drop; expired crash artifacts are cleaned up on the next transfer attempt.

## Failure behavior

| Failure | Required result |
|---|---|
| Wrong/expired capability during signaling | HTTP rejection; command not activated |
| Wrong capability on DataChannel | `auth_error`, cancel staging, `Done` |
| Unknown/oversized/malformed control | state-appropriate error, cancel, `Done` |
| Text/binary frame in illegal state | error, cancel, `Done` |
| Empty or >16 KiB binary chunk | `transfer_error`, cancel, `Done` |
| Cumulative bytes exceed authorized size | `transfer_error`, cancel, `Done` |
| Size/hash mismatch | no final rename; `transfer_error` |
| Destination already exists | no overwrite; `transfer_error` |
| DataChannel closes before completion | cancel partial upload and close peer connection |
| Catalog refresh fails after file commit | `transfer_error`; never report false success |

Errors exposed to clients must not include secrets. Operational logs may include
transfer IDs, sizes, and sanitized basenames, but never capability plaintext or
private ICE credentials.

## Reconnect, checkpoints, and resume

Version 1 deliberately does **not** resume:

- no checkpoint or acknowledgement messages exist;
- no explicit random-access offsets exist;
- a disconnected session cancels its staged upload;
- retry requires a new transfer authorization and starts at byte zero;
- a completed destination is never overwritten by retry.

A future resumable protocol must use a new versioned label and define durable
staging identity, authenticated offset acknowledgements, hash continuation,
expiry extension, replay handling, and cleanup. Adding an ad-hoc `resume`
message to v1 is forbidden.

## Conformance fixtures

`protocol/fixtures/rom-transfer-v1.json` is the shared browser/Rust fixture set.
Both implementations must consume it in tests. It covers the channel version,
valid controls, malformed/unknown controls, extra fields, invalid hashes and
sizes, and illegal state transitions. Changes to the fixtures and this document
must be reviewed as wire-contract changes.

## Threat model summary

Defenses provided by v1:

- server-admin authorization, CSRF protection, and endpoint rate limiting;
- short-lived, high-entropy, hash-at-rest capabilities;
- constant-time capability comparisons;
- operation/server/filename/size constraints fixed before WebRTC starts;
- dedicated encrypted channel separated from gameplay;
- strict bounded parsers and serialized state transitions;
- bounded chunks, cumulative-size enforcement, and backpressure;
- basename-only input, extension allowlist, configured-root containment;
- staged writes, no-overwrite atomic commit, digest/size verification;
- cancellation and partial-file cleanup on failures.

Not solved by v1:

- malware detection or proof that uploaded content is a legitimate ROM;
- resumable interrupted transfers;
- end-to-end content encryption independent of WebRTC;
- a malicious administrator intentionally uploading allowed content;
- multi-file transactional bundles.

Those concerns belong to later backlog items and must not weaken this contract.
