use std::io;
use std::io::{Read, Write};

use cmux_managed_codex_host::wire::{Inbound, MAX_FRAME_BYTES, WireDecoder};
use codex_app_server_protocol::RequestId;
use serde_json::{Value, json};
use uuid::Uuid;

const NONCE: &str = "00000000-0000-4000-8000-000000000001";
const DIGEST: &str = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

fn initialize() -> Value {
    json!({"id":"native-init","method":"cmux/initialize",
        "params":{"bootNonce":NONCE,"profileDigest":DIGEST}})
}

fn turn(id: Value, text: &str) -> Value {
    json!({"id":id,"method":"turn/start","params":{"threadId":"actual-sdk-thread",
        "input":[{"type":"text","text":text,"text_elements":[]}]}})
}

fn shell() -> Value {
    json!({"id":"page-1","method":"thread/backgroundTerminals/list",
        "params":{"threadId":"actual-sdk-thread","cursor":null,"limit":128}})
}

fn response() -> Value {
    json!({"id":17,"result":{"contentItems":[
        {"type":"inputText","text":format!("cmux-owned-result:{NONCE}\nretained result\n")}],
        "success":true}})
}

fn frame(value: &Value) -> Vec<u8> {
    let mut bytes = serde_json::to_vec(value).expect("fixture JSON");
    bytes.push(b'\n');
    bytes
}

fn one(value: Value) -> Inbound {
    let mut decoded = WireDecoder::new().append(&frame(&value))
        .expect("strict wire must accept the exact native frame");
    assert_eq!(decoded.len(), 1);
    decoded.pop().expect("one native frame")
}

fn reject(bytes: &[u8]) {
    let mut decoder = WireDecoder::new();
    assert!(decoder.append(bytes).is_err(), "accepted invalid frame: {bytes:?}");
    assert!(decoder.append(&frame(&initialize())).is_err(), "decoder reset after violation");
    assert!(decoder.finish().is_err(), "violation cleared on EOF");
}

#[test]
fn cmux_wire_initialize_preserves_exact_nonce_digest_and_typed_id() {
    let Inbound::Initialize { id, boot_nonce, profile_digest } = one(initialize()) else {
        panic!("wrong initialization variant");
    };
    assert_eq!(id, RequestId::String("native-init".into()));
    assert_eq!(boot_nonce, Uuid::parse_str(NONCE).expect("fixture UUID"));
    assert_eq!(profile_digest, DIGEST);
}

#[test]
fn cmux_wire_preserves_string_and_i64_extremes_without_coercion() {
    for (json_id, expected) in [
        (json!("1"), RequestId::String("1".into())),
        (json!(1), RequestId::Integer(1)),
        (json!(i64::MIN), RequestId::Integer(i64::MIN)),
        (json!(i64::MAX), RequestId::Integer(i64::MAX)),
        (json!(-1), RequestId::Integer(-1)),
    ] {
        let Inbound::Turn { id, .. } = one(turn(json_id, "literal")) else {
            panic!("wrong turn variant");
        };
        assert_eq!(id, expected);
    }
}

#[test]
fn cmux_wire_os_pipe_fragments_preserve_literal_text_and_frame_order() -> io::Result<()> {
    let literal = " \t@agent\n\"quotes\" \\slash \r\n\u{1f9ed}\0 ";
    let mut bytes = frame(&initialize());
    bytes.extend(frame(&turn(json!("native-turn"), literal)));
    assert!(bytes.len() < 4096, "fixture exceeds conservative atomic pipe write bound");
    let (mut reader, mut writer) = io::pipe()?;
    writer.write_all(&bytes)?;
    drop(writer);
    let mut decoder = WireDecoder::new();
    let mut messages = Vec::new();
    let mut chunk = [0; 7];
    loop {
        let count = reader.read(&mut chunk)?;
        if count == 0 {
            break;
        }
        messages.extend(decoder.append(&chunk[..count])
            .expect("actual OS-pipe fragments must decode losslessly"));
    }
    assert_eq!(messages.len(), 2);
    assert!(matches!(messages[0], Inbound::Initialize { .. }));
    let Inbound::Turn { params, .. } = &messages[1] else { panic!("wrong second frame"); };
    assert_eq!(params.thread_id, "actual-sdk-thread");
    assert_eq!(params.environments, Some(Vec::new()));
    assert_eq!(serde_json::to_value(&params.input)?,
        json!([{"type":"text","text":literal,"text_elements":[]}]));
    assert!(decoder.finish().is_err(), "physical EOF must fail the generation");
    Ok(())
}

#[test]
fn cmux_wire_prompt_limit_counts_utf8_bytes_at_65536_and_65537() {
    let maximum = "\u{1f9ed}".repeat(16_384);
    assert_eq!(maximum.len(), 65_536);
    let Inbound::Turn { params, .. } = one(turn(json!("maximum"), &maximum)) else {
        panic!("wrong bounded prompt variant");
    };
    assert_eq!(serde_json::to_value(&params.input).expect("input JSON")[0]["text"], maximum);
    reject(&frame(&turn(json!("over"), &(maximum + "x"))));
}

