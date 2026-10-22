use std::collections::{HashMap, HashSet, VecDeque};
use std::future::{Future, pending};
use std::io;
use std::pin::Pin;
use std::sync::{Arc, Mutex, MutexGuard};
use std::task::{Context, Poll};

use codex_app_server::in_process::{
    FrozenInProcessHandle, FrozenNativeToolResponse, FrozenSender, InProcessServerEvent,
};
use codex_app_server_protocol::{
    ClientRequest, DynamicToolCallResponse, RequestId, ServerRequest, ThreadStartResponse,
    TurnStartResponse,
};
use serde_json::{Value, json};
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};
use tokio::sync::mpsc;

use crate::capture::ValidatedConfig;
use crate::wire::{Inbound, MAX_FRAME_BYTES, WireDecoder};

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
    retained_roots: std::sync::atomic::AtomicUsize,
    root_changed: tokio::sync::Notify,
    published_echoes: std::sync::atomic::AtomicUsize,
    echo_changed: tokio::sync::Notify,
    published_terminals: std::sync::atomic::AtomicUsize,
    terminal_changed: tokio::sync::Notify,
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

fn invalid(message: &'static str) -> io::Error {
    io::Error::new(io::ErrorKind::InvalidData, message)
}

fn closed(message: &'static str) -> io::Error {
    io::Error::new(io::ErrorKind::BrokenPipe, message)
}

fn identifier(value: &Value) -> io::Result<String> {
    value.as_str().filter(|text| !text.is_empty() && text.len() <= 128)
        .map(str::to_owned).ok_or_else(|| invalid("invalid bridge identity"))
}

fn id_key(id: &RequestId) -> io::Result<String> {
    match id {
        RequestId::Integer(-1 | -2) => return Err(invalid("reserved bridge request ID")),
        RequestId::String(text) if text.is_empty() || text.len() > 128 => {
            return Err(invalid("invalid bridge request ID"));
        }
        _ => {}
    }
    serde_json::to_string(id).map_err(io::Error::other)
}

#[derive(Clone, Copy, PartialEq)]
enum Readiness {
    Waiting,
    Publishing,
    Visible,
    Committed,
}

struct Root {
    turn_id: Option<String>,
    started: bool,
}

struct Callback {
    request_id: RequestId,
    turn_id: String,
    call_id: String,
    published: bool,
    retained: Option<DynamicToolCallResponse>,
    result_evidence: Option<Value>,
    result_bytes: usize,
    claimed: bool,
    delivered: bool,
}

struct State {
    terminal: bool,
    readiness: Readiness,
    thread_id: Option<String>,
    requests: HashSet<String>,
    root: Option<Root>,
    items: HashMap<String, Value>,
    callbacks: HashMap<String, Callback>,
    nonces: HashSet<String>,
    pending_ready: VecDeque<(Inbound, usize)>,
    bytes: usize,
    limits: Limits,
}

