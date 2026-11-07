//! Phase 0 spikes: one debug route per Cloudflare building block, under
//! `/__spike/<name>`. Compiled only with the `spikes` feature, which only the
//! local `wrangler.toml` enables, so these routes never ship.
//!
//! Each route answers `{ "spike": name, "ok": bool, ... }` and touches only
//! keys, objects and queues named `spike…`, never the TS Worker's data.

use serde_json::{Value, json};
use wasm_bindgen::JsCast;
use worker::js_sys::{self, Array, Function, Promise, Reflect, Uint8Array};
use worker::wasm_bindgen::{self, JsValue};
use worker::wasm_bindgen_futures::JsFuture;
use worker::{
    Context, DurableObject, Env, MessageBatch, MessageExt, Request, Response, State, WebSocket,
    WebSocketIncomingMessage, WebSocketPair, durable_object, event, web_sys,
};

use super::http::split_url;

type SpikeResult = Result<Value, String>;

fn err(e: impl std::fmt::Display) -> String {
    e.to_string()
}

fn js_err(e: JsValue) -> String {
    e.as_string()
        .or_else(|| {
            e.dyn_ref::<js_sys::Error>()
                .map(|e| String::from(e.message()))
        })
        .unwrap_or_else(|| format!("{e:?}"))
}

/// Calls `target[method](...args)` on a binding without a workers-rs wrapper, awaiting promises.
async fn call(target: &JsValue, method: &str, args: &[JsValue]) -> Result<JsValue, String> {
    let function: Function = Reflect::get(target, &JsValue::from_str(method))
        .map_err(js_err)?
        .dyn_into()
        .map_err(|_| format!("{method} is not a function"))?;
    let result = function
        .apply(target, &args.iter().collect::<Array>())
        .map_err(js_err)?;
    match result.dyn_into::<Promise>() {
        Ok(promise) => JsFuture::from(promise).await.map_err(js_err),
        Err(value) => Ok(value),
    }
}

fn binding(env: &Env, name: &str) -> Result<JsValue, String> {
    let value = Reflect::get(env, &JsValue::from_str(name)).map_err(js_err)?;
    if value.is_undefined() {
        Err(format!("binding {name} is missing"))
    } else {
        Ok(value)
    }
}

fn to_json(value: &JsValue) -> Value {
    serde_wasm_bindgen_json(value).unwrap_or(Value::Null)
}

fn serde_wasm_bindgen_json(value: &JsValue) -> Option<Value> {
    let text = js_sys::JSON::stringify(value).ok()?.as_string()?;
    serde_json::from_str(&text).ok()
}

async fn d1(env: &Env) -> SpikeResult {
    let db = env.d1("DB").map_err(err)?;
    // D1 refuses `sqlite_version()` ("not authorized to use function").
    let tables: Option<Value> = db
        .prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type='table'")
        .first(None)
        .await
        .map_err(err)?;
    let users: Option<Value> = db
        .prepare("SELECT COUNT(*) AS n FROM auth_user")
        .first(None)
        .await
        .map_err(err)?;
    let batch = db
        .batch(vec![
            db.prepare("SELECT 1 AS one"),
            db.prepare("SELECT ?1 AS echo")
                .bind(&[JsValue::from_str("é")])
                .map_err(err)?,
        ])
        .await
        .map_err(err)?;
    let echoed: Vec<Value> = batch[1].results().map_err(err)?;
    Ok(json!({ "sqlite_tables": tables, "auth_user": users, "batch_echo": echoed }))
}

async fn kv(env: &Env) -> SpikeResult {
    let store = env.kv("CACHE").map_err(err)?;
    let key = format!("spike:rs:{}", js_sys::Date::now());
    store
        .put(&key, "valeur-é")
        .map_err(err)?
        .expiration_ttl(60)
        .execute()
        .await
        .map_err(err)?;
    let read = store.get(&key).text().await.map_err(err)?;
    let listed = store
        .list()
        .prefix("spike:rs:".into())
        .execute()
        .await
        .map_err(err)?
        .keys
        .len();
    store.delete(&key).await.map_err(err)?;
    let after = store.get(&key).text().await.map_err(err)?;
    Ok(json!({ "read": read, "listed_with_prefix": listed, "after_delete": after }))
}

