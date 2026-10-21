use std::io;

use codex_app_server_protocol::ThreadStartParams;
use codex_app_server_protocol::TurnStartParams;
use codex_protocol::dynamic_tools::DynamicToolSpec;
use serde_json::Value;

pub fn describe_profile() -> io::Result<Value> {
    Err(io::Error::new(io::ErrorKind::Unsupported, "static descriptor not implemented"))
}

pub(crate) fn native_tool() -> io::Result<DynamicToolSpec> {
    Err(io::Error::new(io::ErrorKind::Unsupported, "native tool not implemented"))
}

pub(crate) fn fixed_thread_params() -> io::Result<ThreadStartParams> {
    Err(io::Error::new(io::ErrorKind::Unsupported, "fixed thread options not implemented"))
}

pub(crate) fn fixed_turn_params(_thread_id: String, _text: String) -> io::Result<TurnStartParams> {
    Err(io::Error::new(io::ErrorKind::Unsupported, "fixed turn options not implemented"))
}