impl State {
    fn lock(shared: &Arc<Mutex<Self>>) -> io::Result<MutexGuard<'_, Self>> {
        let state = shared.lock().map_err(|_| closed("bridge state poisoned"))?;
        if state.terminal {
            return Err(closed("bridge is permanently terminal"));
        }
        Ok(state)
    }

    fn charge(&mut self, bytes: usize) -> io::Result<()> {
        let next = self.bytes.checked_add(bytes).filter(|next| {
            *next <= self.limits.retained_payload_bytes
        }).ok_or_else(|| invalid("bridge retained payload budget exhausted"))?;
        self.bytes = next;
        Ok(())
    }

    fn release(&mut self, bytes: usize) -> io::Result<()> {
        self.bytes = self.bytes.checked_sub(bytes)
            .ok_or_else(|| closed("bridge payload accounting mismatch"))?;
        Ok(())
    }

    fn reserve(&mut self, id: &RequestId) -> io::Result<String> {
        let key = id_key(id)?;
        if self.requests.len() >= 1024 || !self.requests.insert(key.clone()) {
            return Err(invalid("bridge request ID reused or lifetime budget exhausted"));
        }
        Ok(key)
    }

    fn bind_turn(&mut self, turn_id: &str) -> io::Result<()> {
        if turn_id.is_empty() || turn_id.len() > 128 {
            return Err(invalid("invalid actual bridge turn ID"));
        }
        let root = self.root.as_mut().ok_or_else(|| invalid("bridge turn has no admitted root"))?;
        match &root.turn_id {
            Some(actual) if actual != turn_id => Err(invalid("foreign actual bridge turn")),
            Some(_) => Ok(()),
            None => {
                root.turn_id = Some(turn_id.to_owned());
                Ok(())
            }
        }
    }

    fn current_thread(&self, thread: &str) -> io::Result<()> {
        if self.thread_id.as_deref() == Some(thread) {
            Ok(())
        } else {
            Err(invalid("foreign current bridge thread"))
        }
    }

    fn claim(&mut self, key: &str, control: &mpsc::Sender<Control>) -> io::Result<()> {
        let callback = self.callbacks.get_mut(key)
            .ok_or_else(|| invalid("unregistered bridge CONTROL response"))?;
        if !callback.published || callback.retained.is_none() || callback.claimed {
            return Ok(());
        }
        let response = FrozenNativeToolResponse {
            request_id: callback.request_id.clone(),
            thread_id: self.thread_id.clone().ok_or_else(|| invalid("bridge is not ready"))?,
            turn_id: callback.turn_id.clone(),
            call_id: callback.call_id.clone(),
            result: callback.retained.take().ok_or_else(|| closed("bridge result claim lost"))?,
        };
        callback.claimed = true;
        control.try_send(Control { key: key.to_owned(), response })
            .map_err(|_| closed("bridge CONTROL queue closed or exhausted"))
    }

    fn accept(
        &mut self,
        message: Inbound,
        work: &mpsc::Sender<Work>,
        control: &mpsc::Sender<Control>,
    ) -> io::Result<()> {
        match self.readiness {
            Readiness::Waiting | Readiness::Publishing => {
                return Err(invalid("bridge input arrived before readiness publication"));
            }
            Readiness::Visible => {
                if self.pending_ready.len() >= self.limits.work_queue {
                    return Err(invalid("bridge pending readiness input budget exhausted"));
                }
                let bytes = inbound_bytes(&message)?;
                self.charge(bytes)?;
                self.pending_ready.push_back((message, bytes));
                return Ok(());
            }
            Readiness::Committed => {}
        }
        match message {
            Inbound::Initialize { .. } => Err(invalid("bridge was initialized twice")),
            Inbound::Turn { id, params } => {
                self.current_thread(&params.thread_id)?;
                if self.root.is_some() {
                    return Err(invalid("bridge root remains unresolved"));
                }
                self.reserve(&id)?;
                let request = ClientRequest::TurnStart { request_id: id.clone(), params };
                let bytes = serde_json::to_vec(&request)?.len();
                self.charge(bytes)?;
                self.root = Some(Root { turn_id: None, started: false });
                work.try_send(Work { id, request, turn: true, bytes })
                    .map_err(|_| closed("bridge WORK queue closed or exhausted"))
            }
            Inbound::ShellPage { id, params } => {
                self.current_thread(&params.thread_id)?;
                self.reserve(&id)?;
                let request = ClientRequest::ThreadBackgroundTerminalsList {
                    request_id: id.clone(), params,
                };
                let bytes = serde_json::to_vec(&request)?.len();
                self.charge(bytes)?;
                work.try_send(Work { id, request, turn: false, bytes })
                    .map_err(|_| closed("bridge WORK queue closed or exhausted"))
            }
            Inbound::ToolResult { id, result, result_nonce } => {
                let key = id_key(&id)?;
                let callback = self.callbacks.get(&key)
                    .ok_or_else(|| invalid("unregistered bridge CONTROL response"))?;
                if callback.retained.is_some() || callback.claimed {
                    return Err(invalid("bridge CONTROL response replayed"));
                }
                if !self.nonces.insert(result_nonce.to_string()) {
                    return Err(invalid("bridge native result nonce reused"));
                }
                let evidence = serde_json::to_value(&result)?;
                let bytes = serde_json::to_vec(&evidence)?.len();
                self.charge(bytes.checked_mul(2)
                    .ok_or_else(|| invalid("bridge native result size overflow"))?)?;
                let callback = self.callbacks.get_mut(&key)
                    .ok_or_else(|| closed("bridge callback disappeared"))?;
                callback.result_evidence = Some(evidence);
                callback.result_bytes = bytes;
                callback.retained = Some(result);
                #[cfg(test)]
                if let Some(probe) = &self.limits.probe {
                    probe.retained_controls.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                    probe.changed.notify_one();
                }
                self.claim(&key, control)
            }
        }
    }
}

