# Retained-source compatibility oracle

This development-only crate builds two binaries. `angelic-angel-rust-baseline`
compiles `../legacy-rust/src/main.rs` directly and retains its original CLI.
`angelic-angel-rust-oracle` compiles generated copies of the same seven library
modules and exposes private helpers through JSON lines on standard input.
The shipped Node CLI has no dependency on either binary.

The oracle has three explicit test adaptations: narrow public wrappers appended
within each module, loopback AutoPush/Twitter endpoint injection, and optional
millisecond ping/request timers. The original algorithms and original baseline
files stay intact. Network oracle operations require loopback endpoints and
never connect to X or Mozilla AutoPush. The original CLI baseline is used only
for help, local configuration, status, and input errors in the test harness.

`Cargo.lock` starts from the retained baseline lockfile. The crate name changes
and the vendored OpenSSL source package is added; the resolved original
dependencies, including `ece 2.3.1`, remain pinned. OpenSSL vendoring makes the
same ECE backend available without a system OpenSSL SDK.

On Linux/macOS with Cargo, a C compiler and Perl installed:

```sh
cargo build --manifest-path compat-rust/Cargo.toml --locked
npm run test:compat
```

On Windows, run `build-oracle.ps1` from PowerShell with Rust, Visual Studio C++
build tools and native Strawberry Perl. Git's MSYS Perl is insufficient for
vendored OpenSSL. Paths can be supplied without installing a global toolchain:

```powershell
./compat-rust/build-oracle.ps1 -RustupDirectory "$env:TEMP/angelic-angel-toolchain/rustup" -CargoDirectory "$env:TEMP/angelic-angel-toolchain/cargo" -PerlBinaryDirectory "$env:TEMP/angelic-angel-toolchain/perl/perl/bin"
npm run test:compat
```

`ANGELIC_RUST_ORACLE` and `ANGELIC_RUST_BASELINE` can point tests to alternative
build locations. Missing Rust binaries fail the compatibility suite; the tests
do not turn absent comparison evidence into skipped passes.

All fixtures contain synthetic values. Rust's historical secret prefix status
display, raw logging, non-2xx delivery ACK and ECE debug underflow are recorded
as explicit safety deltas rather than copied into the Node CLI.
