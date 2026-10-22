use super::*;
use std::pin::Pin;
use std::sync::Mutex;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::task::{Context, Poll, Waker};
use std::time::Duration;

use codex_app_server_protocol::DynamicToolCallParams;
use codex_app_server_protocol::RequestId;
use codex_app_server_protocol::ServerNotification;
use codex_app_server_protocol::ServerRequest;
use serde_json::json;
use tokio::io::{AsyncBufRead, AsyncBufReadExt, AsyncWriteExt, BufReader, DuplexStream};
use tokio::sync::{Notify, mpsc, watch};
use tokio::task::JoinHandle;
use tokio::time::timeout;

const NONCE: &str = "00000000-0000-4000-8000-000000000001";
const RESULT_NONCE: &str = "00000000-0000-4000-8000-000000000002";

struct Shared {
    starts: AtomicUsize,
    ready: AtomicUsize,
    shutdown: AtomicUsize,
    work_calls: AtomicUsize,
    control_calls: AtomicUsize,
    block_work: AtomicBool,
    block_control: AtomicBool,
    panic_work: AtomicBool,
    work_go: Notify,
    control_go: Notify,
    control_claimed: Notify,
    terminal: watch::Sender<bool>,
    work: mpsc::Sender<Value>,
    control: mpsc::Sender<Value>,
}

#[derive(Clone)]
struct MockSender(Arc<Shared>);

impl BackendSender for MockSender {
    async fn ready(&self) -> io::Result<Arc<ThreadStartResponse>> {
        self.0.ready.fetch_add(1, Ordering::SeqCst);
        Ok(Arc::new(serde_json::from_value(json!({
            "thread": {
                "id": "thread-a", "sessionId": "session-a", "preview": "", "ephemeral": true,
                "modelProvider": "openai", "createdAt": 0, "updatedAt": 0,
                "status": {"type": "idle"}, "cwd": "/fixture", "cliVersion": "source-test",
                "source": "cli", "turns": [],
            },
            "model": "gpt-5.5", "modelProvider": "openai", "serviceTier": null, "cwd": "/fixture",
            "runtimeWorkspaceRoots": [], "instructionSources": [], "approvalPolicy": "never",
            "approvalsReviewer": "user", "sandbox": {"type": "dangerFullAccess"},
            "activePermissionProfile": null, "reasoningEffort": null,
        }))?))
    }

    async fn request(&self, request: ClientRequest) -> io::Result<Value> {
        let ordinal = self.0.work_calls.fetch_add(1, Ordering::SeqCst);
        let turn = matches!(&request, ClientRequest::TurnStart { .. });
        let value = serde_json::to_value(&request)?;
        self.0.work.send(value).await.map_err(io::Error::other)?;
        assert!(!self.0.panic_work.load(Ordering::SeqCst), "controlled fixture work panic");
        if self.0.block_work.load(Ordering::SeqCst) {
            self.0.work_go.notified().await;
        }
        let next_turn_id = if ordinal == 0 {
            "turn-a".to_owned()
        } else {
            format!("turn-{ordinal}")
        };
        Ok(if turn {
            json!({"turn": {"id": next_turn_id, "items": [], "status": "inProgress", "error": null}})
        } else {
            json!({"data": [], "nextCursor": null})
        })
    }

    async fn control(&self, response: FrozenNativeToolResponse) -> io::Result<()> {
        self.0.control_claimed.notify_one();
        if self.0.block_control.load(Ordering::SeqCst) {
            self.0.control_go.notified().await;
        }
        self.0.control_calls.fetch_add(1, Ordering::SeqCst);
        self.0.control.send(json!({
            "id": response.request_id, "threadId": response.thread_id,
            "turnId": response.turn_id, "callId": response.call_id, "result": response.result,
        })).await.map_err(io::Error::other)
    }

    async fn terminal(&self) -> io::Result<()> {
        let mut changed = self.0.terminal.subscribe();
        loop {
            if *changed.borrow_and_update() {
                return Err(io::Error::new(io::ErrorKind::BrokenPipe, "mock backend terminal"));
            }
            changed.changed().await.map_err(io::Error::other)?;
        }
    }
}

struct MockBackend {
    sender: MockSender,
    events: mpsc::Receiver<InProcessServerEvent>,
}

impl Backend for MockBackend {
    type Sender = MockSender;

    fn sender(&self) -> MockSender {
        self.sender.clone()
    }

    async fn next_event(&mut self) -> io::Result<InProcessServerEvent> {
        self.events.recv().await.ok_or_else(|| io::Error::new(
            io::ErrorKind::BrokenPipe, "mock event channel closed",
        ))
    }

    async fn shutdown(self) -> io::Result<()> {
        self.sender.0.shutdown.fetch_add(1, Ordering::SeqCst);
        Ok(())
    }
}