fn inbound_bytes(message: &Inbound) -> io::Result<usize> {
    let bytes = match message {
        Inbound::Initialize { id, boot_nonce, profile_digest } => {
            serde_json::to_vec(&json!([id, boot_nonce.to_string(), profile_digest]))?
        }
        Inbound::Turn { id, params } => serde_json::to_vec(&json!([id, params]))?,
        Inbound::ShellPage { id, params } => serde_json::to_vec(&json!([id, params]))?,
        Inbound::ToolResult { id, result, .. } => serde_json::to_vec(&json!([id, result]))?,
    };
    Ok(bytes.len())
}

struct Work {
    id: RequestId,
    request: ClientRequest,
    turn: bool,
    bytes: usize,
}

struct Control {
    key: String,
    response: FrozenNativeToolResponse,
}

enum Publication {
    None,
    Ready,
    Callback(String),
}

struct Frame {
    bytes: Vec<u8>,
    publication: Publication,
}

fn encode(value: &Value) -> io::Result<Vec<u8>> {
    let mut bytes = serde_json::to_vec(value)?;
    if bytes.len() >= MAX_FRAME_BYTES {
        return Err(invalid("bridge output exceeds delimiter-inclusive frame bound"));
    }
    bytes.push(b'\n');
    Ok(bytes)
}

async fn publish(
    output: &mpsc::Sender<Frame>,
    shared: &Arc<Mutex<State>>,
    value: Value,
    publication: Publication,
) -> io::Result<()> {
    let bytes = encode(&value)?;
    State::lock(shared)?.charge(bytes.len())?;
    output.send(Frame { bytes, publication }).await
        .map_err(|_| closed("bridge output queue closed"))
}

async fn read_message<R: AsyncRead + Unpin>(
    input: &mut R,
    decoder: &mut WireDecoder,
    pending: &mut VecDeque<Inbound>,
) -> io::Result<Inbound> {
    loop {
        if let Some(message) = pending.pop_front() {
            return Ok(message);
        }
        let mut bytes = [0; 4096];
        let count = input.read(&mut bytes).await?;
        if count == 0 {
            decoder.finish()?;
            return Err(closed("wire EOF did not latch"));
        }
        pending.extend(decoder.append(&bytes[..count])?);
    }
}

async fn reader<R: AsyncRead + Unpin>(
    input: &mut R,
    decoder: &mut WireDecoder,
    pending: &mut VecDeque<Inbound>,
    shared: &Arc<Mutex<State>>,
    work: &mpsc::Sender<Work>,
    control: &mpsc::Sender<Control>,
) -> io::Result<()> {
    loop {
        let message = read_message(input, decoder, pending).await?;
        State::lock(shared)?.accept(message, work, control)?;
    }
}