async fn r2(env: &Env) -> SpikeResult {
    let bucket = env.bucket("FILES").map_err(err)?;
    let key = format!("spike/rs-{}.txt", js_sys::Date::now());
    bucket
        .put(&key, b"bonjour".to_vec())
        .execute()
        .await
        .map_err(err)?;
    let object = bucket
        .get(&key)
        .execute()
        .await
        .map_err(err)?
        .ok_or("object vanished")?;
    let text = object.body().ok_or("no body")?.text().await.map_err(err)?;
    bucket.delete(&key).await.map_err(err)?;

    // Multipart: R2 wants every part but the last to be at least 5 MiB.
    let multipart_key = format!("spike/rs-multipart-{}.bin", js_sys::Date::now());
    let upload = bucket
        .create_multipart_upload(&multipart_key)
        .execute()
        .await
        .map_err(err)?;
    let first = upload
        .upload_part(1, vec![b'a'; 5 * 1024 * 1024])
        .await
        .map_err(err)?;
    let second = upload.upload_part(2, b"fin".to_vec()).await.map_err(err)?;
    let completed = upload.complete(vec![first, second]).await.map_err(err)?;
    let head = bucket
        .head(&multipart_key)
        .await
        .map_err(err)?
        .ok_or("multipart object missing")?;
    bucket.delete(&multipart_key).await.map_err(err)?;
    Ok(json!({ "text": text, "multipart_size": head.size(), "multipart_etag": completed.etag() }))
}

/// A spike message. A struct, not `serde_json::Value`: serde-wasm-bindgen turns
/// JSON maps into JS `Map`s, which the TS consumer would not read as objects.
#[derive(serde::Serialize, serde::Deserialize)]
struct SpikeMessage {
    spike_id: String,
}

async fn queue(env: &Env) -> SpikeResult {
    let id = format!("{}", js_sys::Date::now());
    env.queue("SPIKE_QUEUE")
        .map_err(err)?
        .send(SpikeMessage {
            spike_id: id.clone(),
        })
        .await
        .map_err(err)?;
    // The consumer below records the message in KV; poll for it.
    let store = env.kv("CACHE").map_err(err)?;
    for attempt in 0..40 {
        if let Some(seen) = store
            .get(&format!("spike:queue:{id}"))
            .text()
            .await
            .map_err(err)?
        {
            store
                .delete(&format!("spike:queue:{id}"))
                .await
                .map_err(err)?;
            return Ok(json!({ "sent": id, "consumed": seen, "polls": attempt + 1 }));
        }
        worker::Delay::from(std::time::Duration::from_millis(250)).await;
    }
    Err(format!("message {id} not consumed within 10 s"))
}

/// Consumer of the spike queue only (`supertask-rs-spike`); production builds have none.
#[event(queue)]
async fn queue_consumer(
    batch: MessageBatch<SpikeMessage>,
    env: Env,
    _ctx: Context,
) -> worker::Result<()> {
    let store = env.kv("CACHE")?;
    for message in batch.messages()? {
        let id = &message.body().spike_id;
        let seen = format!("{} via {}", message.id(), batch.queue());
        store
            .put(&format!("spike:queue:{id}"), seen)?
            .expiration_ttl(60)
            .execute()
            .await?;
        message.ack();
    }
    Ok(())
}

/// A Durable Object with SQLite storage and hibernatable WebSockets.
#[durable_object]
pub struct SpikeRoom {
    state: State,
}

impl DurableObject for SpikeRoom {
    fn new(state: State, _env: Env) -> Self {
        Self { state }
    }

    async fn fetch(&self, req: Request) -> worker::Result<Response> {
        if req
            .headers()
            .get("Upgrade")?
            .is_some_and(|u| u.eq_ignore_ascii_case("websocket"))
        {
            let pair = WebSocketPair::new()?;
            self.state.accept_web_socket(&pair.server);
            return Response::from_websocket(pair.client);
        }
        let sql = self.state.storage().sql();
        sql.exec(
            "CREATE TABLE IF NOT EXISTS hits (id INTEGER PRIMARY KEY, at TEXT)",
            None,
        )?;
        sql.exec(
            "INSERT INTO hits (at) VALUES (?)",
            vec![
                js_sys::Date::new_0()
                    .to_iso_string()
                    .as_string()
                    .unwrap_or_default()
                    .into(),
            ],
        )?;
        let rows: Vec<Value> = sql
            .exec("SELECT COUNT(*) AS hits FROM hits", None)?
            .to_array()?;
        Response::from_json(&json!({ "sqlite_rows": rows, "database_size": sql.database_size() }))
    }

    async fn websocket_message(
        &self,
        ws: WebSocket,
        message: WebSocketIncomingMessage,
    ) -> worker::Result<()> {
        let text = match message {
            WebSocketIncomingMessage::String(text) => text,
            WebSocketIncomingMessage::Binary(bytes) => format!("{} bytes", bytes.len()),
        };
        ws.send_with_str(format!("echo:{text}"))
    }

    async fn websocket_close(
        &self,
        ws: WebSocket,
        code: usize,
        reason: String,
        _clean: bool,
    ) -> worker::Result<()> {
        // 1005/1006 (no status, abnormal) and other reserved codes cannot be sent back.
        let code = u16::try_from(code)
            .ok()
            .filter(|c| matches!(c, 1000..=1003 | 1007..=1014 | 3000..=4999))
            .unwrap_or(1000);
        // The peer may already be gone: nothing left to do then.
        let _ = ws.close(Some(code), Some(reason));
        Ok(())
    }
}