#[test]
fn cmux_wire_frame_limit_includes_lf_delimiter_and_all_whitespace() {
    let mut exact = serde_json::to_vec(&initialize()).expect("fixture JSON");
    exact.resize(MAX_FRAME_BYTES - 1, b' ');
    exact.push(b'\n');
    assert_eq!(exact.len(), 2 * 1024 * 1024);
    assert_eq!(WireDecoder::new().append(&exact).expect("exact2MiB frame must fit").len(), 1);
    exact.insert(exact.len() - 1, b' ');
    assert_eq!(exact.len(), MAX_FRAME_BYTES + 1);
    reject(&exact);
}

#[test]
fn cmux_wire_refuses_unterminated_frame_at_reserved_delimiter_bound() {
    let mut bytes = serde_json::to_vec(&initialize()).expect("fixture JSON");
    bytes.resize(MAX_FRAME_BYTES, b' ');
    reject(&bytes);
}

#[test]
fn cmux_wire_fragmented_multibyte_utf8_is_accepted_only_after_complete_frame() {
    let bytes = frame(&turn(json!("utf8"), "\u{1f9ed}"));
    let start = bytes.windows(4).position(|part| part == "\u{1f9ed}".as_bytes()).expect("literal UTF8");
    let mut decoder = WireDecoder::new();
    assert!(decoder.append(&bytes[..start + 2]).expect("partial UTF8 is pending").is_empty());
    assert_eq!(decoder.append(&bytes[start + 2..]).expect("complete UTF8").len(), 1);
}

#[test]
fn cmux_wire_rejects_bool_float_null_overflow_and_unbounded_ids() {
    for id in [json!(true), json!(false), Value::Null, json!(1.0), json!(1.5),
        json!(u64::MAX), json!(""), json!("x".repeat(129))] {
        reject(&frame(&turn(id, "literal")));
    }
    let raw = br#"{"id":1e0,"method":"turn/start","params":{"threadId":"t","input":[{"type":"text","text":"literal","text_elements":[]}]}}
"#;
    reject(raw);
}

#[test]
fn cmux_wire_rejects_duplicate_and_escaped_duplicate_keys_at_every_depth() {
    for raw in [
        r#"{"id":1,"id":2,"method":"cmux/initialize","params":{}}"#,
        r#"{"id":1,"\u0069d":2,"method":"cmux/initialize","params":{}}"#,
        r#"{"id":1,"method":"turn/start","params":{"threadId":"t","threadId":"u","input":[]}}"#,
        r#"{"id":1,"method":"turn/start","params":{"threadId":"t","input":[{"type":"text","text":"a","text":"b","text_elements":[]}]}}"#,
        r#"{"id":1,"result":{"contentItems":[{"type":"inputText","text":"a","text":"b"}],"success":true}}"#,
    ] {
        reject(format!("{raw}\n").as_bytes());
    }
}

#[test]
fn cmux_wire_rejects_envelope_extras_traces_notifications_errors_and_nonobjects() {
    for key in ["jsonrpc", "trace", "extra", "result", "error"] {
        let mut value = initialize();
        value[key] = Value::Null;
        reject(&frame(&value));
    }
    for value in [json!([]), json!(null), json!(1), json!("object"),
        json!({"method":"initialized"}),
        json!({"id":1,"error":{"code":1,"message":"ignored"}})] {
        reject(&frame(&value));
    }
}

#[test]
fn cmux_wire_rejects_all_nonprivate_mutation_and_execution_routes() {
    for method in ["initialize", "initialized", "thread/start", "thread/resume",
        "thread/fork", "turn/steer", "turn/interrupt", "review/start", "config/read",
        "config/value/write", "thread/settings/update", "thread/shellCommand",
        "thread/backgroundTerminals/clean", "thread/backgroundTerminals/terminate",
        "mcpServerStatus/list", "command/exec", "account/login/start"] {
        let mut value = initialize();
        value["method"] = json!(method);
        reject(&frame(&value));
    }
}

#[test]
fn cmux_wire_initialize_rejects_noncanonical_nil_missing_or_invalid_bindings() {
    for nonce in ["00000000-0000-0000-0000-000000000000", "invalid",
        "00000000000040008000000000000001", "00000000-0000-4ABC-8000-000000000001"] {
        let mut value = initialize();
        value["params"]["bootNonce"] = json!(nonce);
        reject(&frame(&value));
    }
    for digest in ["", "0123", &"A".repeat(64), &"g".repeat(64)] {
        let mut value = initialize();
        value["params"]["profileDigest"] = json!(digest);
        reject(&frame(&value));
    }
    for key in ["bootNonce", "profileDigest"] {
        let mut value = initialize();
        value["params"].as_object_mut().expect("params").remove(key);
        reject(&frame(&value));
    }
    let mut value = initialize();
    value["params"]["nativeOptIn"] = json!(true);
    reject(&frame(&value));
}

