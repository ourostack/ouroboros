use std::io;

use codex_app_server_protocol::DynamicToolCallResponse;
use codex_app_server_protocol::RequestId;
use codex_app_server_protocol::ThreadBackgroundTerminalsListParams;
use codex_app_server_protocol::TurnStartParams;
use uuid::Uuid;

pub const MAX_FRAME_BYTES: usize = 2 * 1024 * 1024;

#[derive(Debug)]
pub enum Inbound {
    Initialize { id: RequestId, boot_nonce: Uuid, profile_digest: String },
    Turn { id: RequestId, params: TurnStartParams },
    ShellPage { id: RequestId, params: ThreadBackgroundTerminalsListParams },
    ToolResult { id: RequestId, result: DynamicToolCallResponse, result_nonce: Uuid },
}

#[derive(Default)]
pub struct WireDecoder;

impl WireDecoder {
    pub fn new() -> Self {
        Self
    }

    pub fn append(&mut self, _bytes: &[u8]) -> io::Result<Vec<Inbound>> {
        Err(io::Error::new(io::ErrorKind::Unsupported, "strict wire decoder not implemented"))
    }

    pub fn finish(&mut self) -> io::Result<()> {
        Err(io::Error::new(io::ErrorKind::Unsupported, "strict wire decoder not implemented"))
    }
}