async fn ready<S: BackendSender>(
    sender: &S,
    id: RequestId,
    shared: &Arc<Mutex<State>>,
    output: &mpsc::Sender<Frame>,
) -> io::Result<()> {
    let response = sender.ready().await?;
    {
        let mut state = State::lock(shared)?;
        state.thread_id = Some(identifier(&json!(response.thread.id))?);
        state.readiness = Readiness::Publishing;
    }
    publish(output, shared, json!({"id": id, "result": response.as_ref()}), Publication::Ready).await?;
    pending().await
}

async fn writer<W: AsyncWrite + Unpin>(
    output: &mut W,
    queue: &mut mpsc::Receiver<Frame>,
    shared: &Arc<Mutex<State>>,
    work: &mpsc::Sender<Work>,
    control: &mpsc::Sender<Control>,
) -> io::Result<()> {
    loop {
        let frame = queue.recv().await.ok_or_else(|| closed("bridge output queue closed"))?;
        output.write_all(&frame.bytes).await?;
        if matches!(&frame.publication, Publication::Ready) {
            State::lock(shared)?.readiness = Readiness::Visible;
        }
        output.flush().await?;
        let mut state = State::lock(shared)?;
        state.release(frame.bytes.len())?;
        match frame.publication {
            Publication::None => {}
            Publication::Ready => {
                state.readiness = Readiness::Committed;
                while let Some((message, bytes)) = state.pending_ready.pop_front() {
                    state.release(bytes)?;
                    state.accept(message, work, control)?;
                }
            }
            Publication::Callback(key) => {
                state.callbacks.get_mut(&key)
                    .ok_or_else(|| closed("bridge callback publication lost"))?.published = true;
                state.claim(&key, control)?;
            }
        }
    }
}

async fn work<S: BackendSender>(
    sender: &S,
    queue: &mut mpsc::Receiver<Work>,
    output: &mpsc::Sender<Frame>,
    shared: &Arc<Mutex<State>>,
) -> io::Result<()> {
    loop {
        let job = queue.recv().await.ok_or_else(|| closed("bridge WORK queue closed"))?;
        let response = sender.request(job.request).await?;
        {
            let mut state = State::lock(shared)?;
            if job.turn {
                let typed: TurnStartResponse = serde_json::from_value(response.clone())?;
                state.bind_turn(&typed.turn.id)?;
            }
            state.release(job.bytes)?;
        }
        publish(output, shared, json!({"id": job.id, "result": response}), Publication::None).await?;
    }
}

async fn control<S: BackendSender>(
    sender: &S,
    queue: &mut mpsc::Receiver<Control>,
    shared: &Arc<Mutex<State>>,
) -> io::Result<()> {
    loop {
        let job = queue.recv().await.ok_or_else(|| closed("bridge CONTROL queue closed"))?;
        sender.control(job.response).await?;
        let mut state = State::lock(shared)?;
        let callback = state.callbacks.get_mut(&job.key)
            .ok_or_else(|| closed("bridge CONTROL ownership lost"))?;
        callback.delivered = true;
        let bytes = callback.result_bytes;
        state.release(bytes)?;
    }
}

fn command(value: &Value) -> io::Result<Value> {
    let object = value.as_object().filter(|object| {
        object.len() == 2 && object.contains_key("program") && object.contains_key("arguments")
    }).ok_or_else(|| invalid("bridge native command must have exactly program and arguments"))?;
    let program = object["program"].as_str().filter(|text| {
        text.starts_with('/') && text.len() <= 4096 && !text.contains('\0')
    }).ok_or_else(|| invalid("invalid bridge native command program"))?;
    let arguments = object["arguments"].as_array().filter(|args| args.len() <= 256)
        .ok_or_else(|| invalid("invalid bridge native argument count"))?;
    let mut bytes = program.len();
    for argument in arguments {
        let text = argument.as_str().filter(|text| !text.contains('\0'))
            .ok_or_else(|| invalid("invalid bridge native argument"))?;
        bytes = bytes.checked_add(text.len()).and_then(|bytes| bytes.checked_add(1))
            .filter(|bytes| *bytes <= 65536)
            .ok_or_else(|| invalid("bridge native command byte budget exhausted"))?;
    }
    Ok(value.clone())
}