#[test]
fn cmux_wire_turn_rejects_input_variants_text_elements_and_semantic_overrides() {
    for key in ["model", "cwd", "config", "environments", "selectedCapabilityRoots",
        "toolOutput", "additionalContext", "approvalPolicy", "sandboxPolicy", "effort",
        "runtimeWorkspaceRoots", "serviceTier", "outputSchema"] {
        let mut value = turn(json!("turn"), "literal");
        value["params"][key] = Value::Null;
        reject(&frame(&value));
    }
    for input in [json!([]), json!([{"type":"image","url":"data:fixture"}]),
        json!([{"type":"text","text":"a","text_elements":[{}]}]),
        json!([{"type":"text","text":"a"}]),
        json!([{"type":"text","text":"a","text_elements":[],"extra":null}]),
        json!([{"type":"text","text":"a","text_elements":[]},
            {"type":"text","text":"b","text_elements":[]}])] {
        let mut value = turn(json!("turn"), "literal");
        value["params"]["input"] = input;
        reject(&frame(&value));
    }
    for text in ["", " \t\r\n"] {
        reject(&frame(&turn(json!("blank"), text)));
    }
}

#[test]
fn cmux_wire_shell_page_matches_exact_native_pager_shape() {
    for cursor in [Value::Null, json!("opaque-next-page")] {
        let mut value = shell();
        value["params"]["cursor"] = cursor.clone();
        let Inbound::ShellPage { id, params } = one(value) else { panic!("wrong shell variant"); };
        assert_eq!(id, RequestId::String("page-1".into()));
        assert_eq!(params.thread_id, "actual-sdk-thread");
        assert_eq!(params.limit, Some(128));
        assert_eq!(serde_json::to_value(params.cursor).expect("cursor JSON"), cursor);
    }
}

#[test]
fn cmux_wire_shell_page_rejects_limit_cursor_and_extra_field_drift() {
    for limit in [Value::Null, json!(0), json!(1), json!(127), json!(129), json!(128.0), json!(true)] {
        let mut value = shell();
        value["params"]["limit"] = limit;
        reject(&frame(&value));
    }
    for cursor in [json!(""), json!("x".repeat(4097)), json!({}), json!(0)] {
        let mut value = shell();
        value["params"]["cursor"] = cursor;
        reject(&frame(&value));
    }
    let mut value = shell();
    value["params"]["command"] = json!("never execute");
    reject(&frame(&value));
}

#[test]
fn cmux_wire_tool_response_uses_actual_sdk_envelope_and_retains_nonce_text() {
    let expected = response();
    let Inbound::ToolResult { id, result, result_nonce } = one(expected.clone()) else {
        panic!("wrong callback response variant");
    };
    assert_eq!(id, RequestId::Integer(17));
    assert_eq!(result_nonce, Uuid::parse_str(NONCE).expect("result nonce"));
    assert_eq!(serde_json::to_value(result).expect("typed callback"), expected["result"]);
}

#[test]
fn cmux_wire_tool_response_rejects_extra_media_items_nonce_drift_and_success_coercion() {
    for success in [json!("true"), json!(1), Value::Null] {
        let mut value = response();
        value["result"]["success"] = success;
        reject(&frame(&value));
    }
    for items in [json!([]), json!([{"type":"inputImage","imageUrl":"data:fixture"}]),
        json!([{"type":"inputText","text":"no nonce"}]),
        json!([{"type":"inputText","text":"cmux-owned-result:00000000-0000-0000-0000-000000000000\n"}]),
        json!([{"type":"inputText","text":format!("cmux-owned-result:{NONCE}\n"),"extra":null}]),
        json!([{"type":"inputText","text":format!("cmux-owned-result:{NONCE}\n")},
            {"type":"inputText","text":"extra"}])] {
        let mut value = response();
        value["result"]["contentItems"] = items;
        reject(&frame(&value));
    }
    let mut value = response();
    value["result"]["threadId"] = json!("must not be a new callback parameter");
    reject(&frame(&value));
}

#[test]
fn cmux_wire_rejects_invalid_utf8_json_empty_lines_and_trailing_documents() {
    for bytes in [
        b"\xff\n".as_slice(), b"{\n", b"\n", b" \r\n", b"{}{}\n", b"null\n",
        b"{\"id\":1,\"method\":\"cmux/initialize\",\"params\":{}}\xff\n",
    ] {
        reject(bytes);
    }
}

#[test]
fn cmux_wire_partial_json_utf8_and_even_clean_eof_permanently_fail() {
    for bytes in [b"{".as_slice(), b"{\"text\":\"\xf0\x9f", b""] {
        let mut decoder = WireDecoder::new();
        assert!(decoder.append(bytes).expect("unterminated fragment must remain pending").is_empty());
        assert!(decoder.finish().is_err(), "EOF was presented as a healthy generation");
        assert!(decoder.append(&frame(&initialize())).is_err(), "EOF failure was cleared");
    }
}
