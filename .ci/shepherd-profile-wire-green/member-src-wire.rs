use std::fmt;
use std::io;

use codex_app_server_protocol::DynamicToolCallOutputContentItem;
use codex_app_server_protocol::DynamicToolCallResponse;
use codex_app_server_protocol::RequestId;
use codex_app_server_protocol::ThreadBackgroundTerminalsListParams;
use codex_app_server_protocol::TurnStartParams;
use serde::Deserialize;
use serde::Deserializer;
use serde::de::{MapAccess, SeqAccess, Visitor};
use serde_json::{Map, Number, Value};
use uuid::Uuid;

use crate::descriptor::fixed_turn_params;

pub const MAX_FRAME_BYTES: usize = 2 * 1024 * 1024;

#[derive(Debug)]
pub enum Inbound {
    Initialize { id: RequestId, boot_nonce: Uuid, profile_digest: String },
    Turn { id: RequestId, params: TurnStartParams },
    ShellPage { id: RequestId, params: ThreadBackgroundTerminalsListParams },
    ToolResult { id: RequestId, result: DynamicToolCallResponse, result_nonce: Uuid },
}

#[derive(Default)]
pub struct WireDecoder {
    pending: Vec<u8>,
    terminal: bool,
}

impl WireDecoder {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn append(&mut self, bytes: &[u8]) -> io::Result<Vec<Inbound>> {
        if self.terminal {
            return Err(io::Error::new(io::ErrorKind::BrokenPipe, "private wire is terminal"));
        }
        let result = self.append_frames(bytes);
        if result.is_err() {
            self.terminal = true;
            self.pending.clear();
        }
        result
    }

    pub fn finish(&mut self) -> io::Result<()> {
        self.terminal = true;
        let message = if self.pending.is_empty() {
            "private input EOF"
        } else {
            "private input EOF during an incomplete frame"
        };
        self.pending.clear();
        Err(io::Error::new(io::ErrorKind::UnexpectedEof, message))
    }

    fn append_frames(&mut self, mut bytes: &[u8]) -> io::Result<Vec<Inbound>> {
        let mut messages = Vec::new();
        while !bytes.is_empty() {
            let newline = bytes.iter().position(|byte| *byte == b'\n');
            let count = newline.unwrap_or(bytes.len());
            if count > MAX_FRAME_BYTES - 1 - self.pending.len() {
                return Err(invalid("private frame exceeds its delimiter-inclusive byte bound"));
            }
            self.pending.extend_from_slice(&bytes[..count]);
            let Some(newline) = newline else { break; };
            messages.push(decode_frame(&self.pending)?);
            self.pending.clear();
            bytes = &bytes[newline + 1..];
        }
        Ok(messages)
    }
}

fn invalid(message: &'static str) -> io::Error {
    io::Error::new(io::ErrorKind::InvalidData, message)
}

fn exact_object<'a>(value: &'a Value, keys: &[&str]) -> io::Result<&'a Map<String, Value>> {
    let object = value.as_object().ok_or_else(|| invalid("private value must be an object"))?;
    if object.len() != keys.len() || !keys.iter().all(|key| object.contains_key(*key)) {
        return Err(invalid("private object has missing or extra fields"));
    }
    Ok(object)
}

fn bounded_string(value: &Value, maximum: usize) -> io::Result<&str> {
    value.as_str().filter(|value| !value.is_empty() && value.len() <= maximum)
        .ok_or_else(|| invalid("private identifier or cursor exceeds its string domain"))
}

fn request_id(value: &Value) -> io::Result<RequestId> {
    if let Some(value) = value.as_i64() {
        return Ok(RequestId::Integer(value));
    }
    Ok(RequestId::String(bounded_string(value, 128)?.to_owned()))
}

fn canonical_nonce(value: &str) -> io::Result<Uuid> {
    let nonce = Uuid::parse_str(value).map_err(|_| invalid("invalid private nonce"))?;
    if nonce.is_nil() || nonce.to_string() != value {
        return Err(invalid("private nonce must be canonical and nonnil"));
    }
    Ok(nonce)
}