struct MockFactory(MockBackend);

impl BackendFactory for MockFactory {
    type Backend = MockBackend;

    fn descriptor(&self) -> io::Result<Value> {
        let profile = crate::descriptor::describe_profile()?;
        Ok(json!({
            "method": "cmux/codex/descriptor", "params": {
                "bootNonce": NONCE, "cwd": "/fixture", "storeId": format!("cmux-{NONCE}"),
                "profileDigest": crate::descriptor::json_sha(&profile)?, "profile": profile,
            },
        }))
    }

    async fn start(self) -> io::Result<MockBackend> {
        self.0.sender.0.starts.fetch_add(1, Ordering::SeqCst);
        Ok(self.0)
    }
}

struct Peer {
    shared: Arc<Shared>,
    events: mpsc::Sender<InProcessServerEvent>,
    work: mpsc::Receiver<Value>,
    control: mpsc::Receiver<Value>,
}

fn fixture() -> (MockFactory, Peer) {
    let (events, receive) = mpsc::channel(16);
    let (work, work_receive) = mpsc::channel(16);
    let (control, control_receive) = mpsc::channel(16);
    let shared = Arc::new(Shared {
        starts: AtomicUsize::new(0), ready: AtomicUsize::new(0), shutdown: AtomicUsize::new(0),
        work_calls: AtomicUsize::new(0), control_calls: AtomicUsize::new(0),
        block_work: AtomicBool::new(false), block_control: AtomicBool::new(false),
        panic_work: AtomicBool::new(false), work_go: Notify::new(), control_go: Notify::new(),
        control_claimed: Notify::new(), terminal: watch::channel(false).0, work, control,
    });
    (MockFactory(MockBackend { sender: MockSender(Arc::clone(&shared)), events: receive }),
     Peer { shared, events, work: work_receive, control: control_receive })
}

async fn bounded<T>(future: impl std::future::Future<Output = T>) -> T {
    timeout(Duration::from_secs(3), future).await.expect("CMUX_BRIDGE_FIXTURE_TIMEOUT")
}

async fn read_frame<R: AsyncBufRead + Unpin>(reader: &mut R) -> Value {
    let mut line = String::new();
    let count = bounded(reader.read_line(&mut line)).await.expect("fixture read");
    assert!(count > 0, "CMUX_BRIDGE_BEHAVIOR_NOT_IMPLEMENTED: expected a peer-visible frame");
    serde_json::from_str(&line).expect("actual bridge output JSON")
}

async fn write_frame<W: AsyncWrite + Unpin>(writer: &mut W, value: Value) {
    let mut bytes = serde_json::to_vec(&value).unwrap();
    bytes.push(b'\n');
    bounded(writer.write_all(&bytes)).await.expect("CMUX_BRIDGE_BEHAVIOR_NOT_IMPLEMENTED: write refused");
    bounded(writer.flush()).await.expect("fixture flush");
}

async fn next<T>(receive: &mut mpsc::Receiver<T>) -> T {
    bounded(receive.recv()).await.expect("CMUX_BRIDGE_BEHAVIOR_NOT_IMPLEMENTED: missing backend effect")
}

fn initialize(id: Value, descriptor: &Value) -> Value {
    json!({"id": id, "method": "cmux/initialize", "params": {
        "bootNonce": NONCE, "profileDigest": descriptor["params"]["profileDigest"],
    }})
}

fn turn(id: Value, thread: &str, text: &str) -> Value {
    json!({"id": id, "method": "turn/start", "params": {
        "threadId": thread, "input": [{"type": "text", "text": text, "text_elements": []}],
    }})
}

fn result(id: Value) -> Value {
    json!({"id": id, "result": {"contentItems": [{
        "type": "inputText", "text": format!("cmux-owned-result:{RESULT_NONCE}\nknown fixture result"),
    }], "success": true}})
}

fn notification(method: &str, params: Value) -> InProcessServerEvent {
    let typed: ServerNotification = serde_json::from_value(json!({
        "method": method, "params": params,
    })).expect("source-pinned typed fixture notification");
    InProcessServerEvent::ServerNotification(Box::new(typed))
}

fn tool_item(status: &str) -> Value {
    json!({
        "type": "dynamicToolCall", "id": "call-a", "namespace": null,
        "tool": "cmux_run_foreground", "arguments": {"program": "/usr/bin/true", "arguments": []},
        "status": status, "contentItems": null, "success": null, "durationMs": null,
    })
}

#[derive(Default)]
struct PublicationGate {
    mode: AtomicUsize,
    waiting: Notify,
    waker: Mutex<Option<Waker>>,
}