async fn events<B: Backend>(
    backend: &mut B,
    output: &mpsc::Sender<Frame>,
    shared: &Arc<Mutex<State>>,
) -> io::Result<()> {
    loop {
        let event = backend.next_event().await?;
        let (value, publication) = match event {
            InProcessServerEvent::ServerRequest(request) => {
                let ServerRequest::DynamicToolCall { request_id, params } = *request else {
                    return Err(invalid("unsupported bridge SDK callback"));
                };
                if params.namespace.is_some() || params.tool != "cmux_run_foreground" {
                    return Err(invalid("unsupported bridge native callback"));
                }
                let arguments = command(&params.arguments)?;
                let key = id_key(&request_id)?;
                {
                    let mut state = State::lock(shared)?;
                    state.current_thread(&params.thread_id)?;
                    state.bind_turn(&params.turn_id)?;
                    if state.callbacks.len() >= 4096 || state.callbacks.contains_key(&key)
                        || state.callbacks.values().any(|callback| callback.call_id == params.call_id)
                        || state.items.get(&params.call_id) != Some(&arguments)
                    {
                        return Err(invalid("bridge callback lacks unique matching started item"));
                    }
                    state.callbacks.insert(key.clone(), Callback {
                        request_id: request_id.clone(), turn_id: params.turn_id.clone(),
                        call_id: params.call_id.clone(), published: false, retained: None,
                        result_evidence: None, result_bytes: 0,
                        claimed: false, delivered: false,
                    });
                }
                (json!({"id": request_id, "method": "item/tool/call", "params": params}),
                 Publication::Callback(key))
            }
            InProcessServerEvent::ServerNotification(notification) => {
                let value = serde_json::to_value(notification)?;
                let params = &value["params"];
                let mut state = State::lock(shared)?;
                state.current_thread(&identifier(&params["threadId"])?)?;
                match value["method"].as_str() {
                    Some("turn/started") => {
                        state.bind_turn(&identifier(&params["turn"]["id"])?)?;
                        let root = state.root.as_mut().ok_or_else(|| invalid("unowned bridge turn"))?;
                        if root.started {
                            return Err(invalid("bridge turn start replayed"));
                        }
                        root.started = true;
                    }
                    Some("item/started") => {
                        state.bind_turn(&identifier(&params["turnId"])?)?;
                        let item = &params["item"];
                        if item["type"] != "dynamicToolCall" || !item["namespace"].is_null()
                            || item["tool"] != "cmux_run_foreground" || item["status"] != "inProgress"
                        {
                            return Err(invalid("unsupported bridge started item"));
                        }
                        let call = identifier(&item["id"])?;
                        let arguments = command(&item["arguments"])?;
                        if state.items.len() >= 4096 || state.items.contains_key(&call) {
                            return Err(invalid("bridge started item reused or budget exhausted"));
                        }
                        state.charge(serde_json::to_vec(&arguments)?.len())?;
                        state.items.insert(call, arguments);
                    }
                    _ => return Err(invalid("bridge event has no implemented closed-domain handler")),
                }
                (value, Publication::None)
            }
            _ => return Err(closed("unsupported or lagged bridge SDK event")),
        };
        publish(output, shared, value, publication).await?;
    }
}

struct CatchPump<F>(Pin<Box<F>>);

impl<F: Future<Output = io::Result<()>>> Future for CatchPump<F> {
    type Output = io::Result<()>;

    fn poll(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<Self::Output> {
        match std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            self.0.as_mut().poll(cx)
        })) {
            Ok(result) => result,
            Err(_) => Poll::Ready(Err(closed("bridge pump panicked; work remains uncertain"))),
        }
    }
}