async fn durable_object(env: &Env) -> SpikeResult {
    let stub = env
        .durable_object("SPIKE_ROOM")
        .map_err(err)?
        .get_by_name("spike")
        .map_err(err)?;
    let mut response = stub
        .fetch_with_str("https://spike/sql")
        .await
        .map_err(err)?;
    response.json::<Value>().await.map_err(err)
}

async fn ai(env: &Env) -> SpikeResult {
    // Structs, not `json!`: serde-wasm-bindgen would send a JS `Map`, which Workers AI rejects.
    #[derive(serde::Serialize)]
    struct EmbeddingInput {
        text: Vec<&'static str>,
    }
    #[derive(serde::Deserialize, serde::Serialize)]
    struct Embedding {
        shape: Vec<usize>,
    }
    let output: Embedding = env
        .ai("AI")
        .map_err(err)?
        .run(
            "@cf/baai/bge-small-en-v1.5",
            EmbeddingInput {
                text: vec!["Supertask phase 0"],
            },
        )
        .await
        .map_err(err)?;
    Ok(json!({ "model": "@cf/baai/bge-small-en-v1.5", "shape": output.shape }))
}

async fn images(env: &Env) -> SpikeResult {
    // A 1x1 PNG, through the Images binding's `info()` (no workers-rs wrapper: JS interop).
    const PNG: &[u8] = &[
        0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44,
        0x52, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x08, 0x06, 0x00, 0x00, 0x00, 0x1f,
        0x15, 0xc4, 0x89, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x44, 0x41, 0x54, 0x78, 0x9c, 0x63, 0xf8,
        0xcf, 0xc0, 0xf0, 0x1f, 0x00, 0x05, 0x00, 0x01, 0xff, 0x89, 0x99, 0x3d, 0x1d, 0x00, 0x00,
        0x00, 0x00, 0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82,
    ];
    let images = binding(env, "IMAGES")?;
    let bytes = Uint8Array::from(PNG);
    let response = web_sys::Response::new_with_opt_buffer_source(Some(&bytes)).map_err(js_err)?;
    let stream = response.body().ok_or("no stream")?;
    let info = call(&images, "info", &[stream.into()]).await?;
    Ok(json!({ "info": to_json(&info) }))
}

async fn browser(env: &Env) -> SpikeResult {
    // Browser Rendering is a Fetcher; `/v1/limits` reads quotas without launching a browser.
    let fetcher = env.service("BROWSER").map_err(err)?;
    let mut response = fetcher
        .fetch("https://fake.host/v1/limits", None)
        .await
        .map_err(err)?;
    let status = response.status_code();
    let body = response.text().await.map_err(err)?;
    Ok(
        json!({ "status": status, "body": serde_json::from_str::<Value>(&body).unwrap_or(Value::String(body)) }),
    )
}

async fn vectorize(env: &Env) -> SpikeResult {
    // No local simulator and no wrapper: the binding is only checked for its JS API.
    let index = binding(env, "KNOWLEDGE_BASE")?;
    let methods: Vec<&str> = [
        "query",
        "insert",
        "upsert",
        "describe",
        "getByIds",
        "deleteByIds",
    ]
    .into_iter()
    .filter(|m| Reflect::get(&index, &JsValue::from_str(m)).is_ok_and(|f| f.is_function()))
    .collect();
    Ok(json!({ "methods": methods }))
}

/// `/__spike/<name>` dispatcher; `/__spike/ws` upgrades into the spike room.
pub async fn handle(req: Request, env: Env, _ctx: Context) -> worker::Result<web_sys::Response> {
    let url = req.inner().url();
    let name = split_url(&url)
        .0
        .trim_start_matches("/__spike/")
        .trim_end_matches('/')
        .to_owned();
    if name == "ws" {
        let stub = env.durable_object("SPIKE_ROOM")?.get_by_name("spike")?;
        return Ok(stub.fetch_with_request(req).await?.into());
    }
    let result = match name.as_str() {
        "d1" => d1(&env).await,
        "kv" => kv(&env).await,
        "r2" => r2(&env).await,
        "queue" => queue(&env).await,
        "do" => durable_object(&env).await,
        "ai" => ai(&env).await,
        "images" => images(&env).await,
        "browser" => browser(&env).await,
        "vectorize" => vectorize(&env).await,
        _ => Err(format!("unknown spike {name}")),
    };
    let body = match result {
        Ok(details) => json!({ "spike": name, "ok": true, "details": details }),
        Err(error) => json!({ "spike": name, "ok": false, "error": error }),
    };
    Ok(Response::from_json(&body)?.into())
}
