//! Adds test access to private helpers without editing the retained Rust source.
use std::{env, fs, path::PathBuf};

fn main() {
    if env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("windows") {
        // Vendored OpenSSL omits its compilation PDB from the static library.
        // Suppress only missing-debug-symbol LNK4099; program code is unchanged.
        println!("cargo:rustc-link-arg=/IGNORE:4099");
    }
    let source =
        PathBuf::from(env::var_os("CARGO_MANIFEST_DIR").unwrap()).join("../legacy-rust/src");
    let out = PathBuf::from(env::var_os("OUT_DIR").unwrap());
    for name in [
        "autopush", "cli", "config", "error", "listener", "push", "twitter",
    ] {
        let path = source.join(format!("{name}.rs"));
        println!("cargo:rerun-if-changed={}", path.display());
        let mut content = fs::read_to_string(&path).unwrap();
        // Only the test oracle is redirected. The baseline binary below is
        // compiled directly from original main.rs with no endpoint overrides.
        if name == "autopush" {
            content = content.replace(
                "connect_ws(AUTOPUSH_WS_URL)",
                "connect_ws(&oracle_endpoint())",
            );
            for (constant, variable) in [
                ("PING_INTERVAL_SECS", "ANGELIC_ORACLE_APP_PING_MS"),
                ("PONG_TIMEOUT_SECS", "ANGELIC_ORACLE_REQUEST_TIMEOUT_MS"),
                ("WS_PING_INTERVAL_SECS", "ANGELIC_ORACLE_WS_PING_MS"),
            ] {
                content = content.replace(
                    &format!("Duration::from_secs({constant})"),
                    &format!("oracle_duration({constant}, \"{variable}\")"),
                );
            }
        }
        if name == "twitter" {
            content = content.replace("TWITTER_API_BASE);", "oracle_twitter_endpoint());");
            content.push_str("\nfn oracle_twitter_endpoint() -> String { std::env::var(\"ANGELIC_ORACLE_TWITTER_URL\").expect(\"mock Twitter endpoint required\") }\n");
        }
        let adapter = match name {
            "autopush" => include_str!("adapters/autopush.rs"),
            "listener" => include_str!("adapters/listener.rs"),
            _ => "",
        };
        content.push_str("\n// Test access only; original algorithms above are preserved.\n");
        content.push_str(adapter);
        fs::write(out.join(format!("{name}.rs")), content).unwrap();
    }
    println!("cargo:rerun-if-changed=adapters/autopush.rs");
    println!("cargo:rerun-if-changed=adapters/listener.rs");
}