impl PublicationGate {
    fn release(&self, fail: bool) {
        self.mode.store(if fail { 2 } else { 1 }, Ordering::SeqCst);
        if let Some(waker) = self.waker.lock().unwrap().take() {
            waker.wake();
        }
    }
}

struct GateWriter {
    inner: DuplexStream,
    gate: Option<Arc<PublicationGate>>,
    current: Vec<u8>,
    armed: bool,
}

impl AsyncWrite for GateWriter {
    fn poll_write(mut self: Pin<&mut Self>, cx: &mut Context<'_>, bytes: &[u8]) -> Poll<io::Result<usize>> {
        match Pin::new(&mut self.inner).poll_write(cx, bytes) {
            Poll::Ready(Ok(count)) => {
                for byte in &bytes[..count] {
                    self.current.push(*byte);
                    if *byte == b'\n' {
                        let value: Value = serde_json::from_slice(&self.current).unwrap();
                        if value["method"] == "item/tool/call" {
                            self.armed = true;
                        }
                        self.current.clear();
                    }
                }
                Poll::Ready(Ok(count))
            }
            other => other,
        }
    }

    fn poll_flush(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        if self.armed {
            if let Some(gate) = &self.gate {
                match gate.mode.load(Ordering::SeqCst) {
                    0 => {
                        *gate.waker.lock().unwrap() = Some(cx.waker().clone());
                        gate.waiting.notify_one();
                        return Poll::Pending;
                    }
                    2 => return Poll::Ready(Err(io::Error::new(io::ErrorKind::BrokenPipe, "controlled publication failure"))),
                    _ => {}
                }
            }
        }
        Pin::new(&mut self.inner).poll_flush(cx)
    }

    fn poll_shutdown(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        Pin::new(&mut self.inner).poll_shutdown(cx)
    }
}

struct Harness {
    input: DuplexStream,
    output: BufReader<DuplexStream>,
    task: JoinHandle<io::Result<()>>,
    peer: Peer,
}

impl Harness {
    fn new(limits: Limits, gate: Option<Arc<PublicationGate>>) -> Self {
        let (factory, peer) = fixture();
        let (input, writer) = tokio::io::duplex(4 * 1024 * 1024);
        let (output, reader) = tokio::io::duplex(4 * 1024 * 1024);
        let output = GateWriter { inner: output, gate, current: Vec::new(), armed: false };
        Self {
            input: writer, output: BufReader::new(reader),
            task: tokio::spawn(serve_with_factory(input, output, factory, limits)), peer,
        }
    }

    async fn ready(&mut self) {
        let descriptor = read_frame(&mut self.output).await;
        assert_eq!(descriptor["method"], "cmux/codex/descriptor");
        assert_eq!(self.peer.shared.starts.load(Ordering::SeqCst), 0);
        write_frame(&mut self.input, initialize(json!(7), &descriptor)).await;
        let response = read_frame(&mut self.output).await;
        assert_eq!(response["id"], 7);
        assert_eq!(response["result"]["thread"]["id"], "thread-a");
        assert_eq!(self.peer.shared.starts.load(Ordering::SeqCst), 1);
        assert_eq!(self.peer.shared.ready.load(Ordering::SeqCst), 1);
    }

    async fn callback(&mut self) {
        write_frame(&mut self.input, turn(json!("turn-input"), "thread-a", "literal work")).await;
        assert_eq!(next(&mut self.peer.work).await["method"], "turn/start");
        let response = read_frame(&mut self.output).await;
        assert_eq!(response["result"]["turn"]["id"], "turn-a");
        self.peer.events.send(notification("turn/started", json!({
            "threadId": "thread-a", "turn": {"id": "turn-a", "items": [], "status": "inProgress", "error": null},
        }))).await.unwrap();
        assert_eq!(read_frame(&mut self.output).await["method"], "turn/started");
        self.peer.events.send(notification("item/started", json!({
            "threadId": "thread-a", "turnId": "turn-a", "item": tool_item("inProgress"), "startedAtMs": 0,
        }))).await.unwrap();
        self.peer.events.send(InProcessServerEvent::ServerRequest(Box::new(
            ServerRequest::DynamicToolCall {
                request_id: RequestId::Integer(81),
                params: DynamicToolCallParams {
                    thread_id: "thread-a".into(), turn_id: "turn-a".into(), call_id: "call-a".into(),
                    namespace: None, tool: "cmux_run_foreground".into(),
                    arguments: json!({"program": "/usr/bin/true", "arguments": []}),
                },
            },
        ))).await.unwrap();
        assert_eq!(read_frame(&mut self.output).await["method"], "item/started");
        let call = read_frame(&mut self.output).await;
        assert_eq!(call["method"], "item/tool/call");
        assert_eq!(call["id"], 81);
    }