fn checked<F: Future<Output = io::Result<()>>>(future: F) -> CatchPump<F> {
    CatchPump(Box::pin(future))
}

struct TerminalOnDrop(Arc<Mutex<State>>);

impl Drop for TerminalOnDrop {
    fn drop(&mut self) {
        match self.0.lock() {
            Ok(mut state) => state.terminal = true,
            Err(poisoned) => poisoned.into_inner().terminal = true,
        }
    }
}

async fn serve_with_factory<R: AsyncRead + Unpin, W: AsyncWrite + Unpin, F: BackendFactory>(
    mut input: R,
    mut output: W,
    factory: F,
    limits: Limits,
) -> io::Result<()> {
    if limits.work_queue == 0 || limits.control_queue == 0 || limits.output_queue == 0
        || limits.work_queue > 4096 || limits.control_queue > 4096 || limits.output_queue > 4096
        || limits.retained_payload_bytes == 0 || limits.retained_payload_bytes > 16 * 1024 * 1024
    {
        return Err(invalid("invalid private bridge limits"));
    }
    let descriptor = factory.descriptor()?;
    let descriptor_bytes = encode(&descriptor)?;
    output.write_all(&descriptor_bytes).await?;
    output.flush().await?;
    let mut decoder = WireDecoder::new();
    let mut pending_input = VecDeque::new();
    let message = read_message(&mut input, &mut decoder, &mut pending_input).await?;
    let Inbound::Initialize { id, boot_nonce, profile_digest } = message else {
        return Err(invalid("bridge requires one matching initialization before input"));
    };
    if descriptor["params"]["bootNonce"].as_str() != Some(boot_nonce.to_string().as_str())
        || descriptor["params"]["profileDigest"].as_str() != Some(profile_digest.as_str())
        || !pending_input.is_empty()
    {
        return Err(invalid("bridge initialization or pre-ready input differs"));
    }
    let shared = Arc::new(Mutex::new(State {
        terminal: false, readiness: Readiness::Waiting, thread_id: None, requests: HashSet::new(),
        root: None, items: HashMap::new(), callbacks: HashMap::new(), nonces: HashSet::new(),
        pending_ready: VecDeque::new(), bytes: 0, limits: limits.clone(),
    }));
    State::lock(&shared)?.reserve(&id)?;
    let terminal = TerminalOnDrop(Arc::clone(&shared));
    let mut backend = factory.start().await?;
    let sender = backend.sender();
    let (work_send, mut work_receive) = mpsc::channel(limits.work_queue);
    let (control_send, mut control_receive) = mpsc::channel(limits.control_queue);
    let (output_send, mut output_receive) = mpsc::channel(limits.output_queue);
    let result = tokio::select! {
        result = checked(reader(&mut input, &mut decoder, &mut pending_input, &shared,
                                &work_send, &control_send)) => result,
        result = checked(ready(&sender, id, &shared, &output_send)) => result,
        result = checked(work(&sender, &mut work_receive, &output_send, &shared)) => result,
        result = checked(control(&sender, &mut control_receive, &shared)) => result,
        result = checked(events(&mut backend, &output_send, &shared)) => result,
        result = checked(writer(&mut output, &mut output_receive, &shared,
                                &work_send, &control_send)) => result,
        result = checked(sender.terminal()) => result,
    };
    drop(terminal);
    let cleanup = checked(backend.shutdown()).await;
    match (result, cleanup) {
        (Err(error), Ok(())) => Err(error),
        (Err(error), Err(cleanup)) => Err(io::Error::new(error.kind(),
            format!("{error}; bridge cleanup also failed: {cleanup}"))),
        (Ok(()), Err(cleanup)) => Err(cleanup),
        (Ok(()), Ok(())) => Err(closed("bridge pump ended without a terminal witness")),
    }
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
