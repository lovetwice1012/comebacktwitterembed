use clap::{Parser, Subcommand};
use std::path::PathBuf;

#[derive(Parser)]
#[command(name = "angelic-angel")]
#[command(
    about = "Twitter Web Push Receiver",
    long_about = "A server for receiving tweet notifications by emulating browser Web Push."
)]
pub struct Cli {
    /// Configuration file path
    #[arg(short, long, default_value = "angelic-angel.toml")]
    pub config: PathBuf,

    /// Enable verbose output (debug logs)
    #[arg(short, long)]
    pub verbose: bool,

    #[command(subcommand)]
    pub command: Commands,
}

#[derive(Subcommand)]
pub enum Commands {
    /// Initialize config file (interactive if no arguments given)
    Init {
        /// Twitter auth_token
        #[arg(long)]
        auth_token: Option<String>,
        /// Twitter ct0 (CSRF token)
        #[arg(long)]
        ct0: Option<String>,
    },
    /// Register AutoPush subscription and Twitter Push endpoint
    Register,
    /// Start listening for push notifications
    Listen,
    /// Show current config and registration status
    Status,
    /// Unregister AutoPush subscription
    Unregister,
}