    async fn fail(self, expected: io::ErrorKind) {
        let error = bounded(self.task).await.expect("bridge task must not panic")
            .expect_err("CMUX_BRIDGE_BEHAVIOR_NOT_IMPLEMENTED: uncertain bridge returned success");
        assert_eq!(error.kind(), expected, "CMUX_BRIDGE_BEHAVIOR_NOT_IMPLEMENTED");
    }

    async fn eof(self) {
        drop(self.input);
        let error = bounded(self.task).await.expect("bridge task must not panic")
            .expect_err("EOF cannot establish healthy completion");
        assert_eq!(error.kind(), io::ErrorKind::UnexpectedEof);
    }
}

#[tokio::test]
async fn cmux_bridge_descriptor_precedes_factory_and_input() {
    let mut h = Harness::new(Limits::default(), None);
    let descriptor = read_frame(&mut h.output).await;
    assert_eq!(descriptor["method"], "cmux/codex/descriptor");
    assert_eq!(h.peer.shared.starts.load(Ordering::SeqCst), 0);
    h.eof().await;
}

#[tokio::test]
async fn cmux_bridge_matching_initialize_returns_actual_typed_readiness_once() {
    let mut h = Harness::new(Limits::default(), None);
    h.ready().await;
    h.eof().await;
}

#[tokio::test]
async fn cmux_bridge_nonce_or_digest_mismatch_never_constructs_backend() {
    for field in ["bootNonce", "profileDigest"] {
        let mut h = Harness::new(Limits::default(), None);
        let descriptor = read_frame(&mut h.output).await;
        let mut request = initialize(json!(7), &descriptor);
        request["params"][field] = json!(if field == "bootNonce" {
            RESULT_NONCE.to_owned()
        } else {
            "a".repeat(64)
        });
        write_frame(&mut h.input, request).await;
        let shared = Arc::clone(&h.peer.shared);
        h.fail(io::ErrorKind::InvalidData).await;
        assert_eq!(shared.starts.load(Ordering::SeqCst), 0);
    }
}

#[tokio::test]
async fn cmux_bridge_duplicate_initialize_and_foreign_thread_fail_before_dispatch() {
    for duplicate in [false, true] {
        let mut h = Harness::new(Limits::default(), None);
        h.ready().await;
        let message = if duplicate {
            let profile = crate::descriptor::describe_profile().unwrap();
            json!({"id": 9, "method": "cmux/initialize", "params": {
                "bootNonce": NONCE, "profileDigest": crate::descriptor::json_sha(&profile).unwrap(),
            }})
        } else {
            turn(json!(9), "foreign-thread", "literal")
        };
        write_frame(&mut h.input, message).await;
        let shared = Arc::clone(&h.peer.shared);
        h.fail(io::ErrorKind::InvalidData).await;
        assert_eq!(shared.starts.load(Ordering::SeqCst), 1);
        assert_eq!(shared.work_calls.load(Ordering::SeqCst), 0);
    }
}

#[tokio::test]
async fn cmux_bridge_reserved_integer_ids_fail_but_string_ids_preserve_literal() {
    let mut h = Harness::new(Limits::default(), None);
    h.ready().await;
    write_frame(&mut h.input, turn(json!("-1"), "thread-a", "  literal \u{1f600}\n\"quoted\"  ")).await;
    let request = next(&mut h.peer.work).await;
    assert_eq!(request["id"], "-1");
    assert_eq!(request["params"]["input"][0]["text"], "  literal \u{1f600}\n\"quoted\"  ");
    assert_eq!(request["params"]["environments"], json!([]));
    let _ = read_frame(&mut h.output).await;
    write_frame(&mut h.input, json!({
        "id": -1, "method": "thread/backgroundTerminals/list",
        "params": {"threadId": "thread-a", "cursor": null, "limit": 128},
    })).await;
    h.fail(io::ErrorKind::InvalidData).await;
}

#[tokio::test]
async fn cmux_bridge_registered_control_preserves_exact_tuple_nonce_and_result() {
    let mut h = Harness::new(Limits::default(), None);
    h.ready().await;
    h.callback().await;
    write_frame(&mut h.input, result(json!(81))).await;
    let delivered = next(&mut h.peer.control).await;
    assert_eq!(delivered["id"], 81);
    assert_eq!(delivered["threadId"], "thread-a");
    assert_eq!(delivered["turnId"], "turn-a");
    assert_eq!(delivered["callId"], "call-a");
    assert_eq!(delivered["result"], result(json!(81))["result"]);
    h.eof().await;
}

#[tokio::test]
async fn cmux_bridge_unregistered_or_typed_foreign_control_never_delivers() {
    for id in [json!(99), json!("81")] {
        let mut h = Harness::new(Limits::default(), None);
        h.ready().await;
        h.callback().await;
        write_frame(&mut h.input, result(id)).await;
        let shared = Arc::clone(&h.peer.shared);
        h.fail(io::ErrorKind::InvalidData).await;
        assert_eq!(shared.control_calls.load(Ordering::SeqCst), 0);
    }
}

