# Angelic Angel Node.js compatibility CLI

Node.js 24 Active LTS / strict TypeScript port of the independent Rust CLI at
`sh1ma/Angelic-Angel@169a098e2025cc6e41a50fc8d521c483e21d9b6d`.
The service in this repository already uses Node.js; this package ports the
reference CLI, rather than rebuilding the Discord bot or dashboard.

## Build and use

Use the pinned runtime in `.node-version` (24.21.0) and npm 11.19.0.
The Windows 24.15.0 native crash investigation and the project-local verified
runtime launcher are described in `../../docs/angelic-angel/node-startup-diagnosis.md`.

```powershell
cd packages/angelic-angel
npm ci --ignore-scripts
npm run build
node dist/index.js --help
node dist/index.js -c angelic-angel.toml status
```

`init`, `register`, `listen`, `status`, `unregister`, `-c/--config` and
`-v/--verbose` are retained. The default config is `angelic-angel.toml` in the
current directory. `init --auth-token ... --ct0 ...` and interactive input are
both supported; interactive secrets are hidden. Command-line credentials may
still be visible to process inspection and shell history.

The legacy TOML schema is unchanged. A Node-written config can be read by Rust,
including optional registration and numeric byte arrays. Configuration saves
use an atomic replacement and retain a `.bak-<timestamp>-<uuid>` copy of the
previous file. These copies also contain secrets: protect and manage them with
the original configuration. POSIX new files use mode 0600; Windows filesystem
ACLs are inherited, so use a private directory. This is legacy CLI config
compatibility, not the encrypted server-side storage required by the new system.

`WEBHOOK_ENDPOINT` controls JSON POST delivery. Successful responses ACK 100,
decryption failures ACK 101 and delivery/configuration failures ACK 102. This
corrects Rust's non-2xx-as-success bug. Webhook redirects follow the original
reqwest policy (maximum ten redirects). HTTP requests have a 30-second timeout;
HTTP calls can also be canceled on Ctrl+C. No automatic Webhook retry was added
in Phase 0 because the original implementation does not have one.

```powershell
$env:WEBHOOK_ENDPOINT = 'https://your-configured-webhook.example/endpoint'
node dist/index.js -c angelic-angel.toml listen
```

The previous unauthenticated/default legacy behavior is intentionally restricted.
`register`, and automatic X re-registration after UAID invalidation, require
explicit authorization for that run through `ANGELIC_ANGEL_ALLOW_LEGACY_X=1`.
Do not enable it to test this migration: compatibility tests use only loopback
mock servers and synthetic credentials. This authorization does not turn the
old X private registration API into the new subscription-transfer mechanism.
The new production mechanism must never call that legacy module.

`listen` keeps the original 5s→300s exponential connection-failure backoff,
one-second reconnection after a completed HELLO and 30-minute delay for close
code 4774. Application `{}` pings, WebSocket control frames and TCP keepalive
are retained. The original last-100-version duplicate cache is intentionally
retained, including its cross-channel scope and pong-wait bypass; durable
subscription-scoped deduplication belongs to the separate new-system phase.

## Verification

```powershell
npm run verify:baseline
npm run build
npm run lint
npm run typecheck
# Build the development-only Rust comparison binaries first:
./compat-rust/build-oracle.ps1
npm test
npm audit --omit=dev
```

See `compat-rust/README.md` for portable Windows toolchain paths and Unix build
instructions. Rust is required only for development comparison tests; the built
JavaScript CLI does not invoke Rust or native Rust add-ons. `npm test` deliberately
fails if Rust comparison binaries are missing. Tests cover real loopback HTTP/WS,
trusted/untrusted loopback TLS, complete CLI lifecycle, recovery, signal cleanup,
TOML, protocol, and both ECE encodings with shared success/corruption fixtures.

The retained Rust source and license are immutable. `legacy-manifest.json` and
`verify:baseline` verify all fourteen original files; the generated test-only
oracle exposes private functions and redirects network paths to loopback.
The unmodified Rust CLI binary remains available for local golden comparisons.

Phase 0 evidence, explicit safety differences, acceptance status and the later
service integration plan are recorded under `../../docs/angelic-angel/`.
Live X/Mozilla delivery and macOS/Linux execution must be reported separately
from Windows local compatibility evidence.
