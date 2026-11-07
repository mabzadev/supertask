//! WebSocket checks over raw TCP (RFC 6455 handshake and text frames), so the
//! bench needs no WebSocket crate: `/ws/core/` must upgrade through the Rust
//! Worker's LEGACY forwarding exactly like on the TS Worker, and the spike
//! Durable Object must echo.

use std::time::Duration;

use base64::Engine;
use serde_json::Value;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpStream;
use tokio::time::timeout;

use crate::Outcome;

struct Socket {
    stream: TcpStream,
    buffer: Vec<u8>,
}

/// Opens `path` on `base` (`http://host:port`) and returns the status code and, on 101, the socket.
async fn open(base: &str, path: &str) -> Result<(u16, Option<Socket>), String> {
    let authority = base.trim_start_matches("http://").trim_end_matches('/');
    let mut stream = TcpStream::connect(authority)
        .await
        .map_err(|e| format!("{authority}: {e}"))?;
    let key = base64::engine::general_purpose::STANDARD.encode(*b"st-difftest-key!");
    let request = format!(
        "GET {path} HTTP/1.1\r\nHost: {authority}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: {key}\r\nSec-WebSocket-Version: 13\r\n\r\n"
    );
    stream
        .write_all(request.as_bytes())
        .await
        .map_err(|e| e.to_string())?;
    let mut buffer = Vec::new();
    let head_end = loop {
        let mut chunk = [0u8; 1024];
        let read = timeout(Duration::from_secs(10), stream.read(&mut chunk))
            .await
            .map_err(|_| "handshake timed out")?
            .map_err(|e| e.to_string())?;
        if read == 0 {
            return Err("connection closed during handshake".into());
        }
        buffer.extend_from_slice(&chunk[..read]);
        if let Some(end) = buffer.windows(4).position(|w| w == b"\r\n\r\n") {
            break end + 4;
        }
    };
    let head = String::from_utf8_lossy(&buffer[..head_end]).into_owned();
    let status = head
        .split(' ')
        .nth(1)
        .and_then(|s| s.parse().ok())
        .ok_or("no status line")?;
    let rest = buffer[head_end..].to_vec();
    Ok((
        status,
        (status == 101).then_some(Socket {
            stream,
            buffer: rest,
        }),
    ))
}

impl Socket {
    async fn send_text(&mut self, text: &str) -> Result<(), String> {
        let mask = [0x12u8, 0x34, 0x56, 0x78];
        let payload = text.as_bytes();
        let mut frame = vec![0x81];
        match payload.len() {
            n if n < 126 => frame.push(0x80 | u8::try_from(n).unwrap_or(0)),
            n => {
                frame.push(0x80 | 126);
                frame.extend_from_slice(
                    &u16::try_from(n)
                        .map_err(|_| "frame too long")?
                        .to_be_bytes(),
                );
            }
        }
        frame.extend_from_slice(&mask);
        frame.extend(payload.iter().enumerate().map(|(i, b)| b ^ mask[i % 4]));
        self.stream
            .write_all(&frame)
            .await
            .map_err(|e| e.to_string())
    }

    /// The next text frame (control frames skipped).
    async fn read_text(&mut self) -> Result<String, String> {
        loop {
            while let Some((opcode, payload, used)) = parse_frame(&self.buffer) {
                self.buffer.drain(..used);
                match opcode {
                    0x1 => return Ok(String::from_utf8_lossy(&payload).into_owned()),
                    0x8 => return Err("server closed the socket".into()),
                    _ => {}
                }
            }
            let mut chunk = [0u8; 4096];
            let read = timeout(Duration::from_secs(10), self.stream.read(&mut chunk))
                .await
                .map_err(|_| "no message within 10 s")?
                .map_err(|e| e.to_string())?;
            if read == 0 {
                return Err("connection closed".into());
            }
            self.buffer.extend_from_slice(&chunk[..read]);
        }
    }
}

/// An unmasked server frame: `(opcode, payload, bytes used)`.
fn parse_frame(data: &[u8]) -> Option<(u8, Vec<u8>, usize)> {
    if data.len() < 2 {
        return None;
    }
    let opcode = data[0] & 0x0f;
    let (length, start) = match data[1] & 0x7f {
        126 => (
            usize::from(u16::from_be_bytes([*data.get(2)?, *data.get(3)?])),
            4,
        ),
        127 => (
            usize::try_from(u64::from_be_bytes(data.get(2..10)?.try_into().ok()?)).ok()?,
            10,
        ),
        n => (usize::from(n), 2),
    };
    let payload = data.get(start..start + length)?.to_vec();
    Some((opcode, payload, start + length))
}

/// `{"type":"authentication",...}` with the per-connection id masked.
fn masked_greeting(text: &str) -> String {
    let mut value: Value = serde_json::from_str(text).unwrap_or(Value::String(text.to_owned()));
    if let Some(id) = value.get_mut("web_socket_id").filter(|v| !v.is_null()) {
        *id = Value::String("<id>".into());
    }
    value.to_string()
}

async fn core_session(base: &str, token: &str) -> Result<(u16, String, String), String> {
    let (status, socket) = open(base, &format!("/ws/core/?jwt_token={token}")).await?;
    let Some(mut socket) = socket else {
        return Ok((status, String::new(), String::new()));
    };
    let greeting = masked_greeting(&socket.read_text().await?);
    socket.send_text(r#"{"type":"ping"}"#).await?;
    let pong = socket.read_text().await?;
    Ok((status, greeting, pong))
}

/// The WebSocket cases.
pub async fn run(ts: &str, rs: &str, token: &str) -> Vec<Outcome> {
    let mut outcomes = Vec::new();
    let differences = match (core_session(ts, token).await, core_session(rs, token).await) {
        (Ok(a), Ok(b)) if a == b && a.0 == 101 => vec![],
        (Ok(a), Ok(b)) => vec![format!("ts {a:?} / rs {b:?}")],
        (a, b) => vec![format!("ts {a:?} / rs {b:?}")],
    };
    outcomes.push(Outcome {
        name: "/ws/core/ upgrade, greeting and ping through LEGACY".into(),
        differences,
        served_by: "legacy",
        status: None,
    });
    let unauthenticated = match (open(ts, "/ws/core/").await, open(rs, "/ws/core/").await) {
        (Ok((a, _)), Ok((b, _))) if a == b => vec![],
        (a, b) => vec![format!("ts {:?} / rs {:?}", a.map(|x| x.0), b.map(|x| x.0))],
    };
    outcomes.push(Outcome {
        name: "/ws/core/ without token".into(),
        differences: unauthenticated,
        served_by: "legacy",
        status: None,
    });

    let echo = async {
        let (status, socket) = open(rs, "/__spike/ws").await?;
        let mut socket = socket.ok_or(format!("spike room answered {status}"))?;
        socket.send_text("bonjour").await?;
        socket.read_text().await
    };
    let differences = match echo.await {
        Ok(reply) if reply == "echo:bonjour" => vec![],
        other => vec![format!("spike room: {other:?}")],
    };
    outcomes.push(Outcome {
        name: "Rust Durable Object WebSocket echo (/__spike/ws, Rust only)".into(),
        differences,
        served_by: "rust",
        status: None,
    });
    outcomes
}