#[tokio::test]
async fn cmux_bridge_publication_pending_retains_response_until_success() {
    let gate = Arc::new(PublicationGate::default());
    let probe = Arc::new(BridgeProbe::default());
    let mut h = Harness::new(Limits { probe: Some(Arc::clone(&probe)), ..Limits::default() },
                             Some(Arc::clone(&gate)));
    h.ready().await;
    h.callback().await;
    bounded(gate.waiting.notified()).await;
    write_frame(&mut h.input, result(json!(81))).await;
    bounded(probe.changed.notified()).await;
    assert_eq!(probe.retained_controls.load(Ordering::SeqCst), 1);
    assert!(h.peer.control.try_recv().is_err());
    gate.release(false);
    assert_eq!(next(&mut h.peer.control).await["id"], 81);
    h.eof().await;
}

#[tokio::test]
async fn cmux_bridge_publication_failure_never_delivers_retained_response() {
    let gate = Arc::new(PublicationGate::default());
    let probe = Arc::new(BridgeProbe::default());
    let mut h = Harness::new(Limits { probe: Some(Arc::clone(&probe)), ..Limits::default() },
                             Some(Arc::clone(&gate)));
    h.ready().await;
    h.callback().await;
    bounded(gate.waiting.notified()).await;
    write_frame(&mut h.input, result(json!(81))).await;
    bounded(probe.changed.notified()).await;
    assert_eq!(probe.retained_controls.load(Ordering::SeqCst), 1);
    assert!(h.peer.control.try_recv().is_err());
    let shared = Arc::clone(&h.peer.shared);
    gate.release(true);
    h.fail(io::ErrorKind::BrokenPipe).await;
    assert_eq!(shared.control_calls.load(Ordering::SeqCst), 0);
}

#[tokio::test]
async fn cmux_bridge_blocked_work_and_queued_page_do_not_block_registered_control() {
    let mut h = Harness::new(Limits { work_queue: 1, ..Limits::default() }, None);
    h.ready().await;
    h.callback().await;
    h.peer.shared.block_work.store(true, Ordering::SeqCst);
    for id in [20, 21] {
        write_frame(&mut h.input, json!({
            "id": id, "method": "thread/backgroundTerminals/list",
            "params": {"threadId": "thread-a", "cursor": null, "limit": 128},
        })).await;
        if id == 20 {
            assert_eq!(next(&mut h.peer.work).await["id"], 20);
        }
    }
    write_frame(&mut h.input, result(json!(81))).await;
    assert_eq!(next(&mut h.peer.control).await["id"], 81);
    h.peer.shared.block_work.store(false, Ordering::SeqCst);
    h.peer.shared.work_go.notify_one();
    assert_eq!(next(&mut h.peer.work).await["id"], 21);
    let _ = read_frame(&mut h.output).await;
    let _ = read_frame(&mut h.output).await;
    h.eof().await;
}

#[tokio::test]
async fn cmux_bridge_backend_terminal_wakes_blocked_publication() {
    let gate = Arc::new(PublicationGate::default());
    let mut h = Harness::new(Limits::default(), Some(Arc::clone(&gate)));
    h.ready().await;
    h.callback().await;
    bounded(gate.waiting.notified()).await;
    h.peer.shared.terminal.send_replace(true);
    h.fail(io::ErrorKind::BrokenPipe).await;
}

#[tokio::test]
async fn cmux_bridge_actual_os_pipes_preserve_typed_request_and_literal() -> io::Result<()> {
    use std::os::fd::OwnedFd;
    let (input, mut client) = io::pipe()?;
    let (output, writer) = io::pipe()?;
    let input = tokio::fs::File::from_std(std::fs::File::from(OwnedFd::from(input)));
    let writer = tokio::fs::File::from_std(std::fs::File::from(OwnedFd::from(writer)));
    let output = tokio::fs::File::from_std(std::fs::File::from(OwnedFd::from(output)));
    let (factory, mut peer) = fixture();
    let task = tokio::spawn(serve_with_factory(input, writer, factory, Limits::default()));
    let mut output = BufReader::new(output);
    let descriptor = read_frame(&mut output).await;
    let mut data = serde_json::to_vec(&initialize(json!(7), &descriptor))?;
    data.push(b'\n');
    std::io::Write::write_all(&mut client, &data)?;
    let _ = read_frame(&mut output).await;
    let literal = "  literal \u{1f600}\nno normalization\t";
    let mut data = serde_json::to_vec(&turn(json!(i64::MIN), "thread-a", literal))?;
    data.push(b'\n');
    for byte in data {
        std::io::Write::write_all(&mut client, &[byte])?;
    }
    let request = next(&mut peer.work).await;
    assert_eq!(request["id"], i64::MIN);
    assert_eq!(request["params"]["input"][0]["text"], literal);
    drop(client);
    assert_eq!(bounded(task).await.expect("task").unwrap_err().kind(), io::ErrorKind::UnexpectedEof);
    Ok(())
}

