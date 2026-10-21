use std::io;
use std::sync::Arc;

use codex_app_server::in_process::FrozenInProcessHandle;
use codex_app_server::in_process::FrozenNativeToolResponse;
use codex_app_server::in_process::FrozenSender;
use codex_app_server::in_process::InProcessServerEvent;
use codex_app_server_protocol::ClientRequest;
use codex_app_server_protocol::ThreadStartResponse;
use serde_json::Value;
use tokio::io::AsyncRead;
use tokio::io::AsyncWrite;

use crate::capture::ValidatedConfig;

pub async fn serve<R: AsyncRead + Unpin, W: AsyncWrite + Unpin>(
    input: R,
    output: W,
    validated: ValidatedConfig,
) -> io::Result<()> {
    serve_with_factory(input, output, NativeFactory(validated), Limits::default()).await
}

#[derive(Clone)]
struct Limits {
    work_queue: usize,
    control_queue: usize,
    output_queue: usize,
    retained_payload_bytes: usize,
    #[cfg(test)]
    probe: Option<Arc<BridgeProbe>>,
}

impl Default for Limits {
    fn default() -> Self {
        Self {
            work_queue: 16,
            control_queue: 16,
            output_queue: 16,
            retained_payload_bytes: 16 * 1024 * 1024,
            #[cfg(test)]
            probe: None,
        }
    }
}

#[cfg(test)]
#[derive(Default)]
struct BridgeProbe {
    retained_controls: std::sync::atomic::AtomicUsize,
    changed: tokio::sync::Notify,
}

trait BackendSender: Clone {
    async fn ready(&self) -> io::Result<Arc<ThreadStartResponse>>;
    async fn request(&self, request: ClientRequest) -> io::Result<Value>;
    async fn control(&self, response: FrozenNativeToolResponse) -> io::Result<()>;
    async fn terminal(&self) -> io::Result<()>;
}

trait Backend {
    type Sender: BackendSender;
    fn sender(&self) -> Self::Sender;
    async fn next_event(&mut self) -> io::Result<InProcessServerEvent>;
    async fn shutdown(self) -> io::Result<()>;
}

trait BackendFactory {
    type Backend: Backend;
    fn descriptor(&self) -> io::Result<Value>;
    async fn start(self) -> io::Result<Self::Backend>;
}

async fn serve_with_factory<R: AsyncRead + Unpin, W: AsyncWrite + Unpin, F: BackendFactory>(
    _input: R,
    _output: W,
    _factory: F,
    _limits: Limits,
) -> io::Result<()> {
    Err(not_implemented())
}

fn not_implemented() -> io::Error {
    io::Error::new(io::ErrorKind::Unsupported, "CMUX_PRIVATE_BRIDGE_NOT_IMPLEMENTED")
}

struct NativeFactory(ValidatedConfig);

impl BackendFactory for NativeFactory {
    type Backend = NativeBackend;

    fn descriptor(&self) -> io::Result<Value> {
        self.0.descriptor()
    }

    async fn start(self) -> io::Result<NativeBackend> {
        Err(not_implemented())
    }
}

struct NativeBackend {
    owner: FrozenInProcessHandle,
}

#[derive(Clone)]
struct NativeSender(FrozenSender);

impl BackendSender for NativeSender {
    async fn ready(&self) -> io::Result<Arc<ThreadStartResponse>> {
        self.0.wait_ready().await
    }

    async fn request(&self, request: ClientRequest) -> io::Result<Value> {
        self.0.request(request).await?.map_err(|error| io::Error::other(error.message))
    }

    async fn control(&self, response: FrozenNativeToolResponse) -> io::Result<()> {
        self.0.respond_to_server_request(response).await
    }

    async fn terminal(&self) -> io::Result<()> {
        Err(not_implemented())
    }
}

impl Backend for NativeBackend {
    type Sender = NativeSender;

    fn sender(&self) -> NativeSender {
        NativeSender(self.owner.sender())
    }

    async fn next_event(&mut self) -> io::Result<InProcessServerEvent> {
        self.owner.next_event().await
    }

    async fn shutdown(self) -> io::Result<()> {
        self.owner.shutdown().await
    }
}

#[cfg(test)]
#[path = "bridge_tests.rs"]
mod tests;
