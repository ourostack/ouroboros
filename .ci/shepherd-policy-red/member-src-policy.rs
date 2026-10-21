use std::io;
use std::path::Path;

use codex_core::config::Config;

// Isolated behavioral RED candidate only. No capability or startup entrypoint exists.
pub fn check_derived_policy(_config: &Config, _cwd: &Path, _store_id: &str) -> io::Result<()> {
    Ok(())
}