#[tokio::test]
async fn cmux_bridge_pre_initialize_work_never_constructs_backend() {
    let mut h = Harness::new(Limits::default(), None);
    let _ = read_frame(&mut h.output).await;
    write_frame(&mut h.input, turn(json!(22), "thread-a", "must not dispatch")).await;
    let shared = Arc::clone(&h.peer.shared);
    h.fail(io::ErrorKind::InvalidData).await;
    assert_eq!(shared.starts.load(Ordering::SeqCst), 0);
    assert_eq!(shared.work_calls.load(Ordering::SeqCst), 0);
}

#[tokio::test]
async fn cmux_bridge_completed_request_id_cannot_dispatch_again() {
    let mut h = Harness::new(Limits::default(), None);
    h.ready().await;
    let page = json!({
        "id": 23, "method": "thread/backgroundTerminals/list",
        "params": {"threadId": "thread-a", "cursor": null, "limit": 128},
    });
    write_frame(&mut h.input, page.clone()).await;
    assert_eq!(next(&mut h.peer.work).await["id"], 23);
    assert_eq!(read_frame(&mut h.output).await["id"], 23);
    write_frame(&mut h.input, page).await;
    let shared = Arc::clone(&h.peer.shared);
    h.fail(io::ErrorKind::InvalidData).await;
    assert_eq!(shared.work_calls.load(Ordering::SeqCst), 1);
    assert_eq!(shared.shutdown.load(Ordering::SeqCst), 1);
}

#[tokio::test]
async fn cmux_bridge_unresolved_root_refuses_second_turn_before_dispatch() {
    let mut h = Harness::new(Limits::default(), None);
    h.ready().await;
    write_frame(&mut h.input, turn(json!(22), "thread-a", "first root")).await;
    assert_eq!(next(&mut h.peer.work).await["id"], 22);
    assert_eq!(read_frame(&mut h.output).await["result"]["turn"]["id"], "turn-a");
    write_frame(&mut h.input, turn(json!(23), "thread-a", "unsettled second root")).await;
    let shared = Arc::clone(&h.peer.shared);
    h.fail(io::ErrorKind::InvalidData).await;
    assert_eq!(shared.work_calls.load(Ordering::SeqCst), 1);
}

#[tokio::test]
async fn cmux_bridge_duplicate_native_result_never_delivers_twice() {
    let mut h = Harness::new(Limits::default(), None);
    h.ready().await;
    h.callback().await;
    write_frame(&mut h.input, result(json!(81))).await;
    assert_eq!(next(&mut h.peer.control).await["id"], 81);
    write_frame(&mut h.input, result(json!(81))).await;
    let shared = Arc::clone(&h.peer.shared);
    h.fail(io::ErrorKind::InvalidData).await;
    assert_eq!(shared.control_calls.load(Ordering::SeqCst), 1);
}

#[tokio::test]
async fn cmux_bridge_native_nonce_is_unique_across_registered_callbacks() {
    let mut h = Harness::new(Limits::default(), None);
    h.ready().await;
    h.callback().await;
    write_frame(&mut h.input, result(json!(81))).await;
    assert_eq!(next(&mut h.peer.control).await["id"], 81);
    let mut item = tool_item("inProgress");
    item["id"] = json!("call-b");
    h.peer.events.send(notification("item/started", json!({
        "threadId": "thread-a", "turnId": "turn-a", "item": item, "startedAtMs": 0,
    }))).await.unwrap();
    h.peer.events.send(InProcessServerEvent::ServerRequest(Box::new(
        ServerRequest::DynamicToolCall {
            request_id: RequestId::Integer(82),
            params: DynamicToolCallParams {
                thread_id: "thread-a".into(), turn_id: "turn-a".into(), call_id: "call-b".into(),
                namespace: None, tool: "cmux_run_foreground".into(),
                arguments: json!({"program": "/usr/bin/true", "arguments": []}),
            },
        },
    ))).await.unwrap();
    assert_eq!(read_frame(&mut h.output).await["method"], "item/started");
    assert_eq!(read_frame(&mut h.output).await["id"], 82);
    write_frame(&mut h.input, result(json!(82))).await;
    let shared = Arc::clone(&h.peer.shared);
    h.fail(io::ErrorKind::InvalidData).await;
    assert_eq!(shared.control_calls.load(Ordering::SeqCst), 1);
}

