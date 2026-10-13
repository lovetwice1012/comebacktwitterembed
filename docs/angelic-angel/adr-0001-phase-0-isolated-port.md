# ADR 0001: Rust comparison baseline and an isolated TypeScript package

Date: 2026-10-13 JST. Status: accepted for Phase 0 implementation.

The inspected Git root is `comebacktwitterembed`, remote
`https://github.com/lovetwice1012/comebacktwitterembed.git`. It is an existing
Node.js Discord service with a Next.js dashboard, MariaDB, YAML workflow engine,
native monitoring services and server-managed notification entitlements.
The current task branch is `codex/angelic-angel-node-port`. Existing dirty Bot,
dashboard, billing and recovery work is preserved.

The specified Rust implementation is a separate public CLI/PoC, not the service
backend. Its pinned revision is `169a098e2025cc6e41a50fc8d521c483e21d9b6d`.
All original files, including Cargo.lock, both READMEs and MIT license, are
retained unchanged in `packages/angelic-angel/legacy-rust`. No nested Git checkout
is placed in the repository. Byte hashes are recorded independently and checked
before acceptance.

Decision: build the CLI in `packages/angelic-angel`, strict TypeScript ESM,
Node.js 24.15.0 (the inspected Active LTS major), npm with committed package lock.
Use Node crypto for ECDH, HKDF and AES-GCM, `ws` for WebSocket frame/TLS support,
and `smol-toml` for TOML. Both production dependencies are pinned. TOML integer
parsing uses BigInt internally to preserve Rust's integer/float distinction for
u8 arrays. Supplied strings/bytes are validated; parser diagnostics never expose
configuration contents. `ws` public socket access enables original TCP keepalive
and separate 16 MiB frame / 64 MiB message bounds. TLS verification remains on.
Node/OpenSSL and Rust/rustls use different trust-store implementations; this is
explicit, with trusted and untrusted local CA tests.

The test oracle compiles source derived directly from the retained files, appends
test access to private functions and redirects only test network endpoints to
loopback. It also compiles the original main.rs unchanged for CLI golden tests.
No production execution delegates to this oracle. Synthetic common fixtures,
independent published encryption vectors and Rust-generated fresh ciphertext
provide compatibility evidence beyond Node encrypt/decrypt self-roundtrips.

Safety differences are retained as named compatibility expectations: no secret
prefix/status/header/payload/HTTP-body logging; legacy X registration disabled
until explicit per-run authorization; UAID recovery is likewise gated; Webhook
non-2xx returns ACK102; bounded/cancelable HTTP; atomic config saves with backup;
Rust ECE panics become decryption errors; oversized advertised record sizes do
not cause advertised-size allocations. These changes preserve functionality
behind authorization and improve failure behavior. They are not described as
byte-identical output or unchanged unsafe behavior.

Production configuration and billing rows are not changed by Phase 0. New
Firefox transfer, persistent inbox, shared capacity pools and gateway leases are
separate work, permitted only after G0 succeeds. Public X/Mozilla network tests,
real credentials, notification delivery and production deployment need the
boundary specified by the implementation document.

Primary references inspected: [upstream source](https://github.com/sh1ma/Angelic-Angel),
[Node release policy](https://nodejs.org/en/about/previous-releases),
the retained Cargo.lock and exact `ece 2.3.1` source, the installed package lock,
and runtime source in this repository.