fn decode_frame(bytes: &[u8]) -> io::Result<Inbound> {
    std::str::from_utf8(bytes).map_err(|error| io::Error::new(io::ErrorKind::InvalidData, error))?;
    let mut deserializer = serde_json::Deserializer::from_slice(bytes);
    let StrictValue(value) = StrictValue::deserialize(&mut deserializer)
        .map_err(|error| io::Error::new(io::ErrorKind::InvalidData, error))?;
    deserializer.end().map_err(|error| io::Error::new(io::ErrorKind::InvalidData, error))?;
    let object = value.as_object().ok_or_else(|| invalid("private envelope must be an object"))?;
    if object.contains_key("method") {
        let envelope = exact_object(&value, &["id", "method", "params"])?;
        let id = request_id(&envelope["id"])?;
        match envelope["method"].as_str() {
            Some("cmux/initialize") => {
                let params = exact_object(&envelope["params"], &["bootNonce", "profileDigest"])?;
                let boot_nonce = canonical_nonce(bounded_string(&params["bootNonce"], 36)?)?;
                let digest = bounded_string(&params["profileDigest"], 64)?;
                if digest.len() != 64 || !digest.bytes().all(|byte| {
                    byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte)
                }) {
                    return Err(invalid("private profile digest must be lowercase SHA256"));
                }
                Ok(Inbound::Initialize { id, boot_nonce, profile_digest: digest.to_owned() })
            }
            Some("turn/start") => {
                let params = exact_object(&envelope["params"], &["threadId", "input"])?;
                let thread_id = bounded_string(&params["threadId"], 128)?;
                let input = params["input"].as_array().filter(|items| items.len() == 1)
                    .ok_or_else(|| invalid("private turn requires exactly one text input"))?;
                let text = exact_object(&input[0], &["type", "text", "text_elements"])?;
                if text["type"].as_str() != Some("text")
                    || !text["text_elements"].as_array().is_some_and(Vec::is_empty)
                {
                    return Err(invalid("private turn requires literal text without text elements"));
                }
                let literal = text["text"].as_str()
                    .ok_or_else(|| invalid("private turn text must be a string"))?;
                let params = fixed_turn_params(thread_id.to_owned(), literal.to_owned())?;
                Ok(Inbound::Turn { id, params })
            }
            Some("thread/backgroundTerminals/list") => {
                let params = exact_object(&envelope["params"], &["threadId", "cursor", "limit"])?;
                if params["limit"].as_u64() != Some(128) {
                    return Err(invalid("private pager requires the fixed native page size"));
                }
                let thread_id = bounded_string(&params["threadId"], 128)?.to_owned();
                let cursor = if params["cursor"].is_null() {
                    None
                } else {
                    Some(bounded_string(&params["cursor"], 4096)?.to_owned())
                };
                Ok(Inbound::ShellPage {
                    id, params: ThreadBackgroundTerminalsListParams { thread_id, cursor, limit: Some(128) },
                })
            }
            _ => Err(invalid("unsupported private method")),
        }
    } else {
        let envelope = exact_object(&value, &["id", "result"])?;
        let id = request_id(&envelope["id"])?;
        let result = exact_object(&envelope["result"], &["contentItems", "success"])?;
        let success = result["success"].as_bool()
            .ok_or_else(|| invalid("private callback success must be a boolean"))?;
        let items = result["contentItems"].as_array().filter(|items| items.len() == 1)
            .ok_or_else(|| invalid("private callback requires exactly one text item"))?;
        let item = exact_object(&items[0], &["type", "text"])?;
        if item["type"].as_str() != Some("inputText") {
            return Err(invalid("private callback requires text-only output"));
        }
        let text = item["text"].as_str().ok_or_else(|| invalid("private callback text must be a string"))?;
        let (nonce, _) = text.strip_prefix("cmux-owned-result:").and_then(|text| text.split_once('\n'))
            .ok_or_else(|| invalid("private callback lacks its native result witness"))?;
        let result_nonce = canonical_nonce(nonce)?;
        Ok(Inbound::ToolResult {
            id,
            result: DynamicToolCallResponse {
                content_items: vec![DynamicToolCallOutputContentItem::InputText { text: text.to_owned() }],
                success,
            },
            result_nonce,
        })
    }
}

struct StrictValue(Value);

impl<'de> Deserialize<'de> for StrictValue {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        deserializer.deserialize_any(StrictVisitor).map(Self)
    }
}

struct StrictVisitor;

impl<'de> Visitor<'de> for StrictVisitor {
    type Value = Value;

    fn expecting(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("JSON without duplicate object keys")
    }

    fn visit_bool<E: serde::de::Error>(self, value: bool) -> Result<Value, E> {
        Ok(Value::Bool(value))
    }

    fn visit_i64<E: serde::de::Error>(self, value: i64) -> Result<Value, E> {
        Ok(Value::Number(Number::from(value)))
    }

    fn visit_u64<E: serde::de::Error>(self, value: u64) -> Result<Value, E> {
        Ok(Value::Number(Number::from(value)))
    }

    fn visit_f64<E: serde::de::Error>(self, value: f64) -> Result<Value, E> {
        Number::from_f64(value).map(Value::Number)
            .ok_or_else(|| E::custom("nonfinite private number"))
    }

    fn visit_str<E: serde::de::Error>(self, value: &str) -> Result<Value, E> {
        Ok(Value::String(value.to_owned()))
    }

    fn visit_string<E: serde::de::Error>(self, value: String) -> Result<Value, E> {
        Ok(Value::String(value))
    }

    fn visit_unit<E: serde::de::Error>(self) -> Result<Value, E> {
        Ok(Value::Null)
    }

    fn visit_seq<A: SeqAccess<'de>>(self, mut sequence: A) -> Result<Value, A::Error> {
        let mut values = Vec::new();
        while let Some(StrictValue(value)) = sequence.next_element()? {
            values.push(value);
        }
        Ok(Value::Array(values))
    }

    fn visit_map<A: MapAccess<'de>>(self, mut map: A) -> Result<Value, A::Error> {
        let mut values = Map::new();
        while let Some(key) = map.next_key::<String>()? {
            if values.contains_key(&key) {
                return Err(serde::de::Error::custom("duplicate private object key"));
            }
            let StrictValue(value) = map.next_value()?;
            values.insert(key, value);
        }
        Ok(Value::Object(values))
    }
}