#[tokio::test]
async fn cmux_bridge_worker_panic_returns_terminal_uncertainty_and_cleans_backend() {
    let mut h = Harness::new(Limits::default(), None);
    h.ready().await;
    h.peer.shared.panic_work.store(true, Ordering::SeqCst);
    write_frame(&mut h.input, turn(json!(22), "thread-a", "controlled panic")).await;
    assert_eq!(next(&mut h.peer.work).await["id"], 22);
    let shared = Arc::clone(&h.peer.shared);
    h.fail(io::ErrorKind::BrokenPipe).await;
    assert_eq!(shared.work_calls.load(Ordering::SeqCst), 1);
    assert_eq!(shared.shutdown.load(Ordering::SeqCst), 1);
}

#[tokio::test]
async fn cmux_bridge_retained_output_budget_exhaustion_never_claims_readiness() {
    let mut h = Harness::new(Limits { retained_payload_bytes: 1, ..Limits::default() }, None);
    let descriptor = read_frame(&mut h.output).await;
    write_frame(&mut h.input, initialize(json!(7), &descriptor)).await;
    let error = bounded(&mut h.task).await.expect("bridge task must not panic")
        .expect_err("exhausted retained payload budget cannot establish readiness");
    assert_eq!(error.kind(), io::ErrorKind::InvalidData);
    let mut remaining = Vec::new();
    bounded(tokio::io::AsyncReadExt::read_to_end(&mut h.output, &mut remaining))
        .await.expect("closed bridge output");
    assert!(remaining.is_empty(), "readiness frame escaped an exhausted output budget");
    assert_eq!(h.peer.shared.work_calls.load(Ordering::SeqCst), 0);
    assert_eq!(h.peer.shared.shutdown.load(Ordering::SeqCst), 1);
}

#[tokio::test]
async fn cmux_bridge_invalid_native_command_never_reaches_output() {
    let invalid = [
        json!({"program": "relative", "arguments": []}),
        json!({"program": "/bad\0program", "arguments": []}),
        json!({"program": format!("/{}", "x".repeat(4096)), "arguments": []}),
        json!({"program": "/ok", "arguments": vec!["x"; 257]}),
        json!({"program": "/ok", "arguments": ["bad\0argument"]}),
        json!({"program": "/ok", "arguments": ["x".repeat(65536)]}),
        json!({"program": "/ok", "arguments": [], "extra": true}),
    ];
    for arguments in invalid {
        let mut h = Harness::new(Limits::default(), None);
        h.ready().await;
        h.callback().await;
        let mut item = tool_item("inProgress");
        item["id"] = json!("call-b");
        item["arguments"] = arguments;
        h.peer.events.send(notification("item/started", json!({
            "threadId": "thread-a", "turnId": "turn-a", "item": item, "startedAtMs": 0,
        }))).await.unwrap();
        let error = bounded(&mut h.task).await.expect("bridge task must not panic")
            .expect_err("invalid native command cannot remain healthy");
        assert_eq!(error.kind(), io::ErrorKind::InvalidData);
        let mut remaining = Vec::new();
        bounded(tokio::io::AsyncReadExt::read_to_end(&mut h.output, &mut remaining))
            .await.expect("closed bridge output");
        assert!(remaining.is_empty(), "invalid native command escaped to a peer-visible frame");
        assert_eq!(h.peer.shared.control_calls.load(Ordering::SeqCst), 0);
    }
}

fn completed_item() -> Value {
    let mut item = tool_item("completed");
    let output = result(json!(81));
    item["contentItems"] = output["result"]["contentItems"].clone();
    item["success"] = json!(true);
    item["durationMs"] = json!(1);
    item
}

async fn settlement_frame<R: AsyncBufRead + Unpin>(reader: &mut R) -> Value {
    let mut line = String::new();
    let count = bounded(reader.read_line(&mut line)).await.expect("settlement fixture read");
    assert!(count > 0, "CMUX_BRIDGE_SETTLEMENT_NOT_IMPLEMENTED: expected peer-visible completion");
    serde_json::from_str(&line).expect("actual bridge completion JSON")
}

async fn complete_callback_and_turn(h: &mut Harness) {
    h.peer.events.send(notification("item/completed", json!({
        "threadId": "thread-a", "turnId": "turn-a", "item": completed_item(), "completedAtMs": 1,
    }))).await.unwrap();
    assert_eq!(settlement_frame(&mut h.output).await["method"], "item/completed");
    h.peer.events.send(notification("turn/completed", json!({
        "threadId": "thread-a",
        "turn": {"id": "turn-a", "items": [], "status": "completed", "error": null},
    }))).await.unwrap();
    assert_eq!(settlement_frame(&mut h.output).await["method"], "turn/completed");
}

async fn admit_next_helper_root(h: &mut Harness) {
    write_frame(&mut h.input, turn(json!(90), "thread-a", "next helper root")).await;
    assert_eq!(next(&mut h.peer.work).await["id"], 90);
    assert_eq!(read_frame(&mut h.output).await["result"]["turn"]["id"], "turn-1");
}

#[tokio::test]
async fn cmux_bridge_exact_echo_and_terminal_publish_before_next_helper_root() {
    let mut h = Harness::new(Limits::default(), None);
    h.ready().await;
    h.callback().await;
    write_frame(&mut h.input, result(json!(81))).await;
    assert_eq!(next(&mut h.peer.control).await["id"], 81);
    complete_callback_and_turn(&mut h).await;
    admit_next_helper_root(&mut h).await;
    h.eof().await;
}

#[tokio::test]
async fn cmux_bridge_early_echo_and_terminal_cannot_release_pending_control() {
    let mut h = Harness::new(Limits::default(), None);
    h.ready().await;
    h.callback().await;
    h.peer.shared.block_control.store(true, Ordering::SeqCst);
    write_frame(&mut h.input, result(json!(81))).await;
    bounded(h.peer.shared.control_claimed.notified()).await;
    complete_callback_and_turn(&mut h).await;
    write_frame(&mut h.input, turn(json!(90), "thread-a", "must remain held")).await;
    let shared = Arc::clone(&h.peer.shared);
    h.fail(io::ErrorKind::InvalidData).await;
    assert_eq!(shared.work_calls.load(Ordering::SeqCst), 1);
    assert_eq!(shared.control_calls.load(Ordering::SeqCst), 0);
    assert_eq!(shared.shutdown.load(Ordering::SeqCst), 1);
}

#[tokio::test]
async fn cmux_bridge_early_echo_join_releases_only_after_checked_control_returns() {
    let mut h = Harness::new(Limits::default(), None);
    h.ready().await;
    h.callback().await;
    h.peer.shared.block_control.store(true, Ordering::SeqCst);
    write_frame(&mut h.input, result(json!(81))).await;
    bounded(h.peer.shared.control_claimed.notified()).await;
    complete_callback_and_turn(&mut h).await;
    assert_eq!(h.peer.shared.control_calls.load(Ordering::SeqCst), 0);
    h.peer.shared.block_control.store(false, Ordering::SeqCst);
    h.peer.shared.control_go.notify_one();
    assert_eq!(next(&mut h.peer.control).await["id"], 81);
    admit_next_helper_root(&mut h).await;
    h.eof().await;
}

#[tokio::test]
async fn cmux_bridge_foreign_or_mismatched_consumed_echo_never_reaches_output() {
    for mismatch in ["thread", "turn", "call", "tool", "command", "text", "nonce", "success", "status"] {
        let mut h = Harness::new(Limits::default(), None);
        h.ready().await;
        h.callback().await;
        write_frame(&mut h.input, result(json!(81))).await;
        assert_eq!(next(&mut h.peer.control).await["id"], 81);
        let mut params = json!({
            "threadId": "thread-a", "turnId": "turn-a", "item": completed_item(), "completedAtMs": 1,
        });
        match mismatch {
            "thread" => params["threadId"] = json!("foreign-thread"),
            "turn" => params["turnId"] = json!("foreign-turn"),
            "call" => params["item"]["id"] = json!("foreign-call"),
            "tool" => params["item"]["tool"] = json!("foreign-tool"),
            "command" => params["item"]["arguments"]["program"] = json!("/usr/bin/false"),
            "text" => params["item"]["contentItems"][0]["text"] = json!(
                format!("cmux-owned-result:{RESULT_NONCE}\ndifferent fixture result")
            ),
            "nonce" => params["item"]["contentItems"][0]["text"] = json!(
                "cmux-owned-result:00000000-0000-4000-8000-000000000003\nknown fixture result"
            ),
            "success" => params["item"]["success"] = json!(false),
            "status" => params["item"]["status"] = json!("inProgress"),
            _ => unreachable!(),
        }
        h.peer.events.send(notification("item/completed", params)).await.unwrap();
        let error = bounded(&mut h.task).await.expect("bridge task must not panic")
            .expect_err("foreign or mismatched consumed echo cannot remain healthy");
        assert_eq!(error.kind(), io::ErrorKind::InvalidData);
        let mut remaining = Vec::new();
        bounded(tokio::io::AsyncReadExt::read_to_end(&mut h.output, &mut remaining))
            .await.expect("closed bridge output");
        assert!(remaining.is_empty(), "mismatched consumed echo escaped to a peer-visible frame");
        assert_eq!(h.peer.shared.control_calls.load(Ordering::SeqCst), 1);
    }
}
