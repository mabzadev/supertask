#!/usr/bin/env node
import { strFromU8, unzipSync } from "fflate";

const baseUrl = (process.env.OPENTABL_API_URL || "https://opentabl.mbza.workers.dev").replace(/\/$/, "");
const stamp = Date.now();
const email = `opentabl-e2e-${stamp}@example.com`;
const password = `OpenTabl-${stamp}!`;
const expectSecureFileServe = process.env.OPENTABL_EXPECT_SECURE_FILE_SERVE === "1";

let accessToken = "";
let refreshToken = "";
const results = [];
let uploadedSmokeFile = null;
let cleanupWorkspaceId = null;

function bytes(base64) {
  return Uint8Array.from(Buffer.from(base64, "base64"));
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function refreshAccessToken() {
  if (!refreshToken) return false;
  const response = await fetch(`${baseUrl}/api/user/token-refresh/`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ refresh_token: refreshToken }),
  });
  if (!response.ok) return false;
  const data = await response.json();
  if (!data.access_token) return false;
  accessToken = data.access_token;
  refreshToken = data.refresh_token || refreshToken;
  return true;
}

async function request(method, path, body, options = {}) {
  const headers = new Headers(options.headers || {});
  if (accessToken && options.auth !== false) headers.set("Authorization", `JWT ${accessToken}`);
  let payload = body;
  if (body !== undefined && !(body instanceof FormData)) {
    headers.set("content-type", "application/json");
    payload = JSON.stringify(body);
  }
  let response;
  let lastFetchError;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      response = await fetch(`${baseUrl}${path}`, {
        method,
        headers,
        body: payload,
      });
      break;
    } catch (error) {
      lastFetchError = error;
      if (attempt < 3) await new Promise((resolve) => setTimeout(resolve, attempt * 250));
    }
  }
  if (!response) throw new Error(`${method} ${path} -> fetch failed: ${lastFetchError?.message || lastFetchError}`);
  if (
    response.status === 401 &&
    options.auth !== false &&
    !options.authRetried &&
    (await refreshAccessToken())
  ) {
    return request(method, path, body, { ...options, authRetried: true });
  }
  const text = await response.text();
  let data = null;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = text;
    }
  }
  if (!response.ok) {
    if (options.allowError) {
      return { status: response.status, data };
    }
    throw new Error(`${method} ${path} -> ${response.status}: ${typeof data === "string" ? data : JSON.stringify(data)}`);
  }
  return data;
}

async function rawRequest(method, path, body, options = {}) {
  const headers = new Headers(options.headers || {});
  if (accessToken && options.auth !== false) headers.set("Authorization", `JWT ${accessToken}`);
  let payload = body;
  if (body !== undefined && !(body instanceof FormData)) {
    headers.set("content-type", "application/json");
    payload = JSON.stringify(body);
  }
  let lastFetchError;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      const response = await fetch(`${baseUrl}${path}`, {
        method,
        headers,
        body: payload,
        redirect: options.redirect || "manual",
      });
      if (
        response.status === 401 &&
        options.auth !== false &&
        !options.authRetried &&
        (await refreshAccessToken())
      ) {
        return rawRequest(method, path, body, { ...options, authRetried: true });
      }
      return response;
    } catch (error) {
      lastFetchError = error;
      if (attempt < 3) await new Promise((resolve) => setTimeout(resolve, attempt * 250));
    }
  }
  throw new Error(`${method} ${path} -> fetch failed: ${lastFetchError?.message || lastFetchError}`);
}

async function cleanupActiveSmokeWorkspaces() {
  if (!accessToken) return [];
  const activeWorkspaces = await request("GET", "/api/workspaces/");
  const cleaned = [];
  for (const activeWorkspace of activeWorkspaces) {
    await request("DELETE", `/api/workspaces/${activeWorkspace.id}/`);
    cleaned.push(activeWorkspace.id);
  }
  cleanupWorkspaceId = null;
  return cleaned;
}

function parseEventStream(text) {
  return text
    .split("\n\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function openRealtimeConnection() {
  const url = new URL(baseUrl);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.pathname = "/ws/core/";
  url.search = new URLSearchParams({ jwt_token: accessToken }).toString();
  const socket = new WebSocket(url);
  const messages = [];
  const waiters = [];
  socket.addEventListener("message", (event) => {
    let message;
    try {
      message = JSON.parse(String(event.data));
    } catch {
      return;
    }
    messages.push(message);
    for (const waiter of [...waiters]) waiter();
  });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("realtime WebSocket open timed out")), 15000);
    socket.addEventListener("open", () => {
      clearTimeout(timer);
      resolve();
    }, { once: true });
    socket.addEventListener("error", () => {
      clearTimeout(timer);
      reject(new Error("realtime WebSocket connection failed"));
    }, { once: true });
  });
  return {
    socket,
    async waitFor(predicate, label) {
      const existing = messages.find(predicate);
      if (existing) return existing;
      return new Promise((resolve, reject) => {
        const check = () => {
          const matched = messages.find(predicate);
          if (!matched) return;
          clearTimeout(timer);
          waiters.splice(waiters.indexOf(check), 1);
          resolve(matched);
        };
        const timer = setTimeout(() => {
          waiters.splice(waiters.indexOf(check), 1);
          reject(new Error(`${label} realtime message timed out`));
        }, 15000);
        waiters.push(check);
      });
    },
  };
}

async function pollJob(job, label, attempts = 180) {
  assert(job?.id, `${label} job id missing`);
  let current = job;
  for (let i = 0; i < attempts; i += 1) {
    if (current.state === "finished" || current.state === "failed" || current.state === "cancelled") {
      break;
    }
    await delay(1000);
    current = await request("GET", `/api/jobs/${job.id}/`);
  }
  assert(
    current.state === "finished",
    `${label} job did not finish: ${current.state || "unknown"}${current.human_readable_error ? ` (${current.human_readable_error})` : ""}`
  );
  return current;
}

async function step(name, fn) {
  const started = Date.now();
  const value = await fn();
  results.push({ name, ms: Date.now() - started });
  console.log(`ok ${name}`);
  return value;
}

const expectedThumbnailPresets = {
  tiny: { width: null, height: 21 },
  small: { width: 48, height: 48 },
  card_cover: { width: 300, height: 160 },
};

async function assertReadableImageThumbnails(file, label) {
  assert(file?.thumbnails && typeof file.thumbnails === "object", `${label} thumbnails missing`);
  for (const [name, expected] of Object.entries(expectedThumbnailPresets)) {
    const thumbnail = file.thumbnails[name];
    assert(thumbnail?.url, `${label} ${name} thumbnail URL missing`);
    assert(thumbnail.url.includes(`thumbnail=${name}`), `${label} ${name} thumbnail URL query mismatch`);
    assert(thumbnail.width === expected.width, `${label} ${name} thumbnail width mismatch`);
    assert(thumbnail.height === expected.height, `${label} ${name} thumbnail height mismatch`);
    const response = await fetch(thumbnail.url);
    assert(response.ok, `${label} ${name} thumbnail URL was not readable`);
    assert((response.headers.get("content-type") || "").startsWith("image/"), `${label} ${name} thumbnail content type mismatch`);
    const body = await response.arrayBuffer();
    assert(body.byteLength > 0, `${label} ${name} thumbnail response was empty`);
  }
}

function assertSecureFileUrl(url, label) {
  if (!expectSecureFileServe) return;
  assert(typeof url === "string" && url.startsWith(`${baseUrl}/api/files/`), `${label} must use secure backend file serve`);
}

function assertSecureFileObject(file, label) {
  if (!expectSecureFileServe) return;
  assertSecureFileUrl(file?.url, `${label} URL`);
  if (file?.thumbnails) {
    for (const [name, thumbnail] of Object.entries(file.thumbnails)) {
      assertSecureFileUrl(thumbnail?.url, `${label} ${name} thumbnail URL`);
    }
  }
}

const writableFieldPayloads = [
  ["text", { name: "Text smoke", type: "text" }, "hello"],
  ["long_text", { name: "Long smoke", type: "long_text" }, "long text"],
  ["url", { name: "Url smoke", type: "url" }, "https://example.com"],
  ["email", { name: "Email smoke", type: "email" }, "field@example.com"],
  ["phone_number", { name: "Phone smoke", type: "phone_number" }, "+33123456789"],
  ["number", {
    name: "Number smoke",
    type: "number",
    number_decimal_places: 2,
    number_prefix: "EUR ",
    number_suffix: " paid",
    number_separator: "SPACE_COMMA",
  }, "EUR 1 234,50 paid"],
  ["rating", { name: "Rating smoke", type: "rating", max_value: 5 }, "4"],
  ["boolean", { name: "Bool smoke", type: "boolean" }, "false"],
  ["date", { name: "Date smoke", type: "date", date_format: "EU", date_include_time: false }, "21/05/2026"],
  ["duration", { name: "Duration smoke", type: "duration" }, "1:30"],
  ["single_select", { name: "Single smoke", type: "single_select", select_options: [{ value: "A", color: "blue" }] }, { id: 1, value: "A", color: "blue" }],
  ["multiple_select", { name: "Multi smoke", type: "multiple_select", select_options: [{ value: "A", color: "blue" }] }, [{ id: 1, value: "A", color: "blue" }]],
  ["multiple_collaborators", { name: "Collaborators smoke", type: "multiple_collaborators", notify_user_when_added: true }, []],
  ["file", { name: "File smoke", type: "file" }, []],
  ["password", { name: "Password smoke", type: "password" }, "secret"],
  ["ai", {
    name: "AI smoke",
    type: "ai",
    ai_generative_ai_type: "openai",
    ai_generative_ai_model: "smoke-test-model",
    ai_output_type: "text",
    ai_prompt: "'Summarize this row'",
  }, "ai value"],
];

async function main() {
  console.log(`Application smoke test against ${baseUrl}`);

  await step("health full", async () => {
    const data = await request("GET", "/_health/full/");
    assert(data.status === "ok", "health full is not ok");
  });

  await step("health email", async () => {
    const data = await request("POST", "/_health/email/", { target_email: email });
    assert(data.status === "ok", "health email is not ok");
  });

  await step("signup", async () => {
    const data = await request("POST", "/api/user/", {
      name: "OpenTabl E2E",
      email,
      password,
      authenticate: true,
    });
    accessToken = data.access_token;
    refreshToken = data.refresh_token;
    assert(accessToken, "signup did not return an access token");
    assert(refreshToken, "signup did not return a refresh token");
    assert(data.user_session, "signup did not return a user session cookie payload");
  });

  await step("login", async () => {
    const data = await request("POST", "/api/user/token-auth/", { email, password });
    accessToken = data.access_token;
    refreshToken = data.refresh_token;
    assert(accessToken, "login did not return an access token");
    assert(refreshToken, "login did not return a refresh token");
    assert(data.user_session, "login did not return a user session cookie payload");
  });

  await step("token verify and refresh", async () => {
    const verified = await request(
      "POST",
      "/api/user/token-verify/",
      { refresh_token: refreshToken },
      { auth: false }
    );
    assert(verified.email === email, "refresh token verification returned the wrong user");
    assert(await refreshAccessToken(), "refresh token did not issue a new access token");
  });

  await step("auth provider and SSO public contracts", async () => {
    const options = await request("GET", "/api/auth-provider/login-options/", undefined, { headers: {}, auth: false });
    assert(options.password?.type === "password", "login options must expose password provider");
    assert(typeof options.password.allow_new_signups === "boolean", "password login options must expose signup flag");
    assert(typeof options.password.allow_reset_password === "boolean", "password login options must expose reset flag");

    const samlLoginUrl = await request(
      "GET",
      "/api/sso/saml/login-url/?email=smoke-no-provider@example.invalid&original=/dashboard",
      undefined,
      { allowError: true, auth: false }
    );
    if (samlLoginUrl.status === 200) {
      assert(
        String(samlLoginUrl.data?.redirect_url || "").includes("/api/sso/saml/login/"),
        "SAML login-url response must point to the backend SAML login endpoint"
      );
    } else {
      assert(samlLoginUrl.status === 400, "SAML login-url without matching provider must return 400");
      assert(samlLoginUrl.data?.error === "ERROR_SAML_INVALID_LOGIN_REQUEST", "SAML login-url error code mismatch");
    }

    const samlLogin = await rawRequest(
      "GET",
      "/api/sso/saml/login/?email=smoke-no-provider@example.invalid&original=/dashboard",
      undefined,
      { auth: false }
    );
    assert(samlLogin.status === 302, "SAML login without provider must redirect to login error");
    assert((samlLogin.headers.get("location") || "").includes("error=errorInvalidSamlRequest"), "SAML login error redirect code mismatch");

    const oauthLogin = await rawRequest("GET", "/api/sso/oauth2/login/0/?original=/dashboard", undefined, { auth: false });
    assert(oauthLogin.status === 302, "OAuth2 login without provider must redirect to login error");
    assert((oauthLogin.headers.get("location") || "").includes("error=errorProviderDoesNotExist"), "OAuth2 login error redirect code mismatch");
  });

  const workspace = await step("create workspace", () =>
    request("POST", "/api/workspaces/", { name: `E2E workspace ${stamp}` })
  );
  assert(workspace.id, "workspace id missing");
  cleanupWorkspaceId = workspace.id;
  assert(Array.isArray(workspace.users), "created workspace users must be an array");
  assert(workspace.users.length >= 1, "created workspace must include current user");

  await step("workspace members dashboard data", async () => {
    const list = await request("GET", "/api/workspaces/");
    const listedWorkspace = list.find((item) => item.id === workspace.id);
    assert(listedWorkspace, "workspace list does not include created workspace");
    assert(Array.isArray(listedWorkspace.users), "listed workspace users must be an array");
    assert(Array.isArray(listedWorkspace.applications), "listed workspace applications must be an array");

    const detail = await request("GET", `/api/workspaces/${workspace.id}/`);
    assert(Array.isArray(detail.users), "workspace detail users must be an array");
    assert(detail.users.length >= 1, "workspace detail must include current user");
    assert(detail.users.every((user) => typeof user.two_factor_auth === "boolean"), "workspace users must include 2FA status");

    const members = await request("GET", `/api/workspaces/users/workspace/${workspace.id}/`);
    assert(Array.isArray(members), "workspace members endpoint must return an array");
    assert(members.length >= 1, "workspace members endpoint must include current user");
    assert(members.every((user) => typeof user.two_factor_auth === "boolean"), "workspace members must include 2FA status");

    const permissions = await request("GET", `/api/workspaces/${workspace.id}/permissions/`);
    assert(Array.isArray(permissions), "workspace permissions must be an array");
  });

  await step("generative settings", async () => {
    const updated = await request("PATCH", `/api/workspaces/${workspace.id}/settings/generative-ai/`, {
      openai: { api_key: "", organization: "", base_url: "", models: ["smoke-test-model"] },
    });
    assert(
      Array.isArray(updated.generative_ai_models_enabled?.openai) &&
        updated.generative_ai_models_enabled.openai.includes("smoke-test-model"),
      "workspace response did not expose enabled generative AI models"
    );
    const data = await request("GET", `/api/workspaces/${workspace.id}/settings/generative-ai/`);
    assert(Array.isArray(data.openai?.models), "generative settings were not persisted");
    assert(data.openai.models.includes("smoke-test-model"), "generative model list was not persisted");
  });

  await step("enterprise assistant chat contracts", async () => {
    const chatUuid = crypto.randomUUID();
    const initialChats = await request("GET", `/assistant/chat/?workspace_id=${workspace.id}`);
    assert(Array.isArray(initialChats.results), "assistant chat list must be paginated");

    const response = await rawRequest("POST", `/assistant/chat/${chatUuid}/messages/`, {
      content: "Create a concise smoke response",
      ui_context: {
        workspace: { id: workspace.id, name: workspace.name },
        timezone: "Europe/Zurich",
      },
    });
    assert(response.ok, "assistant message stream did not return 2xx");
    assert((response.headers.get("content-type") || "").includes("text/event-stream"), "assistant response must be text/event-stream");
    const events = parseEventStream(await response.text());
    assert(events[0]?.type === "ai/started", "assistant stream missing ai/started");
    assert(events.some((event) => event.type === "ai/thinking"), "assistant stream missing ai/thinking");
    assert(events.some((event) => event.type === "ai/error" || event.type === "ai/message"), "assistant stream missing final event");

    const messages = await request("GET", `/assistant/chat/${chatUuid}/messages/`);
    assert(messages.messages?.[0]?.type === "human", "assistant history must include human message");
    assert(messages.messages[0].content === "Create a concise smoke response", "assistant human message content mismatch");

    const feedback = await request("PUT", `/assistant/messages/${messages.messages[0].id}/feedback/`, {
      sentiment: "LIKE",
    }, { allowError: true });
    assert(feedback.status === 400, "assistant feedback on human-only message must be rejected");
    assert(feedback.data?.error === "ERROR_CANNOT_SUBMIT_MESSAGE_FEEDBACK", "assistant feedback error code mismatch");

    const cancel = await rawRequest("DELETE", `/assistant/chat/${chatUuid}/cancel/`);
    assert(cancel.status === 204, "assistant cancel must return 204");
  });

  await step("user files upload and url import", async () => {
    const png = bytes("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=");
    const form = new FormData();
    form.append("file", new Blob([png], { type: "image/png" }), "Smoke image file.png");
    const uploaded = await request("POST", "/api/user-files/upload-file/", form);
    uploadedSmokeFile = uploaded;
    assert(uploaded.original_name === "Smoke image file.png", "uploaded file original name was not preserved");
    assert(uploaded.visible_name === undefined, "upload response must not expose the file-cell visible_name property");
    assert(uploaded.mime_type === "image/png", "uploaded image mime type mismatch");
    assert(uploaded.is_image === true, "uploaded image was not detected as image");
    assert(uploaded.image_width === 1 && uploaded.image_height === 1, "uploaded image dimensions were not detected");
    assertSecureFileObject(uploaded, "uploaded image");
    await assertReadableImageThumbnails(uploaded, "uploaded image");

    const head = await fetch(uploaded.url, { method: "HEAD" });
    assert(head.ok, "uploaded media URL was not readable");
    assert(head.headers.get("content-type") === "image/png", "uploaded media content type mismatch");
    assert(head.headers.get("accept-ranges") === "bytes", "uploaded media HEAD must advertise byte ranges");

    const range = await fetch(uploaded.url, { headers: { Range: "bytes=0-3" } });
    assert(range.status === 206, "uploaded media byte range did not return 206");
    assert((range.headers.get("content-range") || "").startsWith("bytes 0-3/"), "uploaded media byte range Content-Range mismatch");
    assert((await range.arrayBuffer()).byteLength === 4, "uploaded media byte range body length mismatch");

    const mirroredUrl = `${baseUrl}/api/user-files/${uploaded.name}`;
    const mirroredHead = await fetch(mirroredUrl, { method: "HEAD" });
    assert(mirroredHead.ok, "uploaded /api/user-files HEAD was not readable");
    assert(mirroredHead.headers.get("accept-ranges") === "bytes", "uploaded /api/user-files HEAD must advertise byte ranges");
    const mirroredRange = await fetch(mirroredUrl, { headers: { Range: "bytes=0-3" } });
    assert(mirroredRange.status === 206, "uploaded /api/user-files byte range did not return 206");
    assert((mirroredRange.headers.get("content-range") || "").startsWith("bytes 0-3/"), "uploaded /api/user-files byte range Content-Range mismatch");
    assert((await mirroredRange.arrayBuffer()).byteLength === 4, "uploaded /api/user-files byte range body length mismatch");

    const imported = await request("POST", "/api/user-files/upload-via-url/", { url: uploaded.url, name: "Copied image.png" });
    assert(imported.original_name === "Copied image.png", "upload via URL original name mismatch");
    assert(imported.visible_name === undefined, "URL upload response must not expose the file-cell visible_name property");
    assert(imported.image_width === 1 && imported.image_height === 1, "upload via URL image dimensions were not detected");
    assertSecureFileObject(imported, "upload via URL image");
    await assertReadableImageThumbnails(imported, "upload via URL image");
  });

  const app = await step("create database application", () =>
    request("POST", `/api/applications/workspace/${workspace.id}/`, { name: "E2E database", type: "database" })
  );
  assert(app.id, "application id missing");
  let dataSyncSmoke = null;
  let documentSmoke = null;
  let dashboardSmoke = null;
  let dateDependencySmoke = null;

  const table = await step("create table", () =>
    request("POST", `/api/database/tables/database/${app.id}/`, { name: "E2E table" })
  );
  assert(table.id && table.fields?.length && table.views?.length, "table shape is incomplete");

  await step("realtime authentication subscriptions permissions and rows", async () => {
    const realtime = await openRealtimeConnection();
    try {
      const authentication = await realtime.waitFor(
        (message) => message.type === "authentication",
        "authentication",
      );
      assert(authentication.success === true, "realtime authentication was rejected");
      assert(authentication.web_socket_id, "realtime authentication did not return a web socket id");

      realtime.socket.send(JSON.stringify({ page: "table", table_id: table.id }));
      const pageAdd = await realtime.waitFor(
        (message) => message.type === "page_add" && message.parameters?.table_id === table.id,
        "page_add",
      );
      assert(pageAdd.page === "table", "realtime table subscription confirmation is invalid");

      const currentUser = workspace.users.find((item) => item.email === email) || workspace.users[0];
      const team = await request("POST", `/api/teams/workspace/${workspace.id}/`, {
        name: `Realtime team ${stamp}`,
        default_role_uid: "VIEWER",
        subjects: [{ subject_id: currentUser.user_id, subject_type: "auth.User" }],
      });
      await realtime.waitFor(
        (message) => message.type === "permissions_updated" && message.workspace_id === workspace.id,
        "permissions_updated",
      );
      await request("DELETE", `/api/teams/${team.id}/`);

      const primaryField = table.fields.find((field) => field.primary) || table.fields[0];
      const row = await request("POST", `/api/database/rows/table/${table.id}/`, {
        [`field_${primaryField.id}`]: "Realtime smoke row",
      });
      const rowsCreated = await realtime.waitFor(
        (message) => message.type === "rows_created" && message.rows?.some((item) => item.id === row.id),
        "rows_created",
      );
      assert(rowsCreated.table_id === table.id, "realtime row event has the wrong table id");
      await request("DELETE", `/api/database/rows/table/${table.id}/${row.id}/`);
    } finally {
      realtime.socket.close();
    }
  });

  await step("enterprise teams roles and field permission contracts", async () => {
    const currentUser = workspace.users.find((item) => item.email === email) || workspace.users[0];
    const userId = currentUser?.user_id;
    const primaryField = table.fields.find((item) => item.primary) || table.fields[0];
    assert(userId, "workspace user id missing for enterprise team subject");
    assert(primaryField?.id, "primary field missing for field permission contract");

    const team = await request("POST", `/api/teams/workspace/${workspace.id}/`, {
      name: `Enterprise smoke team ${stamp}`,
      default_role_uid: "EDITOR",
      subjects: [{ subject_id: userId, subject_type: "auth.User" }],
    });
    assert(team.id, "enterprise team id missing");
    assert(team.default_role === "EDITOR" && team.default_role_uid === "EDITOR", "enterprise team default role mismatch");
    assert(team.subject_count === 1, "enterprise team subject count mismatch");
    assert(team.subject_sample?.[0]?.subject_id === userId, "enterprise team subject sample missing user");

    const subjects = await request("GET", `/api/teams/${team.id}/subjects/`);
    assert(subjects.length === 1, "enterprise team subjects endpoint did not return the created subject");
    assert(subjects[0].team === team.id && subjects[0].subject_id === userId, "enterprise team subject shape mismatch");

    const subjectByEmail = await request("POST", `/api/teams/${team.id}/subjects/`, {
      subject_user_email: email,
      subject_type: "auth.User",
    });
    assert(subjectByEmail.team === team.id && subjectByEmail.subject_id === userId, "enterprise team subject email lookup mismatch");

    const searchedTeams = await request("GET", `/api/teams/workspace/${workspace.id}/?search=Enterprise%20smoke`);
    assert(searchedTeams.length === 1 && searchedTeams[0].id === team.id, "enterprise team search did not filter by name");

    const sortedTeams = await request("GET", `/api/teams/workspace/${workspace.id}/?sorts=-subject_sample`);
    assert(sortedTeams[0].id === team.id, "enterprise team subject_sample sort did not return the populated team first");

    const assignment = await request("POST", `/api/role/${workspace.id}/`, {
      subject_id: team.id,
      subject_type: "baserow_enterprise.Team",
      scope_id: workspace.id,
      scope_type: "workspace",
      role: "BUILDER",
    });
    assert(assignment.role === "BUILDER", "enterprise role assignment role mismatch");
    assert(assignment.subject?.id === team.id && assignment.subject?.subject_count === 1, "enterprise role assignment subject shape mismatch");

    const assignments = await request("GET", `/api/role/${workspace.id}/?scope_id=${workspace.id}&scope_type=workspace`);
    assert(
      assignments.some((item) => item.subject_id === userId && item.subject_type === "auth.User" && item.role === "ADMIN"),
      "enterprise workspace role list missing the workspace user assignment"
    );
    assert(
      !assignments.some((item) => item.subject_type === "baserow_enterprise.Team"),
      "enterprise workspace role list must use Baserow workspace-user assignments only"
    );
    const updatedTeam = await request("GET", `/api/teams/${team.id}/`);
    assert(updatedTeam.default_role === "BUILDER", "enterprise team role assignment did not update the team default role");

    const removed = await rawRequest("POST", `/api/role/${workspace.id}/`, {
      subject_id: team.id,
      subject_type: "baserow_enterprise.Team",
      scope_id: workspace.id,
      scope_type: "workspace",
      role: null,
    });
    assert(removed.status === 204, "enterprise role removal must return 204");

    const defaultPermission = await request("GET", `/api/field-permissions/${primaryField.id}/`);
    assert(defaultPermission.role === "EDITOR", "default field permission role mismatch");
    assert(defaultPermission.can_write_values === true, "default field permission write flag mismatch");

    const lockedPermission = await request("PATCH", `/api/field-permissions/${primaryField.id}/`, {
      role: "NOBODY",
      allow_in_forms: false,
    });
    assert(lockedPermission.role === "NOBODY", "field permission NOBODY role was not stored");
    assert(lockedPermission.can_write_values === false, "field permission NOBODY must disable writes");
    assert(lockedPermission.allow_in_forms === false, "field permission allow_in_forms was not stored");
  });

  await step("change primary field contracts", async () => {
    const primaryTable = await request("POST", `/api/database/tables/database/${app.id}/`, { name: "Primary contracts" });
    const oldPrimary = primaryTable.fields.find((item) => item.primary);
    assert(oldPrimary?.id, "primary contract table initial primary field missing");
    const numberField = await request("POST", `/api/database/fields/table/${primaryTable.id}/`, {
      name: "Primary number",
      type: "number",
      number_decimal_places: 0,
    });
    const changed = await request("POST", `/api/database/fields/table/${primaryTable.id}/change-primary-field/`, {
      new_primary_field_id: numberField.id,
    });
    assert(changed.primary === true, "changed primary field was not marked primary");
    assert(changed.related_fields?.[0]?.id === oldPrimary.id, "changed primary response missing old primary related field");
    assert(changed.related_fields[0].primary === false, "old primary related field was not marked non-primary");
    const duplicatePrimary = await request("POST", `/api/database/fields/table/${primaryTable.id}/change-primary-field/`, {
      new_primary_field_id: numberField.id,
    }, { allowError: true });
    assert(duplicatePrimary.status === 400, "changing to an already primary field did not return 400");
    assert(duplicatePrimary.data?.error === "ERROR_FIELD_IS_ALREADY_PRIMARY", "already primary error code mismatch");
    const passwordField = await request("POST", `/api/database/fields/table/${primaryTable.id}/`, {
      name: "Primary secret",
      type: "password",
    });
    const incompatible = await request("POST", `/api/database/fields/table/${primaryTable.id}/change-primary-field/`, {
      new_primary_field_id: passwordField.id,
    }, { allowError: true });
    assert(incompatible.status === 400, "incompatible primary field type did not return 400");
    assert(incompatible.data?.error === "ERROR_INCOMPATIBLE_PRIMARY_FIELD_TYPE", "incompatible primary field type error code mismatch");
  });

  await step("delete field returns dependent related fields", async () => {
    const dependencyTable = await request("POST", `/api/database/tables/database/${app.id}/`, { name: "Delete dependencies" });
    const sourceField = await request("POST", `/api/database/fields/table/${dependencyTable.id}/`, {
      name: "Delete source",
      type: "number",
      number_decimal_places: 0,
    });
    const formulaField = await request("POST", `/api/database/fields/table/${dependencyTable.id}/`, {
      name: "Delete formula",
      type: "formula",
      formula: `CONCAT({${sourceField.name}}, " gone")`,
      formula_type: "text",
    });
    const deleted = await request("DELETE", `/api/database/fields/${sourceField.id}/`);
    const related = deleted.related_fields || [];
    assert(related.some((field) =>
      field.id === formulaField.id &&
      field.formula_type === "invalid" &&
      String(field.formula_type_error || "").includes(sourceField.name)
    ), "field delete did not return the dependent formula field as invalid");
  });

  await step("rename field updates dependent formula references", async () => {
    const renameTable = await request("POST", `/api/database/tables/database/${app.id}/`, { name: "Rename dependencies" });
    const sourceField = await request("POST", `/api/database/fields/table/${renameTable.id}/`, {
      name: "Rename source",
      type: "number",
      number_decimal_places: 0,
    });
    const formulaField = await request("POST", `/api/database/fields/table/${renameTable.id}/`, {
      name: "Rename formula",
      type: "formula",
      formula: `CONCAT({${sourceField.name}}, field("${sourceField.name}"))`,
      formula_type: "text",
    });
    const renamed = await request("PATCH", `/api/database/fields/${sourceField.id}/`, {
      name: "Renamed source",
    });
    const relatedFormula = (renamed.related_fields || []).find((field) => field.id === formulaField.id);
    assert(relatedFormula?.formula === 'CONCAT({Renamed source}, field("Renamed source"))', "field rename did not update dependent formula references");
  });

  await step("field type change recalculates dependent formula types", async () => {
    const typeTable = await request("POST", `/api/database/tables/database/${app.id}/`, { name: "Type dependencies" });
    const sourceField = await request("POST", `/api/database/fields/table/${typeTable.id}/`, {
      name: "Type source",
      type: "number",
      number_decimal_places: 0,
    });
    const formulaField = await request("POST", `/api/database/fields/table/${typeTable.id}/`, {
      name: "Type formula",
      type: "formula",
      formula: `{${sourceField.name}}`,
      formula_type: "number",
    });
    const changed = await request("PATCH", `/api/database/fields/${sourceField.id}/`, {
      type: "boolean",
    });
    const relatedFormula = (changed.related_fields || []).find((field) => field.id === formulaField.id);
    assert(relatedFormula?.formula_type === "boolean", "field type change did not recalculate dependent formula type");
    assert(relatedFormula?.formula_type_error === null, "field type change left a dependent formula error");
  });

  await step("field conversion source fixtures", async () => {
    const conversionTable = await request("POST", `/api/database/tables/database/${app.id}/`, { name: "Field conversions" });
    const primary = conversionTable.fields.find((item) => item.primary) || conversionTable.fields[0];
    const convertedNumber = await request("POST", `/api/database/fields/table/${conversionTable.id}/`, {
      name: "Converted number",
      type: "text",
    });
    const convertedDate = await request("POST", `/api/database/fields/table/${conversionTable.id}/`, {
      name: "Converted date",
      type: "text",
    });
    const convertedUuid = await request("POST", `/api/database/fields/table/${conversionTable.id}/`, {
      name: "Converted UUID",
      type: "text",
    });
    const precision = await request("POST", `/api/database/fields/table/${conversionTable.id}/`, {
      name: "Precision",
      type: "number",
      number_decimal_places: 3,
      number_negative: true,
    });
    const rating = await request("POST", `/api/database/fields/table/${conversionTable.id}/`, {
      name: "Rating clamp",
      type: "rating",
      max_value: 5,
    });
    await request("POST", `/api/database/rows/table/${conversionTable.id}/batch/`, {
      items: [
        {
          [`field_${primary.id}`]: "Conversion A",
          [`field_${convertedNumber.id}`]: "100.59999",
          [`field_${convertedDate.id}`]: "22/07/2021",
          [`field_${convertedUuid.id}`]: "Row 1",
          [`field_${precision.id}`]: "4.555",
          [`field_${rating.id}`]: 5,
        },
        {
          [`field_${primary.id}`]: "Conversion B",
          [`field_${convertedNumber.id}`]: "-100",
          [`field_${convertedDate.id}`]: "INVALID",
          [`field_${convertedUuid.id}`]: "Row 2",
          [`field_${precision.id}`]: "-2.000",
          [`field_${rating.id}`]: 2,
        },
      ],
    });
    await request("PATCH", `/api/database/fields/${convertedNumber.id}/`, {
      type: "number",
      number_decimal_places: 0,
      number_negative: false,
    });
    await request("PATCH", `/api/database/fields/${convertedDate.id}/`, {
      type: "date",
      date_format: "EU",
      date_include_time: false,
      date_time_format: "24",
    });
    await request("PATCH", `/api/database/fields/${convertedUuid.id}/`, { type: "uuid" });
    await request("PATCH", `/api/database/fields/${precision.id}/`, {
      number_decimal_places: 1,
      number_negative: false,
    });
    await request("PATCH", `/api/database/fields/${rating.id}/`, { max_value: 3 });

    const convertedRows = await request("GET", `/api/database/rows/table/${conversionTable.id}/?order_by=field_${primary.id}&size=10`);
    assert(JSON.stringify(convertedRows.results.map((item) => item[`field_${convertedNumber.id}`])) === JSON.stringify(["101", "0"]), "text to number conversion did not round and clamp values");
    assert(JSON.stringify(convertedRows.results.map((item) => item[`field_${convertedDate.id}`])) === JSON.stringify(["2021-07-22", null]), "text to date conversion did not preserve EU dates and clear invalid values");
    assert(JSON.stringify(convertedRows.results.map((item) => item[`field_${precision.id}`])) === JSON.stringify(["4.6", "0.0"]), "same-type number settings did not rewrite stored values");
    assert(JSON.stringify(convertedRows.results.map((item) => item[`field_${rating.id}`])) === JSON.stringify([3, 2]), "rating max_value update did not clamp stored values");
    const uuidValues = convertedRows.results.map((item) => item[`field_${convertedUuid.id}`]);
    assert(uuidValues.every((value) => /^[0-9a-f-]{36}$/i.test(value)) && uuidValues[0] !== uuidValues[1], "text to UUID conversion did not generate distinct UUIDs");
  });

  await step("enterprise date dependency calculation and cascade", async () => {
    const planningTable = await request("POST", `/api/database/tables/database/${app.id}/`, { name: "Date dependency smoke" });
    const primary = planningTable.fields.find((item) => item.primary) || planningTable.fields[0];
    const start = await request("POST", `/api/database/fields/table/${planningTable.id}/`, {
      name: "Start",
      type: "date",
      date_format: "ISO",
      date_include_time: false,
    });
    const end = await request("POST", `/api/database/fields/table/${planningTable.id}/`, {
      name: "End",
      type: "date",
      date_format: "ISO",
      date_include_time: false,
    });
    const duration = await request("POST", `/api/database/fields/table/${planningTable.id}/`, {
      name: "Duration",
      type: "duration",
      duration_format: "d h",
    });
    const predecessors = await request("POST", `/api/database/fields/table/${planningTable.id}/`, {
      name: "Predecessors",
      type: "link_row",
      link_row_table_id: planningTable.id,
      has_related_field: false,
    });
    const rule = await request("POST", `/api/database/field-rules/${planningTable.id}/`, {
      type: "date_dependency",
      is_active: true,
      start_date_field_id: start.id,
      end_date_field_id: end.id,
      duration_field_id: duration.id,
      dependency_linkrow_field_id: predecessors.id,
    });
    assert(rule.is_active === true && rule.is_valid === true, "date dependency rule was not created as valid");

    const createTask = (name, startValue, endValue, predecessorIds = []) => request(
      "POST",
      `/api/database/rows/table/${planningTable.id}/`,
      {
        [`field_${primary.id}`]: name,
        [`field_${start.id}`]: startValue,
        [`field_${end.id}`]: endValue,
        [`field_${duration.id}`]: 259200,
        [`field_${predecessors.id}`]: predecessorIds,
      }
    );
    const parent = await createTask("Parent", "2026-07-01", "2026-07-03");
    const child = await createTask("Child", "2026-07-03", "2026-07-05", [parent.id]);
    const grandchild = await createTask("Grandchild", "2026-07-04", "2026-07-06", [child.id]);
    await request("PATCH", `/api/database/rows/table/${planningTable.id}/${parent.id}/`, {
      [`field_${end.id}`]: "2026-07-04",
    });
    const shiftedChild = await request("GET", `/api/database/rows/table/${planningTable.id}/${child.id}/`);
    const shiftedGrandchild = await request("GET", `/api/database/rows/table/${planningTable.id}/${grandchild.id}/`);
    assert(shiftedChild[`field_${start.id}`] === "2026-07-05" && shiftedChild[`field_${end.id}`] === "2026-07-07", "date dependency child was not shifted");
    assert(shiftedGrandchild[`field_${start.id}`] === "2026-07-08" && shiftedGrandchild[`field_${end.id}`] === "2026-07-10", "date dependency cascade did not reach the grandchild");

    await request("PATCH", `/api/database/fields/${duration.id}/`, { duration_format: "h:mm" });
    const rules = await request("GET", `/api/database/field-rules/${planningTable.id}/`);
    assert(rules[0]?.is_valid === false && rules[0]?.error_text?.includes("duration format"), "date dependency rule was not invalidated after an incompatible field update");
    dateDependencySmoke = { table: planningTable, start, end, duration, predecessors };
  });

  const fields = [];
  await step("create all writable field types", async () => {
    for (const [, payload] of writableFieldPayloads) {
      const field = await request("POST", `/api/database/fields/table/${table.id}/`, payload);
      assert(field.id, `field not created: ${payload.type}`);
      fields.push(field);
    }
    const textField = fields.find((item) => item.type === "text");
    const fileField = fields.find((item) => item.type === "file");
    const aiFieldIndex = fields.findIndex((item) => item.type === "ai");
    const configuredAI = await request("PATCH", `/api/database/fields/${fields[aiFieldIndex].id}/`, {
      ai_prompt: `CONCAT('Summary ', get('fields.field_${textField.id}'))`,
      ai_file_field_id: fileField.id,
    });
    fields[aiFieldIndex] = configuredAI;
  });

  const values = {};
  const currentUser = workspace.users.find((item) => item.email === email) || workspace.users[0];
  const currentUserId = currentUser?.user_id;
  assert(currentUserId, "workspace user id missing for collaborator field");
  for (const [type, , value] of writableFieldPayloads) {
    const field = fields.find((item) => item.type === type);
    if (type === "single_select") {
      values[`field_${field.id}`] = field.select_options[0];
    } else if (type === "multiple_select") {
      values[`field_${field.id}`] = [field.select_options[0]];
    } else if (type === "multiple_collaborators") {
      values[`field_${field.id}`] = [currentUserId];
    } else {
      values[`field_${field.id}`] = value;
    }
  }

  const row = await step("create row", () =>
    request("POST", `/api/database/rows/table/${table.id}/`, values)
  );
  assert(row.id, "row id missing");
  const collaboratorField = fields.find((item) => item.type === "multiple_collaborators");
  assert(row[`field_${collaboratorField.id}`]?.[0]?.id === currentUserId, "multiple collaborators cell did not resolve current user");
  assert(row[`field_${collaboratorField.id}`]?.[0]?.email === undefined, "multiple collaborators cell exposed non-Baserow email metadata");
  const durationField = fields.find((item) => item.type === "duration");
  assert(row[`field_${durationField.id}`] === 5400, "duration cell did not parse Baserow h:mm input");
  const booleanField = fields.find((item) => item.type === "boolean");
  assert(row[`field_${booleanField.id}`] === false, "boolean cell did not parse Baserow false string input");
  const numberField = fields.find((item) => item.type === "number");
  assert(row[`field_${numberField.id}`] === "1234.50", "number cell did not parse Baserow formatted numeric string input");
  const ratingField = fields.find((item) => item.type === "rating");
  assert(row[`field_${ratingField.id}`] === 4, "rating cell did not parse Baserow integer string input");
  const dateField = fields.find((item) => item.type === "date");
  assert(row[`field_${dateField.id}`] === "2026-05-21", "date cell did not parse Baserow EU date string input");

  await step("update row", async () => {
    const textField = fields.find((item) => item.type === "text");
    const patched = await request("PATCH", `/api/database/rows/table/${table.id}/${row.id}/`, {
      [`field_${textField.id}`]: "updated smoke",
    });
    assert(patched[`field_${textField.id}`] === "updated smoke", "row update did not return updated value");
    const fetched = await request("GET", `/api/database/rows/table/${table.id}/${row.id}/`);
    assert(fetched[`field_${textField.id}`] === "updated smoke", "row update was not persisted");
  });

  await step("table import async upsert configuration", async () => {
    const importTable = await request("POST", `/api/database/tables/database/${app.id}/`, { name: "Import upsert smoke" });
    const importPrimary = importTable.fields.find((item) => item.primary) || importTable.fields[0];
    const notesField = await request("POST", `/api/database/fields/table/${importTable.id}/`, {
      name: "Import notes",
      type: "text",
    });
    const seeded = await request("POST", `/api/database/rows/table/${importTable.id}/`, {
      [`field_${importPrimary.id}`]: "key-1",
      [`field_${notesField.id}`]: "keep me",
    });
    const orderedFields = await request("GET", `/api/database/fields/table/${importTable.id}/`);
    const existingImportRow = orderedFields.map((field) => {
      if (field.id === importPrimary.id) return "key-1";
      if (field.id === notesField.id) return "must not overwrite";
      return "";
    });
    const createdImportRow = orderedFields.map((field) => {
      if (field.id === importPrimary.id) return "key-2";
      if (field.id === notesField.id) return "created value";
      return "";
    });
    const job = await request("POST", `/api/database/tables/${importTable.id}/import/async/`, {
      data: [existingImportRow, createdImportRow],
      configuration: {
        upsert_fields: [importPrimary.id],
        upsert_values: [["key-1"], ["key-2"]],
        skipped_fields: [notesField.id],
      },
    });
    assert(job.state === "finished", "table import upsert job did not finish");
    assert(job.rows_created === 1, "table import upsert did not create exactly one row");
    assert(job.rows_updated === 1, "table import upsert did not update exactly one row");

    const fetched = await request("GET", `/api/database/rows/table/${importTable.id}/${seeded.id}/`);
    assert(fetched[`field_${notesField.id}`] === "keep me", "table import upsert ignored field was overwritten");
    const listed = await request("GET", `/api/database/rows/table/${importTable.id}/?search=key-2&size=10`);
    assert(listed.results?.some((item) => item[`field_${importPrimary.id}`] === "key-2" && item[`field_${notesField.id}`] === "created value"), "table import upsert did not create the new keyed row");
  });

  await step("file cell name hydration", async () => {
    const fileField = fields.find((item) => item.type === "file");
    const renamed = "Renamed smoke image.png";
    const png = bytes("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=");
    const form = new FormData();
    form.append("file", new Blob([png], { type: "image/png" }), "Hydration smoke image.png");
    const hydrationFile = await request("POST", "/api/user-files/upload-file/", form);

    const invalidName = await request("PATCH", `/api/database/rows/table/${table.id}/${row.id}/`, {
      [`field_${fileField.id}`]: [{ name: "invalid.png" }],
    }, { allowError: true });
    assert(invalidName.status === 400 && invalidName.data?.error === "ERROR_INVALID_USER_FILE_NAME_ERROR", "invalid user file name was not rejected");
    const missingFile = await request("PATCH", `/api/database/rows/table/${table.id}/${row.id}/`, {
      [`field_${fileField.id}`]: [{ name: "missing_hash.png" }],
    }, { allowError: true });
    assert(missingFile.status === 400 && missingFile.data?.error === "ERROR_USER_FILE_DOES_NOT_EXIST", "missing user file was not rejected");

    const csvPatched = await request("PATCH", `/api/database/rows/table/${table.id}/${row.id}/`, {
      [`field_${fileField.id}`]: hydrationFile.name,
    });
    assert(csvPatched[`field_${fileField.id}`]?.[0]?.visible_name === hydrationFile.original_name, "file CSV name input was not hydrated");
    const patched = await request("PATCH", `/api/database/rows/table/${table.id}/${row.id}/`, {
      [`field_${fileField.id}`]: [{ name: hydrationFile.name, visible_name: renamed }],
    });
    const cell = patched[`field_${fileField.id}`]?.[0];
    assert(cell?.name === hydrationFile.name, "file cell did not keep stored file name");
    assert(cell?.visible_name === renamed, "file cell did not keep visible rename");
    if (expectSecureFileServe) {
      assertSecureFileObject(cell, "hydrated file cell");
    } else {
      assert(cell?.url === hydrationFile.url, "file cell was not hydrated with media URL");
    }
    assert(cell?.mime_type === "image/png", "file cell was not hydrated with mime type");
    assert(cell?.is_image === true, "file cell was not hydrated with image flag");
    assert(cell?.image_width === 1 && cell?.image_height === 1, "file cell was not hydrated with dimensions");
    await assertReadableImageThumbnails(cell, "file cell");

    const fetched = await request("GET", `/api/database/rows/table/${table.id}/${row.id}/`);
    assert(fetched[`field_${fileField.id}`]?.[0]?.visible_name === renamed, "hydrated file cell was not persisted");
  });

  await step("data sync local baserow table lifecycle", async () => {
    const textField = fields.find((item) => item.type === "text");
    const singleSelectField = fields.find((item) => item.type === "single_select");
    const multipleSelectField = fields.find((item) => item.type === "multiple_select");
    const fileField = fields.find((item) => item.type === "file");
    assert(textField?.id && singleSelectField?.id && multipleSelectField?.id && fileField?.id, "data sync source fields missing");

    const propertyBody = {
      type: "local_baserow_table",
      source_table_id: table.id,
    };
    const properties = await request("POST", "/api/database/data-sync/properties/", propertyBody);
    const propertyByKey = new Map(properties.map((item) => [item.key, item]));
    assert(propertyByKey.get("id")?.unique_primary === true, "data sync properties missing unique primary id");
    assert(propertyByKey.get(`field_${textField.id}`)?.field_type === "text", "data sync properties missing text source field");
    assert(propertyByKey.get(`field_${singleSelectField.id}`)?.field_type === "single_select", "data sync properties missing single select source field");
    assert(!propertyByKey.has(`field_${multipleSelectField.id}`), "data sync properties exposed unsupported multiple select source field");
    assert(propertyByKey.get(`field_${fileField.id}`)?.field_type === "file", "data sync properties missing file source field");
    assert(
      propertyByKey.get(`field_${singleSelectField.id}`)?.select_options?.some((option) => option.value === "A"),
      "data sync properties did not preserve single select options"
    );

    const syncedTable = await request("POST", `/api/database/data-sync/database/${app.id}/`, {
      type: "local_baserow_table",
      table_name: "E2E local sync",
      source_table_id: table.id,
      synced_properties: [
        `field_${textField.id}`,
        `field_${singleSelectField.id}`,
        `field_${fileField.id}`,
      ],
      auto_add_new_properties: true,
      periodic_interval: "hour",
      periodic_interval_count: 1,
    });
    assert(syncedTable.id && syncedTable.data_sync?.id, "data sync table creation did not return a synced table");
    assert(syncedTable.data_sync.type === "local_baserow_table", "data sync table type mismatch");
    assert(syncedTable.data_sync.two_way_sync === false, "unsupported data sync two-way mode must default to disabled");
    assert(syncedTable.data_sync.periodic_interval === "hour", "data sync periodic interval was not stored");

    const dataSyncId = syncedTable.data_sync.id;
    const fetchedDataSync = await request("GET", `/api/database/data-sync/${dataSyncId}/`);
    assert(fetchedDataSync.synced_properties?.some((item) => item.key === `field_${textField.id}`), "data sync detail missing synced text property");
    assert(fetchedDataSync.source_table_id === table.id, "data sync detail missing the serialized source table id");
    assert(fetchedDataSync.source_table_view_id === null, "data sync detail source view default mismatch");
    const fetchedProperties = await request("GET", `/api/database/data-sync/${dataSyncId}/properties/`);
    assert(fetchedProperties.some((item) => item.key === `field_${fileField.id}`), "data sync properties endpoint did not inspect the saved source");

    const initialPeriodicInterval = await request("GET", `/api/database/data-sync/${dataSyncId}/periodic-interval/`);
    assert(initialPeriodicInterval.interval === "HOURLY", "enterprise periodic data sync interval did not expose HOURLY");
    assert(initialPeriodicInterval.when === "00:00:00", "enterprise periodic data sync default time mismatch");
    assert(initialPeriodicInterval.automatically_deactivated === false, "enterprise periodic data sync returned deactivated by default");
    const savedPeriodicInterval = await request("PATCH", `/api/database/data-sync/${dataSyncId}/periodic-interval/`, {
      interval: "DAILY",
      when: "12:10:01.000001",
    });
    assert(savedPeriodicInterval.interval === "DAILY", "enterprise periodic data sync interval was not saved");
    assert(savedPeriodicInterval.when === "12:10:01.000001", "enterprise periodic data sync time was not saved");
    assert(savedPeriodicInterval.automatically_deactivated === false, "enterprise periodic data sync did not reactivate on save");

    const patchedDataSync = await request("PATCH", `/api/database/data-sync/${dataSyncId}/`, {
      auto_add_new_properties: false,
      periodic_interval: "day",
      periodic_interval_count: 2,
    });
    assert(patchedDataSync.auto_add_new_properties === false, "data sync update did not persist auto_add_new_properties");
    assert(patchedDataSync.periodic_interval === "day" && patchedDataSync.periodic_interval_count === 2, "data sync update did not persist periodic settings");
    assert(patchedDataSync.next_periodic_sync, "data sync update did not compute next periodic sync");

    const syncJob = await request("POST", `/api/database/data-sync/${dataSyncId}/sync/async/`);
    assert(syncJob.state === "pending" && syncJob.type === "sync_data_sync_table", "data sync sync job was not queued");
    const finishedSyncJob = await pollJob(syncJob, "data sync sync");
    assert(finishedSyncJob.result?.imported_count >= 1 || finishedSyncJob.imported_count >= 1, "data sync sync job did not import rows");

    const syncedFields = await request("GET", `/api/database/fields/table/${syncedTable.id}/`);
    const syncedByName = new Map(syncedFields.map((item) => [item.name, item]));
    const syncedTextField = syncedByName.get(textField.name);
    const syncedSingleSelectField = syncedByName.get(singleSelectField.name);
    const syncedFileField = syncedByName.get(fileField.name);
    assert(syncedTextField?.read_only === true, "data sync text field was not marked read-only");
    assert(syncedSingleSelectField?.select_options?.some((option) => option.value === "A"), "data sync single select options were not copied");

    const syncedRows = await request("GET", `/api/database/rows/table/${syncedTable.id}/?size=1000`);
    const syncedRow = syncedRows.results.find((item) => item[`field_${syncedTextField.id}`] === "updated smoke");
    assert(syncedRow?.id, "data sync rows did not include the source row text value");
    assert(syncedRow[`field_${syncedSingleSelectField.id}`]?.value === "A", "data sync single select value was not synchronized");
    assert(!syncedByName.has(multipleSelectField.name), "data sync created an unsupported multiple select destination field");
    assert(syncedRow[`field_${syncedFileField.id}`]?.[0]?.visible_name === "Renamed smoke image.png", "data sync file value was not synchronized");

    const attemptedPatch = await request("PATCH", `/api/database/rows/table/${syncedTable.id}/${syncedRow.id}/`, {
      [`field_${syncedTextField.id}`]: "should not overwrite synced data",
    });
    assert(attemptedPatch[`field_${syncedTextField.id}`] === "updated smoke", "data sync read-only field accepted a row write");
    dataSyncSmoke = { table: syncedTable, dataSync: patchedDataSync };
  });

  await step("table webhook validation and GET test call", async () => {
    const invalid = await request("POST", `/api/database/webhooks/table/${table.id}/`, {
      name: "Invalid private webhook",
      url: "http://127.0.0.1/private",
      events: ["rows.created"],
    }, { allowError: true });
    assert(invalid.status === 400, "table webhook accepted a private destination URL");

    const webhookTarget = "https://mbza.dev/";
    const testCall = await request("POST", `/api/database/webhooks/table/${table.id}/test-call/`, {
      name: "Production GET webhook test",
      url: webhookTarget,
      request_method: "GET",
      event_type: "rows.created",
      headers: { "X-Opentabl-Smoke": "webhook-get" },
    });
    assert(testCall.status_code === 200, `table webhook GET test call returned ${testCall.status_code}`);
    assert(testCall.request.includes(`GET ${webhookTarget}`), "table webhook test call request method or URL mismatch");
    assert(testCall.request.toLowerCase().includes("x-baserow-event: rows.created"), "table webhook test call event header missing");
  });

  await step("move row order and history", async () => {
    const textField = fields.find((item) => item.type === "text");
    const moveA = await request("POST", `/api/database/rows/table/${table.id}/`, {
      ...values,
      [`field_${textField.id}`]: "move A",
    });
    const moveB = await request("POST", `/api/database/rows/table/${table.id}/`, {
      ...values,
      [`field_${textField.id}`]: "move B",
    });
    const moveC = await request("POST", `/api/database/rows/table/${table.id}/`, {
      ...values,
      [`field_${textField.id}`]: "move C",
    });
    await request("PATCH", `/api/database/rows/table/${table.id}/${moveA.id}/move/`);
    await request("PATCH", `/api/database/rows/table/${table.id}/${moveB.id}/move/`);
    await request("PATCH", `/api/database/rows/table/${table.id}/${moveC.id}/move/`);
    const moved = await request("PATCH", `/api/database/rows/table/${table.id}/${moveC.id}/move/?before_id=${moveB.id}`);
    assert(moved.id === moveC.id && moved.order > moveA.order, "row move did not return moved row with updated order");
    const list = await request("GET", `/api/database/rows/table/${table.id}/?size=1000`);
    const movedIds = list.results
      .filter((item) => [moveA.id, moveB.id, moveC.id].includes(item.id))
      .map((item) => item.id);
    assert(JSON.stringify(movedIds) === JSON.stringify([moveA.id, moveC.id, moveB.id]), "row move did not persist expected order");
    const history = await request("GET", `/api/database/rows/table/${table.id}/${moveC.id}/history/`);
    assert(history.results?.some((entry) => entry.action_type === "move_row"), "row move history entry missing");
  });

  await step("row list order_by contracts", async () => {
    const textField = fields.find((item) => item.type === "text");
    const numberField = fields.find((item) => item.type === "number");
    const orderA = await request("POST", `/api/database/rows/table/${table.id}/`, {
      ...values,
      [`field_${textField.id}`]: "Order A",
      [`field_${numberField.id}`]: 1,
    });
    const orderB = await request("POST", `/api/database/rows/table/${table.id}/`, {
      ...values,
      [`field_${textField.id}`]: "Order B",
      [`field_${numberField.id}`]: 2,
    });
    const orderC = await request("POST", `/api/database/rows/table/${table.id}/`, {
      ...values,
      [`field_${textField.id}`]: "Order C",
      [`field_${numberField.id}`]: 2,
    });
    const expectedIds = [orderA.id, orderC.id, orderB.id];
    const byIds = await request("GET", `/api/database/rows/table/${table.id}/?order_by=field_${numberField.id},-field_${textField.id}&size=1000`);
    const orderedIds = byIds.results.filter((item) => expectedIds.includes(item.id)).map((item) => item.id);
    assert(JSON.stringify(orderedIds) === JSON.stringify(expectedIds), "multi-field order_by by ids did not sort rows");

    const orderByNames = encodeURIComponent(`${numberField.name},-${textField.name}`);
    const byNames = await request("GET", `/api/database/rows/table/${table.id}/?user_field_names=true&order_by=${orderByNames}&size=1000`);
    const orderedNames = byNames.results
      .filter((item) => expectedIds.includes(item.id))
      .map((item) => item[textField.name]);
    assert(JSON.stringify(orderedNames) === JSON.stringify(["Order A", "Order C", "Order B"]), "multi-field order_by by names did not sort rows");
    assert(byNames.results.find((item) => item.id === orderA.id)?.[`field_${textField.id}`] === undefined, "user_field_names leaked raw field keys");
  });

  await step("row batch before metadata and user field names", async () => {
    const textField = fields.find((item) => item.type === "text");
    const numberField = fields.find((item) => item.type === "number");
    const batchBase = await request("POST", `/api/database/rows/table/${table.id}/batch/`, {
      items: [
        { [`field_${textField.id}`]: "Before base one" },
        { [`field_${textField.id}`]: "Before base two" },
        { [`field_${textField.id}`]: "Before base three" },
      ],
    });
    const [baseOne, baseTwo, baseThree] = batchBase.items;
    const inserted = await request("POST", `/api/database/rows/table/${table.id}/?before=${baseTwo.id}`, {
      [`field_${textField.id}`]: "Before inserted single",
    });
    const namedBatch = await request("POST", `/api/database/rows/table/${table.id}/batch/?before=${baseThree.id}&user_field_names=true&include_metadata=true`, {
      items: [
        { [textField.name]: "Before batch A", [numberField.name]: 7 },
        { [textField.name]: "Before batch B", [numberField.name]: 8 },
      ],
    });
    assert(namedBatch.items?.[0]?.[textField.name] === "Before batch A", "batch create with user_field_names did not return named text field");
    assert(namedBatch.items?.[0]?.[`field_${textField.id}`] === undefined, "batch create with user_field_names leaked raw field key");
    assert(namedBatch.metadata?.updated_field_ids?.includes(textField.id), "batch create metadata missing text field id");
    assert(namedBatch.metadata?.updated_field_ids?.includes(numberField.id), "batch create metadata missing number field id");

    const expectedIds = [baseOne.id, inserted.id, baseTwo.id, namedBatch.items[0].id, namedBatch.items[1].id, baseThree.id];
    const orderedRows = await request("GET", `/api/database/rows/table/${table.id}/?size=1000`);
    const actualIds = orderedRows.results
      .filter((item) => expectedIds.includes(item.id))
      .map((item) => item.id);
    assert(JSON.stringify(actualIds) === JSON.stringify(expectedIds), "row before insertion did not preserve expected row order");

    const namedGet = await request("GET", `/api/database/rows/table/${table.id}/${baseOne.id}/?user_field_names=true`);
    assert(namedGet[textField.name] === "Before base one", "single row get did not honor user_field_names");
    assert(namedGet[`field_${textField.id}`] === undefined, "single row get with user_field_names leaked raw field key");

    const namedPatch = await request("PATCH", `/api/database/rows/table/${table.id}/${baseOne.id}/?user_field_names=true`, {
      [textField.name]: "Before single patched",
    });
    assert(namedPatch[textField.name] === "Before single patched", "single row patch did not honor user_field_names");
    assert(namedPatch[`field_${textField.id}`] === undefined, "single row patch with user_field_names leaked raw field key");

    const namedBatchPatch = await request("PATCH", `/api/database/rows/table/${table.id}/batch/?user_field_names=true&include_metadata=true`, {
      items: [
        { id: baseOne.id, [textField.name]: "Before batch patched", [numberField.name]: 9 },
      ],
    });
    assert(namedBatchPatch.items?.[0]?.[textField.name] === "Before batch patched", "batch patch did not honor user_field_names");
    assert(namedBatchPatch.items?.[0]?.[numberField.name] === "9.00", "batch patch did not return named number field");
    assert(namedBatchPatch.items?.[0]?.[`field_${textField.id}`] === undefined, "batch patch with user_field_names leaked raw field key");
    assert(namedBatchPatch.metadata?.updated_field_ids?.includes(textField.id), "batch patch metadata missing text field id");
    assert(namedBatchPatch.metadata?.updated_field_ids?.includes(numberField.id), "batch patch metadata missing number field id");
  });

  await step("select id normalization contracts", async () => {
    const singleSelectField = fields.find((item) => item.type === "single_select");
    const multipleSelectField = fields.find((item) => item.type === "multiple_select");
    const singleOption = singleSelectField.select_options[0];
    const multipleOption = multipleSelectField.select_options[0];
    const patched = await request("PATCH", `/api/database/rows/table/${table.id}/${row.id}/`, {
      [`field_${singleSelectField.id}`]: singleOption.id,
      [`field_${multipleSelectField.id}`]: [multipleOption.id],
    });
    assert(patched[`field_${singleSelectField.id}`]?.value === singleOption.value, "single select raw id was not normalized to option object");
    assert(patched[`field_${multipleSelectField.id}`]?.[0]?.value === multipleOption.value, "multiple select raw id was not normalized to option objects");
  });

  await step("field duplicate select option remap contracts", async () => {
    const singleSelectField = fields.find((item) => item.type === "single_select");
    const multipleSelectField = fields.find((item) => item.type === "multiple_select");
    const textField = fields.find((item) => item.type === "text");
    const singleWithDefault = await request("PATCH", `/api/database/fields/${singleSelectField.id}/`, {
      select_options: singleSelectField.select_options,
      single_select_default: singleSelectField.select_options[0].id,
    });
    const sourceView = table.views[0];
    await request("PATCH", `/api/database/views/${sourceView.id}/field-options/`, {
      field_options: {
        [singleWithDefault.id]: {
          width: 333,
          hidden: true,
          order: 77777,
          aggregation_type: "count",
          aggregation_raw_type: "empty_count",
        },
      },
    });
    const multipleWithDefault = await request("PATCH", `/api/database/fields/${multipleSelectField.id}/`, {
      select_options: multipleSelectField.select_options,
      multiple_select_default: [multipleSelectField.select_options[0].id],
    });
    const singleDuplicateJob = await request("POST", `/api/database/fields/${singleWithDefault.id}/duplicate/async/`, {
      duplicate_data: true,
    });
    const multipleDuplicateJob = await request("POST", `/api/database/fields/${multipleWithDefault.id}/duplicate/async/`, {
      duplicate_data: true,
    });
    const singleDuplicate = singleDuplicateJob.duplicated_field;
    const multipleDuplicate = multipleDuplicateJob.duplicated_field;
    assert(singleDuplicate.select_options?.[0]?.value === singleWithDefault.select_options[0].value, "duplicated single_select options did not preserve labels");
    assert(multipleDuplicate.select_options?.[0]?.value === multipleWithDefault.select_options[0].value, "duplicated multiple_select options did not preserve labels");
    assert(singleDuplicate.select_options[0].id !== singleWithDefault.select_options[0].id, "duplicated single_select reused old option id");
    assert(multipleDuplicate.select_options[0].id !== multipleWithDefault.select_options[0].id, "duplicated multiple_select reused old option id");
    assert(singleDuplicate.single_select_default === singleDuplicate.select_options[0].id, "duplicated single_select default was not remapped to new option id");
    assert(multipleDuplicate.multiple_select_default?.[0] === multipleDuplicate.select_options[0].id, "duplicated multiple_select default was not remapped to new option id");
    const copiedFieldOptions = await request("GET", `/api/database/views/${sourceView.id}/field-options/`);
    const copiedGridOption = copiedFieldOptions.field_options?.[singleDuplicate.id];
    assert(copiedGridOption?.width === 333, "duplicated single_select grid width was not copied");
    assert(copiedGridOption?.hidden === true, "duplicated single_select grid hidden state was not copied");
    assert(copiedGridOption?.aggregation_type === "count", "duplicated single_select grid aggregation was not copied");
    assert(copiedGridOption?.aggregation_raw_type === "empty_count", "duplicated single_select grid raw aggregation was not copied");

    const duplicatedRow = await request("GET", `/api/database/rows/table/${table.id}/${row.id}/`);
    const duplicatedSingle = duplicatedRow[`field_${singleDuplicate.id}`];
    const duplicatedMultiple = duplicatedRow[`field_${multipleDuplicate.id}`];
    assert(duplicatedSingle?.id === singleDuplicate.select_options[0].id, "duplicated single_select row value was not remapped to new option id");
    assert(duplicatedSingle?.value === singleDuplicate.select_options[0].value, "duplicated single_select row value label changed");
    assert(duplicatedMultiple?.[0]?.id === multipleDuplicate.select_options[0].id, "duplicated multiple_select row value was not remapped to new option id");
    assert(duplicatedMultiple?.[0]?.value === multipleDuplicate.select_options[0].value, "duplicated multiple_select row value label changed");

    const defaultedRow = await request("POST", `/api/database/rows/table/${table.id}/`, {
      [`field_${textField.id}`]: "duplicate defaults smoke",
    });
    assert(defaultedRow[`field_${singleDuplicate.id}`]?.id === singleDuplicate.single_select_default, "duplicated single_select default did not create a remapped row value");
    assert(defaultedRow[`field_${multipleDuplicate.id}`]?.[0]?.id === multipleDuplicate.multiple_select_default[0], "duplicated multiple_select default did not create a remapped row value");
  });

  await step("table duplicate data contracts", async () => {
    const sourceView = table.views[0];
    const sourceText = fields.find((item) => item.type === "text");
    const sourceSingle = fields.find((item) => item.type === "single_select");
    const sourceOption = sourceSingle.select_options[0];
    const filterGroup = await request("POST", `/api/database/views/${sourceView.id}/filter-groups/`, {
      filter_type: "OR",
    });
    await request("POST", `/api/database/views/${sourceView.id}/filters/`, {
      field: sourceSingle.id,
      type: "single_select_equal",
      value: String(sourceOption.id),
      group: filterGroup.id,
    });
    await request("POST", `/api/database/views/${sourceView.id}/sortings/`, {
      field: sourceText.id,
      order: "DESC",
    });
    await request("POST", `/api/database/views/${sourceView.id}/group_bys/`, {
      field: sourceSingle.id,
      order: "ASC",
      width: 255,
    });
    await request("POST", `/api/database/views/${sourceView.id}/decorations/`, {
      type: "left_border_color",
      value_provider_type: "single_select_color",
      value_provider_conf: { field_id: sourceSingle.id, select_option_id: sourceOption.id },
      order: 1,
    });
    await request("POST", `/api/database/views/table/${table.id}/`, { name: "Late options gallery", type: "gallery" });
    await request("POST", `/api/database/views/table/${table.id}/`, { name: "Late options form", type: "form" });
    await request("POST", `/api/database/views/table/${table.id}/`, { name: "Late options kanban", type: "kanban" });
    const lateField = await request("POST", `/api/database/fields/table/${table.id}/`, {
      name: "Late options smoke",
      type: "number",
    });

    const duplicateJob = await request("POST", `/api/database/tables/${table.id}/duplicate/async/`, {});
    assert(duplicateJob.state === "finished" && duplicateJob.duplicated_table?.id, "duplicate table did not finish");
    const duplicatedTable = duplicateJob.duplicated_table;
    const duplicatedText = duplicatedTable.fields.find((item) => item.name === "Text smoke");
    const duplicatedSingle = duplicatedTable.fields.find((item) => item.name === "Single smoke");
    const duplicatedMultiple = duplicatedTable.fields.find((item) => item.name === "Multi smoke");
    const duplicatedFile = duplicatedTable.fields.find((item) => item.name === "File smoke");
    const duplicatedAI = duplicatedTable.fields.find((item) => item.name === "AI smoke");
    const duplicatedLate = duplicatedTable.fields.find((item) => item.name === lateField.name);
    assert(duplicatedText && duplicatedSingle && duplicatedMultiple && duplicatedLate, "duplicated table fields missing");
    assert(duplicatedSingle.select_options?.[0]?.value === "A", "duplicated table single_select options missing");
    assert(duplicatedMultiple.select_options?.[0]?.value === "A", "duplicated table multiple_select options missing");
    assert(duplicatedSingle.select_options[0].id !== fields.find((item) => item.type === "single_select").select_options[0].id, "duplicated table reused single_select option id");
    assert(duplicatedMultiple.select_options[0].id !== fields.find((item) => item.type === "multiple_select").select_options[0].id, "duplicated table reused multiple_select option id");
    assert(duplicatedSingle.single_select_default === duplicatedSingle.select_options[0].id, "duplicated table single_select default was not remapped");
    assert(duplicatedMultiple.multiple_select_default?.[0] === duplicatedMultiple.select_options[0].id, "duplicated table multiple_select default was not remapped");
    assert(duplicatedAI.ai_file_field_id === duplicatedFile.id, "duplicated table AI file field was not remapped");
    assert(
      duplicatedAI.ai_prompt?.formula === `CONCAT('Summary ', get('fields.field_${duplicatedText.id}'))`,
      "duplicated table AI prompt field reference was not remapped"
    );

    const duplicatedRows = await request("GET", `/api/database/rows/table/${duplicatedTable.id}/?size=1000`);
    const copiedRow = duplicatedRows.results.find((item) => item[`field_${duplicatedText.id}`] === "updated smoke");
    assert(copiedRow, "duplicated table did not copy source rows");
    assert(copiedRow[`field_${duplicatedSingle.id}`]?.id === duplicatedSingle.select_options[0].id, "duplicated table single_select row value was not remapped");
    assert(copiedRow[`field_${duplicatedMultiple.id}`]?.[0]?.id === duplicatedMultiple.select_options[0].id, "duplicated table multiple_select row value was not remapped");

    const defaultedRow = await request("POST", `/api/database/rows/table/${duplicatedTable.id}/`, {
      [`field_${duplicatedText.id}`]: "table duplicate default smoke",
    });
    assert(defaultedRow[`field_${duplicatedSingle.id}`]?.id === duplicatedSingle.single_select_default, "duplicated table single_select default did not apply");
    assert(defaultedRow[`field_${duplicatedMultiple.id}`]?.[0]?.id === duplicatedMultiple.multiple_select_default[0], "duplicated table multiple_select default did not apply");

    const duplicatedViews = await request("GET", `/api/database/views/table/${duplicatedTable.id}/?include=filters,sortings,group_bys,decorations`);
    const duplicatedView = duplicatedViews.find((item) => item.name === sourceView.name && item.type === sourceView.type);
    assert(duplicatedView, "duplicated table view missing");
    assert(duplicatedView.filter_groups?.[0]?.filter_type === "OR", "duplicated table view filter group missing");
    assert(duplicatedView.filters?.[0]?.field === duplicatedSingle.id, "duplicated table view filter field was not remapped");
    assert(duplicatedView.filters?.[0]?.value === String(duplicatedSingle.select_options[0].id), "duplicated table view filter select value was not remapped");
    assert(duplicatedView.sortings?.[0]?.field === duplicatedText.id && duplicatedView.sortings?.[0]?.order === "DESC", "duplicated table view sorting was not remapped");
    assert(duplicatedView.group_bys?.[0]?.field === duplicatedSingle.id && duplicatedView.group_bys?.[0]?.width === 255, "duplicated table view group by was not remapped");
    assert(duplicatedView.decorations?.[0]?.value_provider_conf?.field_id === duplicatedSingle.id, "duplicated table view decoration field was not remapped");
    assert(duplicatedView.decorations?.[0]?.value_provider_conf?.select_option_id === duplicatedSingle.select_options[0].id, "duplicated table view decoration select option was not remapped");
    const duplicatedGallery = duplicatedViews.find((item) => item.name === "Late options gallery");
    const duplicatedForm = duplicatedViews.find((item) => item.name === "Late options form");
    const duplicatedKanban = duplicatedViews.find((item) => item.name === "Late options kanban");
    const duplicatedGalleryOptions = await request("GET", `/api/database/views/${duplicatedGallery.id}/field-options/`);
    const duplicatedFormOptions = await request("GET", `/api/database/views/${duplicatedForm.id}/field-options/`);
    const duplicatedKanbanOptions = await request("GET", `/api/database/views/${duplicatedKanban.id}/field-options/`);
    assert(duplicatedGalleryOptions.field_options?.[duplicatedLate.id]?.hidden === true, "late field gallery options missing after table duplicate");
    assert(duplicatedFormOptions.field_options?.[duplicatedLate.id]?.enabled === false, "late field form options missing after table duplicate");
    assert(duplicatedKanbanOptions.field_options?.[duplicatedLate.id]?.hidden === true, "late field premium view options missing after table duplicate");
  });

  await step("application duplicate data contracts", async () => {
    const sourceView = await request("POST", `/api/database/views/table/${table.id}/`, {
      name: "Application duplicate source",
      type: "grid",
    });
    const sourceText = fields.find((item) => item.type === "text");
    const sourceSingle = fields.find((item) => item.type === "single_select");
    const sourceOption = sourceSingle.select_options[0];
    const filterGroup = await request("POST", `/api/database/views/${sourceView.id}/filter-groups/`, {
      filter_type: "OR",
    });
    await request("POST", `/api/database/views/${sourceView.id}/filters/`, {
      field: sourceSingle.id,
      type: "single_select_equal",
      value: String(sourceOption.id),
      group: filterGroup.id,
    });
    await request("POST", `/api/database/views/${sourceView.id}/sortings/`, {
      field: sourceText.id,
      order: "DESC",
    });
    await request("POST", `/api/database/views/${sourceView.id}/group_bys/`, {
      field: sourceSingle.id,
      order: "ASC",
      width: 260,
    });
    await request("POST", `/api/database/views/${sourceView.id}/decorations/`, {
      type: "left_border_color",
      value_provider_type: "single_select_color",
      value_provider_conf: { field_id: sourceSingle.id, select_option_id: sourceOption.id },
      order: 2,
    });
    const linkTargetTable = await request("POST", `/api/database/tables/database/${app.id}/`, {
      name: "Application duplicate link target",
    });
    const linkTargetPrimary = linkTargetTable.fields.find((item) => item.primary) || linkTargetTable.fields[0];
    const deletedTarget = await request("POST", `/api/database/rows/table/${linkTargetTable.id}/`, {
      [`field_${linkTargetPrimary.id}`]: "Deleted link target",
    });
    const keptTarget = await request("POST", `/api/database/rows/table/${linkTargetTable.id}/`, {
      [`field_${linkTargetPrimary.id}`]: "Kept link target",
    });
    await request("DELETE", `/api/database/rows/table/${linkTargetTable.id}/${deletedTarget.id}/`);
    const linkField = await request("POST", `/api/database/fields/table/${table.id}/`, {
      name: "Application duplicate link",
      type: "link_row",
      link_row_table_id: linkTargetTable.id,
    });
    const linkedSourceRow = await request("PATCH", `/api/database/rows/table/${table.id}/${row.id}/`, {
      [`field_${linkField.id}`]: [keptTarget.id],
    });
    assert(linkedSourceRow[`field_${linkField.id}`]?.[0]?.id === keptTarget.id, "source link row did not normalize before application duplicate");

    const duplicateJob = await request("POST", `/api/applications/${app.id}/duplicate/async/`);
    assert(duplicateJob.state === "finished" && duplicateJob.duplicated_application?.id, "duplicate application did not finish");
    const duplicatedApp = duplicateJob.duplicated_application;
    const duplicatedTable = duplicatedApp.tables?.find((item) => item.name === table.name);
    assert(duplicatedTable, "duplicated application table missing");
    const duplicatedText = duplicatedTable.fields.find((item) => item.name === "Text smoke");
    const duplicatedSingle = duplicatedTable.fields.find((item) => item.name === "Single smoke");
    const duplicatedMultiple = duplicatedTable.fields.find((item) => item.name === "Multi smoke");
    const duplicatedFile = duplicatedTable.fields.find((item) => item.name === "File smoke");
    const duplicatedAI = duplicatedTable.fields.find((item) => item.name === "AI smoke");
    const duplicatedLink = duplicatedTable.fields.find((item) => item.name === "Application duplicate link");
    const duplicatedLinkTargetTable = duplicatedApp.tables?.find((item) => item.name === linkTargetTable.name);
    assert(duplicatedText && duplicatedSingle && duplicatedMultiple, "duplicated application fields missing");
    assert(duplicatedSingle.select_options?.[0]?.value === "A", "duplicated application single_select options missing");
    assert(duplicatedMultiple.select_options?.[0]?.value === "A", "duplicated application multiple_select options missing");
    assert(duplicatedSingle.select_options[0].id !== fields.find((item) => item.type === "single_select").select_options[0].id, "duplicated application reused single_select option id");
    assert(duplicatedMultiple.select_options[0].id !== fields.find((item) => item.type === "multiple_select").select_options[0].id, "duplicated application reused multiple_select option id");
    assert(duplicatedSingle.single_select_default === duplicatedSingle.select_options[0].id, "duplicated application single_select default was not remapped");
    assert(duplicatedMultiple.multiple_select_default?.[0] === duplicatedMultiple.select_options[0].id, "duplicated application multiple_select default was not remapped");
    assert(duplicatedLink?.link_row_table_id === duplicatedLinkTargetTable?.id, "duplicated application link field target table was not remapped");
    assert(duplicatedAI.ai_file_field_id === duplicatedFile.id, "duplicated application AI file field was not remapped");
    assert(
      duplicatedAI.ai_prompt?.formula === `CONCAT('Summary ', get('fields.field_${duplicatedText.id}'))`,
      "duplicated application AI prompt field reference was not remapped"
    );

    const duplicatedRows = await request("GET", `/api/database/rows/table/${duplicatedTable.id}/?size=1000`);
    const copiedRow = duplicatedRows.results.find((item) => item[`field_${duplicatedText.id}`] === "updated smoke");
    assert(copiedRow, "duplicated application did not copy source rows");
    assert(copiedRow[`field_${duplicatedSingle.id}`]?.id === duplicatedSingle.select_options[0].id, "duplicated application single_select row value was not remapped");
    assert(copiedRow[`field_${duplicatedMultiple.id}`]?.[0]?.id === duplicatedMultiple.select_options[0].id, "duplicated application multiple_select row value was not remapped");
    const duplicatedLinkTargetPrimary = duplicatedLinkTargetTable.fields.find((item) => item.primary) || duplicatedLinkTargetTable.fields[0];
    const duplicatedLinkTargets = await request("GET", `/api/database/rows/table/${duplicatedLinkTargetTable.id}/?size=1000`);
    const copiedTarget = duplicatedLinkTargets.results.find((item) => item[`field_${duplicatedLinkTargetPrimary.id}`] === "Kept link target");
    assert(copiedTarget?.id && copiedTarget.id !== keptTarget.id, "duplicated application link target row id was not regenerated");
    assert(copiedRow[`field_${duplicatedLink.id}`]?.[0]?.id === copiedTarget.id, "duplicated application link row value was not remapped to new row id");
    assert(copiedRow[`field_${duplicatedLink.id}`]?.[0]?.value === "Kept link target", "duplicated application link row label changed");

    const defaultedRow = await request("POST", `/api/database/rows/table/${duplicatedTable.id}/`, {
      [`field_${duplicatedText.id}`]: "application duplicate default smoke",
    });
    assert(defaultedRow[`field_${duplicatedSingle.id}`]?.id === duplicatedSingle.single_select_default, "duplicated application single_select default did not apply");
    assert(defaultedRow[`field_${duplicatedMultiple.id}`]?.[0]?.id === duplicatedMultiple.multiple_select_default[0], "duplicated application multiple_select default did not apply");

    const duplicatedViews = await request("GET", `/api/database/views/table/${duplicatedTable.id}/?include=filters,sortings,group_bys,decorations`);
    const duplicatedView = duplicatedViews.find((item) => item.name === sourceView.name && item.type === sourceView.type);
    assert(duplicatedView, "duplicated application view missing");
    assert(duplicatedView.filter_groups?.[0]?.filter_type === "OR", "duplicated application view filter group missing");
    assert(duplicatedView.filters?.[0]?.field === duplicatedSingle.id, "duplicated application view filter field was not remapped");
    assert(duplicatedView.filters?.[0]?.value === String(duplicatedSingle.select_options[0].id), "duplicated application view filter select value was not remapped");
    assert(duplicatedView.sortings?.[0]?.field === duplicatedText.id && duplicatedView.sortings?.[0]?.order === "DESC", "duplicated application view sorting was not remapped");
    assert(duplicatedView.group_bys?.some((item) => item.field === duplicatedSingle.id && item.width === 260), "duplicated application view group by was not remapped");
    assert(duplicatedView.decorations?.[0]?.value_provider_conf?.field_id === duplicatedSingle.id, "duplicated application view decoration field was not remapped");
    assert(duplicatedView.decorations?.[0]?.value_provider_conf?.select_option_id === duplicatedSingle.select_options[0].id, "duplicated application view decoration select option was not remapped");
  });

  await step("field unique row values contracts", async () => {
    const singleSelectField = fields.find((item) => item.type === "single_select");
    const multipleSelectField = fields.find((item) => item.type === "multiple_select");
    const collaboratorField = fields.find((item) => item.type === "multiple_collaborators");
    const singleValues = await request("GET", `/api/database/fields/${singleSelectField.id}/unique_row_values/?limit=10`);
    const multipleValues = await request("GET", `/api/database/fields/${multipleSelectField.id}/unique_row_values/?limit=10`, undefined, { allowError: true });
    const collaboratorValues = await request("GET", `/api/database/fields/${collaboratorField.id}/unique_row_values/?limit=10`, undefined, { allowError: true });
    assert(singleValues.values.includes("A"), "single_select unique values did not return option label");
    assert(multipleValues.status === 400 && multipleValues.data?.error === "ERROR_INCOMPATIBLE_FIELD_TYPE_FOR_UNIQUE_VALUES", "multiple_select unique values did not reject the incompatible type");
    assert(collaboratorValues.status === 400 && collaboratorValues.data?.error === "ERROR_INCOMPATIBLE_FIELD_TYPE_FOR_UNIQUE_VALUES", "collaborator unique values did not reject the incompatible type");

    const commaField = await request("POST", `/api/database/fields/table/${table.id}/`, {
      name: "Comma unique smoke",
      type: "text",
    });
    await request("POST", `/api/database/rows/table/${table.id}/`, {
      ...values,
      [`field_${commaField.id}`]: "Left, Right",
    });
    const splitValues = await request("GET", `/api/database/fields/${commaField.id}/unique_row_values/?split_comma_separated=true&limit=10`);
    assert(splitValues.values.includes("Left") && splitValues.values.includes("Right"), "split comma unique values did not return text fragments");
  });

  await step("field type conversion contracts", async () => {
    const conversionField = await request("POST", `/api/database/fields/table/${table.id}/`, {
      name: "Conversion smoke",
      type: "text",
    });
    const conversionRow = await request("POST", `/api/database/rows/table/${table.id}/`, {
      ...values,
      [`field_${conversionField.id}`]: "Converted",
    });
    const asSingle = await request("PATCH", `/api/database/fields/${conversionField.id}/`, {
      type: "single_select",
      select_options: [{ value: "Converted", color: "green" }],
    });
    assert(asSingle.type === "single_select", "field did not convert to single_select");
    const singleRow = await request("GET", `/api/database/rows/table/${table.id}/${conversionRow.id}/`);
    assert(singleRow[`field_${conversionField.id}`]?.value === "Converted", "text to single_select conversion did not preserve option label");

    const asMultiple = await request("PATCH", `/api/database/fields/${conversionField.id}/`, {
      type: "multiple_select",
      select_options: asSingle.select_options,
    });
    assert(asMultiple.type === "multiple_select", "field did not convert to multiple_select");
    const multipleRow = await request("GET", `/api/database/rows/table/${table.id}/${conversionRow.id}/`);
    assert(multipleRow[`field_${conversionField.id}`]?.[0]?.value === "Converted", "single_select to multiple_select conversion did not preserve option label");

    const asText = await request("PATCH", `/api/database/fields/${conversionField.id}/`, {
      type: "text",
    });
    assert(asText.type === "text", "field did not convert back to text");
    const textRow = await request("GET", `/api/database/rows/table/${table.id}/${conversionRow.id}/`);
    assert(textRow[`field_${conversionField.id}`] === "Converted", "select to text conversion did not preserve display value");

    const autoOptionField = await request("POST", `/api/database/fields/table/${table.id}/`, {
      name: "Auto option conversion smoke",
      type: "text",
    });
    const autoOptionRow = await request("POST", `/api/database/rows/table/${table.id}/`, {
      ...values,
      [`field_${autoOptionField.id}`]: "Generated option",
    });
    const autoOptionValues = await request(
      "GET",
      `/api/database/fields/${autoOptionField.id}/unique_row_values/?limit=100`
    );
    const autoOptionSelect = await request("PATCH", `/api/database/fields/${autoOptionField.id}/`, {
      type: "single_select",
      select_options: autoOptionValues.values.map((value) => ({ value, color: "blue" })),
    });
    assert(autoOptionSelect.select_options?.some((option) => option.value === "Generated option"), "text to single_select conversion did not create missing option");
    const autoOptionFetched = await request("GET", `/api/database/rows/table/${table.id}/${autoOptionRow.id}/`);
    assert(autoOptionFetched[`field_${autoOptionField.id}`]?.value === "Generated option", "text to generated single_select option did not preserve row value");
  });

  await step("table export typed values", async () => {
    const textField = fields.find((item) => item.type === "text");
    const numberField = fields.find((item) => item.type === "number");
    const singleSelectField = fields.find((item) => item.type === "single_select");
    const multipleSelectField = fields.find((item) => item.type === "multiple_select");
    const fileField = fields.find((item) => item.type === "file");
    assert(textField?.id, "text field missing for table export smoke");
    assert(numberField?.id, "number field missing for table export smoke");
    assert(singleSelectField?.id, "single select field missing for table export smoke");
    assert(multipleSelectField?.id, "multiple select field missing for table export smoke");
    assert(fileField?.id, "file field missing for table export smoke");
    const idNameField = await request("POST", `/api/database/fields/table/${table.id}/`, {
      name: "id",
      type: "text",
    });
    const emptyJsonField = await request("POST", `/api/database/fields/table/${table.id}/`, {
      name: "Empty JSON smoke",
      type: "text",
    });
    await request("PATCH", `/api/database/rows/table/${table.id}/${row.id}/`, {
      [`field_${idNameField.id}`]: "field id label",
    });

    const exportJob = await request("POST", `/api/database/export/table/${table.id}/`, {
      exporter_type: "csv",
      csv_include_header: true,
    });
    assert(exportJob.state === "finished" && exportJob.url, "table CSV export did not finish");
    assertSecureFileUrl(exportJob.url, "table CSV export URL");
    const csvResponse = await fetch(exportJob.url);
    assert(csvResponse.ok, "table CSV export file was not readable");
    const csv = await csvResponse.text();
    const header = csv.split(/\r?\n/)[0].replace(/^\ufeff/, "");
    assert(header.startsWith("id,") && header.includes("Text smoke"), "table CSV export header is invalid");
    assert(csv.includes("A"), "table CSV export did not include select labels");
    assert(!csv.includes("field_"), "table CSV export leaked raw field keys");

    const jsonJob = await request("POST", `/api/database/export/table/${table.id}/`, {
      exporter_type: "json",
      fields: [idNameField.id, singleSelectField.id, emptyJsonField.id, multipleSelectField.id, fileField.id],
    });
    assertSecureFileUrl(jsonJob.url, "table JSON export URL");
    const jsonResponse = await fetch(jsonJob.url);
    assert(jsonResponse.ok, "table JSON export file was not readable");
    const exportedRows = JSON.parse(await jsonResponse.text());
    assert(!Object.prototype.hasOwnProperty.call(exportedRows[0], "order"), "table JSON export leaked row order");
    assert(exportedRows[0]["id 2"] === "field id label", "table JSON export did not uniquify field names that collide with row id like Baserow");
    assert(exportedRows[0]["Single smoke"]?.value === "A", "table JSON export did not preserve single select shape");
    assert(exportedRows[0]["Empty JSON smoke"] === "", "table JSON export did not serialize null cells as empty strings");
    assert(exportedRows[0]["Multi smoke"]?.[0]?.value === "A", "table JSON export did not preserve multiple select shape");
    assert(Array.isArray(exportedRows[0]["File smoke"]), "table JSON export did not preserve file shape");

    const xmlJob = await request("POST", `/api/database/export/table/${table.id}/`, {
      exporter_type: "xml",
      fields: [idNameField.id, emptyJsonField.id, singleSelectField.id],
    });
    assert(xmlJob.state === "finished" && xmlJob.url, "table XML export did not finish");
    const xmlResponse = await fetch(xmlJob.url);
    assert(xmlResponse.ok, "table XML export file was not readable");
    const xml = await xmlResponse.text();
    assert(xml.startsWith('<?xml version="1.0" encoding="utf-8" ?>'), "table XML export header mismatch");
    assert(xml.includes("<id>"), "table XML export missing row id");
    assert(xml.includes("<id-2>field id label</id-2>"), "table XML export did not uniquify field names that collide with row id like Baserow");
    assert(xml.includes("<Empty-JSON-smoke></Empty-JSON-smoke>"), "table XML export did not serialize null cells as empty tags");
    assert(xml.includes("<Single-smoke><id>") && xml.includes("<value>A</value>"), "table XML export did not preserve rich select values");

    const excelJob = await request("POST", `/api/database/export/table/${table.id}/`, {
      exporter_type: "excel",
      excel_include_header: true,
      fields: [textField.id, singleSelectField.id, multipleSelectField.id, numberField.id],
    });
    assert(excelJob.state === "finished" && excelJob.url, "table Excel export did not finish");
    const excelResponse = await fetch(excelJob.url);
    assert(excelResponse.ok, "table Excel export file was not readable");
    assert(
      (excelResponse.headers.get("content-type") || "").includes("application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"),
      "table Excel export content type mismatch"
    );
    const excelBytes = new Uint8Array(await excelResponse.arrayBuffer());
    assert(excelBytes.byteLength > 1000, "table Excel export body was unexpectedly small");
    assert(excelBytes[0] === 0x50 && excelBytes[1] === 0x4b, "table Excel export was not a ZIP-based XLSX file");

    const exportedFile = exportedRows[0]["File smoke"]?.[0];
    assert(exportedFile?.name, "table JSON export did not expose file name for file ZIP smoke");
    const flatFileJob = await request("POST", `/api/database/export/table/${table.id}/`, {
      exporter_type: "file",
      organize_files: false,
      fields: [fileField.id],
    });
    assert(flatFileJob.state === "finished" && flatFileJob.url, "table file ZIP export did not finish");
    const flatFileResponse = await fetch(flatFileJob.url);
    assert(flatFileResponse.ok, "table file ZIP export file was not readable");
    assert((flatFileResponse.headers.get("content-type") || "").includes("application/zip"), "table file ZIP content type mismatch");
    const flatFileArchive = unzipSync(new Uint8Array(await flatFileResponse.arrayBuffer()));
    assert(flatFileArchive[exportedFile.name]?.byteLength > 0, "table file ZIP did not include stored file at the root");
    assert(!flatFileArchive[exportedFile.visible_name], "table file ZIP used visible file name instead of stored file name");

    const organizedFileJob = await request("POST", `/api/database/export/table/${table.id}/`, {
      exporter_type: "file",
      organize_files: true,
      fields: [fileField.id],
    });
    assert(organizedFileJob.state === "finished" && organizedFileJob.url, "organized table file ZIP export did not finish");
    const organizedFileResponse = await fetch(organizedFileJob.url);
    assert(organizedFileResponse.ok, "organized table file ZIP export file was not readable");
    const organizedFileArchive = unzipSync(new Uint8Array(await organizedFileResponse.arrayBuffer()));
    const organizedPath = `row_${row.id}/${exportedFile.name}`;
    assert(organizedFileArchive[organizedPath]?.byteLength > 0, "organized table file ZIP did not include stored file under row folder");
  });

  const view = (await request("GET", `/api/database/views/table/${table.id}/`))[0];
  assert(view?.id, "grid view missing");

  await step("grid rows and aggregations", async () => {
    const rows = await request("GET", `/api/database/views/grid/${view.id}/?include=field_options,row_metadata`);
    assert(rows.count >= 1 && Array.isArray(rows.results), "grid rows invalid");
    const filtered = await request("POST", `/api/database/views/grid/${view.id}/`, { row_ids: [row.id] });
    assert(Array.isArray(filtered) && filtered.some((item) => item.id === row.id), "grid filtered rows must use the Baserow array response");
    const aggs = await request("GET", `/api/database/views/grid/${view.id}/aggregations/`);
    assert(typeof aggs === "object", "aggregations invalid");
    const textField = fields.find((item) => item.type === "text");
    const singleAgg = await request("GET", `/api/database/views/grid/${view.id}/aggregation/${textField.id}/?type=empty_count&include=total`);
    assert(typeof singleAgg.value === "number", "single field aggregation value invalid");
    assert(singleAgg.total === rows.count, "single field aggregation total did not match grid row count");
  });

  await step("personal view ownership contracts", async () => {
    const currentUser = await request("GET", "/api/user/");
    const personal = await request("POST", `/api/database/views/table/${table.id}/`, {
      name: "Personal smoke",
      type: "grid",
      ownership_type: "personal",
    });
    assert(personal.ownership_type === "personal", "personal view ownership type missing");
    assert(personal.owned_by_id === currentUser.id, "personal view owner mismatch");
    const duplicated = await request("POST", `/api/database/views/${personal.id}/duplicate/`);
    assert(duplicated.ownership_type === "personal" && duplicated.owned_by_id === currentUser.id, "personal view duplicate owner mismatch");
    const invalid = await request("POST", `/api/database/views/table/${table.id}/`, {
      name: "Invalid personal smoke",
      type: "grid",
      ownership_type: "unknown",
    }, { allowError: true });
    assert(invalid.status === 400, "invalid personal view ownership type was accepted");
  });

  await step("row comments metadata and trash restore", async () => {
    const commentMessage = {
      type: "doc",
      content: [{ type: "paragraph", content: [{ type: "text", text: "Smoke row comment" }] }],
    };
    const created = await request("POST", `/api/row_comments/${table.id}/${row.id}/`, { message: commentMessage });
    assert(created.id && created.message.content[0].content[0].text === "Smoke row comment", "row comment create payload invalid");

    const comments = await request("GET", `/api/row_comments/${table.id}/${row.id}/?limit=10&offset=0`);
    assert(comments.count === 1 && comments.results[0].id === created.id, "row comment list did not include created comment");

    const rowWithMetadata = await request("GET", `/api/database/rows/table/${table.id}/${row.id}/?include=metadata`);
    assert(rowWithMetadata.metadata?.row_comment_count === 1, "row metadata did not include row_comment_count");
    assert(rowWithMetadata.metadata?.row_comments_notification_mode === "all", "row metadata did not include notification mode");

    const viewRows = await request("GET", `/api/database/views/grid/${view.id}/?include=row_metadata`);
    assert(viewRows.row_metadata?.[String(row.id)]?.row_comment_count === 1, "view row_metadata did not include row_comment_count");

    const deleted = await request("DELETE", `/api/row_comments/${table.id}/comment/${created.id}/`);
    assert(deleted.trashed === true && deleted.message === null, "deleted row comment did not serialize as trashed");

    const trashContents = await request("GET", `/api/trash/workspace/${workspace.id}/`);
    assert(
      trashContents.results.some((item) => item.trash_item_type === "row_comment" && item.trash_item_id === created.id),
      "row comment was not listed in trash"
    );

    const rowAfterDelete = await request("GET", `/api/database/rows/table/${table.id}/${row.id}/?include=metadata`);
    assert(!rowAfterDelete.metadata?.row_comment_count, "trashed row comment still counted in row metadata");

    const restored = await request("PATCH", "/api/trash/restore/", {
      trash_item_type: "row_comment",
      trash_item_id: created.id,
    });
    assert(restored.restored === true, "row comment restore did not return restored=true");

    const restoredComments = await request("GET", `/api/row_comments/${table.id}/${row.id}/?limit=10&offset=0`);
    assert(restoredComments.count === 1 && restoredComments.results[0].id === created.id, "row comment was not restored");

    await request("DELETE", `/api/row_comments/${table.id}/comment/${created.id}/`);
    await request("DELETE", `/api/trash/row_comment/${created.id}/?workspace_id=${workspace.id}`);
    const trashAfterDelete = await request("GET", `/api/trash/workspace/${workspace.id}/`);
    assert(
      !trashAfterDelete.results.some((item) => item.trash_item_type === "row_comment" && item.trash_item_id === created.id),
      "row comment stayed in trash after permanent delete"
    );
  });

  await step("view filters sorts and group by contracts", async () => {
    const textField = fields.find((item) => item.type === "text");
    const numberField = fields.find((item) => item.type === "number");
    const singleSelectField = fields.find((item) => item.type === "single_select");
    const dateField = fields.find((item) => item.type === "date");
    const otherValues = {
      ...values,
      [`field_${textField.id}`]: "other smoke",
      [`field_${numberField.id}`]: 7,
      [`field_${dateField.id}`]: "2026-05-22",
    };
    const otherRow = await request("POST", `/api/database/rows/table/${table.id}/`, otherValues);

    const filterView = await request("POST", `/api/database/views/table/${table.id}/`, { name: "Filter contract", type: "grid" });
    await request("POST", `/api/database/views/${filterView.id}/filters/`, {
      field: textField.id,
      type: "contains",
      value: "updated",
    });
    const filteredRows = await request("GET", `/api/database/views/grid/${filterView.id}/`);
    assert(filteredRows.count === 1 && filteredRows.results[0].id === row.id, "persistent view filter was not applied");

    const adhocTree = encodeURIComponent(JSON.stringify({
      filter_type: "AND",
      filters: [{ field: textField.id, type: "contains", value: "other" }],
      groups: [],
    }));
    const adhocFiltered = await request("GET", `/api/database/views/grid/${view.id}/?filters=${adhocTree}`);
    assert(adhocFiltered.count === 1 && adhocFiltered.results[0].id === otherRow.id, "serialized ad hoc filter was not applied");

    const sortLowRow = await request("POST", `/api/database/rows/table/${table.id}/`, {
      ...values,
      [`field_${textField.id}`]: "sort contract low",
      [`field_${numberField.id}`]: 3,
    });
    const sortHighRow = await request("POST", `/api/database/rows/table/${table.id}/`, {
      ...values,
      [`field_${textField.id}`]: "sort contract high",
      [`field_${numberField.id}`]: 9,
    });
    const sortView = await request("POST", `/api/database/views/table/${table.id}/`, { name: "Sort contract", type: "grid" });
    await request("POST", `/api/database/views/${sortView.id}/filters/`, {
      field: textField.id,
      type: "contains",
      value: "sort contract",
    });
    await request("POST", `/api/database/views/${sortView.id}/sortings/`, {
      field: numberField.id,
      order: "ASC",
    });
    const sortedRows = await request("GET", `/api/database/views/grid/${sortView.id}/`);
    assert(
      sortedRows.count === 2 &&
        sortedRows.results[0].id === sortLowRow.id &&
        sortedRows.results[1].id === sortHighRow.id,
      "persistent view sort was not applied"
    );

    const groupView = await request("POST", `/api/database/views/table/${table.id}/`, { name: "Group contract", type: "grid" });
    await request("POST", `/api/database/views/${groupView.id}/group_bys/`, {
      field: singleSelectField.id,
      order: "ASC",
    });
    const groupedRows = await request("GET", `/api/database/views/grid/${groupView.id}/?include=row_metadata`);
    const groupMetadata = groupedRows.group_by_metadata?.[`field_${singleSelectField.id}`] || [];
    assert(groupMetadata.some((entry) => entry.count >= 2), "group by metadata was not returned");
  });

  await step("computed fields and premium view row endpoints", async () => {
    const textField = fields.find((item) => item.type === "text");
    const uuidField = await request("POST", `/api/database/fields/table/${table.id}/`, { name: "UUID smoke", type: "uuid" });
    const autoField = await request("POST", `/api/database/fields/table/${table.id}/`, { name: "Auto smoke", type: "autonumber" });
    const createdOnField = await request("POST", `/api/database/fields/table/${table.id}/`, { name: "Created smoke", type: "created_on" });
    const lastModifiedField = await request("POST", `/api/database/fields/table/${table.id}/`, { name: "Last modified smoke", type: "last_modified" });
    const createdByField = await request("POST", `/api/database/fields/table/${table.id}/`, { name: "Created by smoke", type: "created_by" });
    const lastModifiedByField = await request("POST", `/api/database/fields/table/${table.id}/`, { name: "Last modified by smoke", type: "last_modified_by" });
    const formulaField = await request("POST", `/api/database/fields/table/${table.id}/`, {
      name: "Formula field smoke",
      type: "formula",
      formula: `CONCAT({${textField.name}}, " ok")`,
      formula_type: "text",
    });
    const computedRow = await request("POST", `/api/database/rows/table/${table.id}/`, {
      [`field_${textField.id}`]: "computed",
      [`field_${uuidField.id}`]: "client-must-not-win",
      [`field_${autoField.id}`]: 999999,
      [`field_${createdByField.id}`]: { id: 0, name: "forged", email: "forged@example.invalid" },
      [`field_${lastModifiedByField.id}`]: { id: 0, name: "forged", email: "forged@example.invalid" },
    });
    assert(computedRow[`field_${uuidField.id}`] !== "client-must-not-win", "uuid field accepted client value");
    assert(Number(computedRow[`field_${autoField.id}`]) === computedRow.id, "autonumber field did not use row id");
    assert(String(computedRow[`field_${createdOnField.id}`] || "").includes("T"), "created_on field missing timestamp");
    assert(String(computedRow[`field_${lastModifiedField.id}`] || "").includes("T"), "last_modified field missing timestamp");
    assert(computedRow[`field_${createdByField.id}`]?.email === email, "created_by field did not serialize the authenticated user");
    assert(computedRow[`field_${lastModifiedByField.id}`]?.email === email, "last_modified_by field did not serialize the authenticated user on create");

    const beforeModified = Date.parse(String(computedRow[`field_${lastModifiedField.id}`]));
    await new Promise((resolve) => setTimeout(resolve, 5));
    const patchedComputed = await request("PATCH", `/api/database/rows/table/${table.id}/${computedRow.id}/`, {
      [`field_${textField.id}`]: "computed patched",
      [`field_${createdByField.id}`]: { id: 0, name: "forged again", email: "forged-again@example.invalid" },
      [`field_${lastModifiedByField.id}`]: { id: 0, name: "forged again", email: "forged-again@example.invalid" },
    });
    const afterModified = Date.parse(String(patchedComputed[`field_${lastModifiedField.id}`]));
    assert(patchedComputed[`field_${createdByField.id}`]?.email === email, "created_by field changed on row patch");
    assert(patchedComputed[`field_${lastModifiedByField.id}`]?.email === email, "last_modified_by field did not update to the authenticated user");
    assert(Number.isFinite(beforeModified) && Number.isFinite(afterModified) && afterModified >= beforeModified, "last_modified field did not move forward on row patch");

    const gridRows = await request("GET", `/api/database/views/grid/${view.id}/`);
    const gridRow = gridRows.results.find((item) => item.id === computedRow.id);
    assert(gridRow?.[`field_${formulaField.id}`] === "computed patched ok", "formula field not evaluated in grid rows");

    const survey = await request("POST", `/api/database/views/table/${table.id}/`, { name: "Survey smoke", type: "survey" });
    assert(survey.type === "form" && survey.mode === "survey", "survey view did not serialize as form mode survey");
    const singleSelectField = fields.find((item) => item.type === "single_select");
    const dateField = fields.find((item) => item.type === "date");
    const singleOption = singleSelectField.select_options[0];
    const formFieldOptions = await request("PATCH", `/api/database/views/${survey.id}/field-options/`, {
      field_options: {
        [textField.id]: {
          name: "Required text",
          enabled: true,
          required: true,
          order: 16384,
          show_when_matching_conditions: false,
          condition_type: "AND",
          conditions: [],
          condition_groups: [],
          field_component: "default",
          include_all_select_options: true,
          allowed_select_options: [],
        },
        [singleSelectField.id]: {
          name: "Single limited",
          description: "Only selected option is allowed",
          enabled: true,
          required: true,
          order: 32768,
          show_when_matching_conditions: true,
          condition_type: "AND",
          conditions: [{ id: 0, field: textField.id, type: "contains", value: "updated", group: null }],
          condition_groups: [],
          field_component: "default",
          include_all_select_options: false,
          allowed_select_options: [singleOption.id],
        },
      },
    });
    const singleFormOptions = formFieldOptions.field_options[singleSelectField.id];
    assert(singleFormOptions.include_all_select_options === false, "form select allow-list flag was not persisted");
    assert(singleFormOptions.allowed_select_options.includes(singleOption.id), "form select allow-list was not persisted");
    assert(singleFormOptions.conditions.length === 1 && singleFormOptions.conditions[0].field === textField.id, "form field condition was not persisted");
    const fetchedFormOptions = await request("GET", `/api/database/views/${survey.id}/field-options/`);
    assert(fetchedFormOptions.field_options[singleSelectField.id].conditions.length === 1, "form field condition did not survive reload");
    const publicSurvey = await request("PATCH", `/api/database/views/${survey.id}/`, { public: true });
    const publicForm = await request("GET", `/api/database/views/form/${publicSurvey.slug}/submit/`);
    const publicSingleField = publicForm.fields.find((item) => item.field.id === singleSelectField.id);
    assert(publicSingleField?.mode !== undefined || publicForm.mode === "survey", "public form mode missing");
    assert(publicSingleField?.conditions?.length === 1, "public form field condition missing");
    assert(publicSingleField?.allowed_select_options?.includes(singleOption.id), "public form allowed select options missing");
    const invalidFormSubmit = await request("POST", `/api/database/views/form/${publicSurvey.slug}/submit/`, {
      [`field_${textField.id}`]: "present",
      [`field_${singleSelectField.id}`]: 999999999,
    }, { auth: false, allowError: true });
    assert(
      invalidFormSubmit.status === 400 && invalidFormSubmit.data?.error === "ERROR_REQUEST_BODY_VALIDATION",
      "public form accepted a forbidden select option"
    );
    const missingRequiredFormSubmit = await request("POST", `/api/database/views/form/${publicSurvey.slug}/submit/`, {
      [`field_${singleSelectField.id}`]: singleOption.id,
    }, { auth: false, allowError: true });
    assert(
      missingRequiredFormSubmit.status === 400 && missingRequiredFormSubmit.data?.detail?.[`field_${textField.id}`],
      "public form accepted a missing required value"
    );

    const unconfiguredKanban = await request("POST", `/api/database/views/table/${table.id}/`, { name: "kanban smoke", type: "kanban" });
    assert(unconfiguredKanban.single_select_field === null, "new kanban must not auto-select a field");
    const kanbanView = await request("PATCH", `/api/database/views/${unconfiguredKanban.id}/`, {
      single_select_field: singleSelectField.id,
    });
    assert(kanbanView.single_select_field === singleSelectField.id, "kanban single select field was not persisted");
    const kanbanPayload = await request("GET", `/api/database/views/kanban/${kanbanView.id}/?include=field_options,row_metadata`);
    assert(kanbanPayload.rows && typeof kanbanPayload.rows === "object", "kanban rows payload missing rows object");
    assert(!Array.isArray(kanbanPayload.results), "kanban returned generic results payload");
    assert(kanbanPayload.rows[String(values[`field_${singleSelectField.id}`].id)]?.count >= 1, "kanban stack did not include selected row");
    assert(kanbanPayload.field_options?.[textField.id], "kanban field options missing");

    const unconfiguredCalendar = await request("POST", `/api/database/views/table/${table.id}/`, { name: "calendar smoke", type: "calendar" });
    assert(unconfiguredCalendar.date_field === null, "new calendar must not auto-select a date field");
    const calendarView = await request("PATCH", `/api/database/views/${unconfiguredCalendar.id}/`, {
      date_field: dateField.id,
    });
    assert(calendarView.date_field === dateField.id, "calendar date field was not persisted");
    const from = encodeURIComponent("2026-05-01T00:00:00.000Z");
    const to = encodeURIComponent("2026-06-01T00:00:00.000Z");
    const calendarPayload = await request("GET", `/api/database/views/calendar/${calendarView.id}/?include=field_options,row_metadata&from_timestamp=${from}&to_timestamp=${to}`);
    assert(calendarPayload.rows && typeof calendarPayload.rows === "object", "calendar rows payload missing rows object");
    assert(!Array.isArray(calendarPayload.results), "calendar returned generic results payload");
    assert(calendarPayload.rows["2026-05-21"]?.count >= 1, "calendar date stack did not include dated row");
    assert(calendarPayload.field_options?.[textField.id], "calendar field options missing");

    const publicCalendar = await request("PATCH", `/api/database/views/${calendarView.id}/`, { ical_public: true });
    assert(publicCalendar.ical_public === true, "calendar iCal public flag was not persisted");
    assert(publicCalendar.ical_feed_url && publicCalendar.ical_feed_url.endsWith(".ics"), "calendar iCal feed URL missing");
    const icalPath = new URL(publicCalendar.ical_feed_url).pathname;
    const icalFeed = await request("GET", icalPath);
    assert(typeof icalFeed === "string" && icalFeed.includes("BEGIN:VCALENDAR"), "calendar iCal feed did not return VCALENDAR");
    assert(icalFeed.includes("BEGIN:VEVENT"), "calendar iCal feed did not include dated rows");

    const rotatedCalendar = await request("POST", `/api/database/views/calendar/${calendarView.id}/ical_slug_rotate/`);
    assert(rotatedCalendar.ical_slug, "calendar iCal slug did not rotate");
    assert(rotatedCalendar.ical_feed_url && rotatedCalendar.ical_feed_url.endsWith(`${rotatedCalendar.ical_slug}.ics`), "rotated calendar iCal URL invalid");

    const timelineView = await request("POST", `/api/database/views/table/${table.id}/`, { name: "timeline smoke", type: "timeline" });
    assert(timelineView.start_date_field === null && timelineView.end_date_field === null, "new timeline must not auto-select date fields");
    const patchedTimeline = await request("PATCH", `/api/database/views/${timelineView.id}/`, {
      start_date_field: dateField.id,
      end_date_field: dateField.id,
      timescale: "week",
    });
    assert(patchedTimeline.timescale === "week", "timeline settings were not persisted");
    const timelinePayload = await request("GET", `/api/database/views/timeline/${timelineView.id}/?include=field_options,row_metadata`);
    assert(Array.isArray(timelinePayload.results), "timeline rows payload invalid");
    assert(timelinePayload.field_options?.[textField.id], "timeline field options missing");
  });

  let linkSmoke = null;
  await step("link row count lookup rollup contracts", async () => {
    const targetTable = await request("POST", `/api/database/tables/database/${app.id}/`, { name: "E2E linked table" });
    const targetFields = await request("GET", `/api/database/fields/table/${targetTable.id}/`);
    const targetPrimary = targetFields.find((item) => item.primary) || targetFields[0];
    const amountField = await request("POST", `/api/database/fields/table/${targetTable.id}/`, {
      name: "Amount",
      type: "number",
      number_decimal_places: 0,
    });
    const activeField = await request("POST", `/api/database/fields/table/${targetTable.id}/`, {
      name: "Active",
      type: "boolean",
    });
    const firstTarget = await request("POST", `/api/database/rows/table/${targetTable.id}/`, {
      [`field_${targetPrimary.id}`]: "Linked A",
      [`field_${amountField.id}`]: 12,
      [`field_${activeField.id}`]: false,
    });
    const secondTarget = await request("POST", `/api/database/rows/table/${targetTable.id}/`, {
      [`field_${targetPrimary.id}`]: "Linked B",
      [`field_${amountField.id}`]: 8,
      [`field_${activeField.id}`]: true,
    });

    const linkField = await request("POST", `/api/database/fields/table/${table.id}/`, {
      name: "Linked rows smoke",
      type: "link_row",
      link_row_table_id: targetTable.id,
    });
    const countField = await request("POST", `/api/database/fields/table/${table.id}/`, {
      name: "Linked count smoke",
      type: "count",
      through_field_id: linkField.id,
    });
    const lookupField = await request("POST", `/api/database/fields/table/${table.id}/`, {
      name: "Linked lookup smoke",
      type: "lookup",
      through_field_id: linkField.id,
      target_field_id: targetPrimary.id,
    });
    const rollupField = await request("POST", `/api/database/fields/table/${table.id}/`, {
      name: "Linked rollup smoke",
      type: "rollup",
      through_field_id: linkField.id,
      target_field_id: amountField.id,
      rollup_function: "sum",
    });
    const anyRollupField = await request("POST", `/api/database/fields/table/${table.id}/`, {
      name: "Linked any smoke",
      type: "rollup",
      through_field_id: linkField.id,
      target_field_id: activeField.id,
      rollup_function: "any",
    });
    assert(countField.formula_type === "number" && countField.nullable === false, "count field type contract mismatch");
    assert(lookupField.formula_type === "array" && lookupField.array_formula_type === "text", "lookup field type contract mismatch");
    assert(rollupField.formula_type === "number" && rollupField.nullable === false, "sum rollup type contract mismatch");
    assert(anyRollupField.formula_type === "boolean" && anyRollupField.nullable === true, "any rollup type contract mismatch");

    const invalid = await request("POST", `/api/database/fields/table/${table.id}/`, {
      name: "Invalid count smoke",
      type: "count",
      through_field_id: amountField.id,
    }, { allowError: true });
    assert(invalid.status === 400 && invalid.data?.error === "ERROR_INVALID_COUNT_THROUGH_FIELD", "invalid count did not return Baserow error code");
    const invalidRollup = await request("POST", `/api/database/fields/table/${table.id}/`, {
      name: "Invalid text sum smoke",
      type: "rollup",
      through_field_id: linkField.id,
      target_field_id: targetPrimary.id,
      rollup_function: "sum",
    }, { allowError: true });
    assert(
      invalidRollup.status === 400 && invalidRollup.data?.error === "ERROR_INVALID_ROLLUP_FORMULA_FUNCTION",
      "incompatible rollup function did not return Baserow error code"
    );

    const linkedRow = await request("POST", `/api/database/rows/table/${table.id}/`, {
      [`field_${linkField.id}`]: [
        firstTarget.id,
        secondTarget.id,
      ],
    });
    const fetched = await request("GET", `/api/database/rows/table/${table.id}/${linkedRow.id}/`);
    assert(fetched[`field_${linkField.id}`]?.[0]?.value === "Linked A", "link row raw ids were not normalized to id/value objects");
    assert(linkField.link_row_related_field_id && linkField.link_row_related_field === linkField.link_row_related_field_id, "link row reciprocal field contract missing");
    const reverseLinked = await request("GET", `/api/database/rows/table/${targetTable.id}/${firstTarget.id}/`);
    assert(reverseLinked[`field_${linkField.link_row_related_field_id}`]?.some((item) => item.id === linkedRow.id), "link row reciprocal cell was not synchronized");
    assert(fetched[`field_${countField.id}`] === "2", "count field did not count linked rows");
    assert(
      JSON.stringify(fetched[`field_${lookupField.id}`]) === JSON.stringify([
        { id: firstTarget.id, value: "Linked A" },
        { id: secondTarget.id, value: "Linked B" },
      ]),
      "lookup field did not return Baserow id/value entries"
    );
    assert(fetched[`field_${rollupField.id}`] === "20", "rollup field did not sum linked values");
    assert(fetched[`field_${anyRollupField.id}`] === true, "any rollup field did not aggregate linked booleans");
    await request("PATCH", `/api/database/rows/table/${targetTable.id}/${secondTarget.id}/`, {
      [`field_${targetPrimary.id}`]: "Linked B updated",
    });
    const renamedLinks = await request("GET", `/api/database/rows/table/${table.id}/${linkedRow.id}/`);
    assert(renamedLinks[`field_${linkField.id}`]?.[1]?.value === "Linked B updated", "link row label did not track target primary value");
    await request("PATCH", `/api/database/rows/table/${targetTable.id}/${firstTarget.id}/move/`, null);
    const reorderedLinks = await request("GET", `/api/database/rows/table/${table.id}/${linkedRow.id}/`);
    assert(
      JSON.stringify(reorderedLinks[`field_${linkField.id}`]?.map((item) => item.id)) === JSON.stringify([secondTarget.id, firstTarget.id]),
      "link row values did not follow target row order"
    );
    assert(
      JSON.stringify(reorderedLinks[`field_${lookupField.id}`]) === JSON.stringify([
        { id: secondTarget.id, value: "Linked B updated" },
        { id: firstTarget.id, value: "Linked A" },
      ]),
      "lookup values did not follow target row order"
    );
    linkSmoke = { targetTable, targetPrimary, amountField, linkField, countField, lookupField, rollupField, linkedRow };
  });

  await step("view decorations", async () => {
    const decoration = await request("POST", `/api/database/views/${view.id}/decorations/`, {
      type: "left_border_color",
      value_provider_type: "",
      value_provider_conf: {},
    });
    assert(decoration.id, "decoration id missing");
    await request("PATCH", `/api/database/views/decoration/${decoration.id}/`, { type: "background_color" });
    const decorations = await request("GET", `/api/database/views/${view.id}/decoration/`);
    assert(decorations.some((item) => item.id === decoration.id), "decoration list missing item");
  });

  await step("application snapshot restore roundtrip", async () => {
    const publicExportView = await request("PATCH", `/api/database/views/${view.id}/`, { public: true, allow_public_export: true });
    assert(publicExportView.allow_public_export === true, "view update did not persist allow_public_export");

    const snapshotJob = await request("POST", `/api/snapshots/application/${app.id}/`, { name: "E2E snapshot" });
    const snapshot = snapshotJob.snapshot;
    assert(snapshot?.id, "snapshot id missing");
    const restoreJob = await request("POST", `/api/snapshots/${snapshot.id}/restore/`);
    const restoredAppId = restoreJob.application?.id;
    assert(restoredAppId, "restored application id missing");
    const restoredApp = await request("GET", `/api/applications/${restoredAppId}/`);
    const restoredMainTable = restoredApp.tables.find((item) => item.name === table.name);
    const restoredLinkedTable = restoredApp.tables.find((item) => item.name === linkSmoke.targetTable.name);
    const restoredDataSyncTable = restoredApp.tables.find((item) => item.name === dataSyncSmoke?.table?.name);
    const restoredPlanningTable = restoredApp.tables.find((item) => item.name === dateDependencySmoke?.table?.name);
    assert(restoredMainTable?.id && restoredLinkedTable?.id, "restored snapshot tables missing");
    assert(restoredDataSyncTable?.data_sync?.id, "snapshot did not restore data sync metadata");
    assert(restoredPlanningTable?.id, "snapshot did not restore the date dependency table");
    const restoredDateRules = await request("GET", `/api/database/field-rules/${restoredPlanningTable.id}/`);
    const restoredDateRule = restoredDateRules[0];
    const restoredPlanningFields = new Map(restoredPlanningTable.fields.map((field) => [field.name, field.id]));
    assert(restoredDateRule?.is_valid === false, "snapshot did not preserve and revalidate the date dependency rule");
    assert(restoredDateRule.start_date_field_id === restoredPlanningFields.get(dateDependencySmoke.start.name), "snapshot did not remap the date dependency start field");
    assert(restoredDateRule.end_date_field_id === restoredPlanningFields.get(dateDependencySmoke.end.name), "snapshot did not remap the date dependency end field");
    assert(restoredDateRule.duration_field_id === restoredPlanningFields.get(dateDependencySmoke.duration.name), "snapshot did not remap the date dependency duration field");
    assert(restoredDateRule.dependency_linkrow_field_id === restoredPlanningFields.get(dateDependencySmoke.predecessors.name), "snapshot did not remap the date dependency link field");

    const restoredSingle = restoredMainTable.fields.find((item) => item.name === "Single smoke");
    assert(restoredSingle?.select_options?.[0]?.value === "A", "snapshot did not restore select options");
    const restoredText = restoredMainTable.fields.find((item) => item.name === "Text smoke");
    const restoredSourceSingle = restoredMainTable.fields.find((item) => item.name === "Single smoke");
    const restoredSourceMulti = restoredMainTable.fields.find((item) => item.name === "Multi smoke");
    const restoredSourceFile = restoredMainTable.fields.find((item) => item.name === "File smoke");
    assert(restoredText?.id && restoredSourceSingle?.id && restoredSourceMulti?.id && restoredSourceFile?.id, "snapshot restored data sync source fields missing");
    const restoredDataSync = await request("GET", `/api/database/data-sync/${restoredDataSyncTable.data_sync.id}/`);
    assert(restoredDataSync.type === "local_baserow_table", "snapshot restored data sync type mismatch");
    assert(restoredDataSync.auto_add_new_properties === false, "snapshot did not restore data sync auto_add_new_properties");
    assert(restoredDataSync.two_way_sync === false, "snapshot restored unsupported data sync two-way flag");
    assert(restoredDataSync.periodic_interval === "day" && restoredDataSync.periodic_interval_count === 2, "snapshot did not restore data sync periodic settings");
    const restoredDataSyncKeys = restoredDataSync.synced_properties.map((item) => item.key);
    assert(restoredDataSyncKeys.includes(`field_${restoredText.id}`), "snapshot did not remap data sync text property key");
    assert(restoredDataSyncKeys.includes(`field_${restoredSourceSingle.id}`), "snapshot did not remap data sync single select property key");
    assert(!restoredDataSyncKeys.includes(`field_${restoredSourceMulti.id}`), "snapshot restored unsupported data sync multiple select property key");
    assert(restoredDataSyncKeys.includes(`field_${restoredSourceFile.id}`), "snapshot did not remap data sync file property key");
    const restoredDataSyncProperties = await request("GET", `/api/database/data-sync/${restoredDataSyncTable.data_sync.id}/properties/`);
    assert(
      restoredDataSyncProperties.some((item) => item.key === `field_${restoredText.id}` && item.name === restoredText.name),
      "snapshot did not remap data sync source table settings"
    );

    const restoredViews = await request("GET", `/api/database/views/table/${restoredMainTable.id}/?include=filters,sortings,group_bys,decorations`);
    const restoredSurvey = restoredViews.find((item) => item.name === "Survey smoke");
    assert(restoredSurvey?.mode === "survey", "snapshot did not restore survey mode");
    const restoredFormOptions = await request("GET", `/api/database/views/${restoredSurvey.id}/field-options/`);
    const restoredSingleOptions = restoredFormOptions.field_options[restoredSingle.id];
    assert(restoredSingleOptions?.conditions?.length === 1, "snapshot did not restore form field conditions");
    assert(restoredSingleOptions?.allowed_select_options?.length === 1, "snapshot did not restore form allowed select options");

    const restoredDecoratedView = restoredViews.find((item) => item.name === view.name);
    assert(restoredDecoratedView?.decorations?.length >= 1, "snapshot did not restore view decorations");
    assert(restoredDecoratedView?.allow_public_export === true, "snapshot did not restore public export setting");

    const restoredLinkField = restoredMainTable.fields.find((item) => item.name === linkSmoke.linkField.name);
    const restoredCountField = restoredMainTable.fields.find((item) => item.name === linkSmoke.countField.name);
    const restoredLookupField = restoredMainTable.fields.find((item) => item.name === linkSmoke.lookupField.name);
    const restoredRollupField = restoredMainTable.fields.find((item) => item.name === linkSmoke.rollupField.name);
    const restoredFileField = restoredMainTable.fields.find((item) => item.name === "File smoke");
    assert(restoredLinkField?.link_row_table_id === restoredLinkedTable.id, "snapshot did not remap link row table id");

    const restoredRows = await request("GET", `/api/database/rows/table/${restoredMainTable.id}/`);
    const restoredLinkedRow = restoredRows.results.find((item) => Array.isArray(item[`field_${restoredLinkField.id}`]) && item[`field_${restoredLinkField.id}`].length === 2);
    assert(restoredLinkedRow, "snapshot did not restore linked row values");
    const restoredFileRow = restoredRows.results.find((item) => Array.isArray(item[`field_${restoredFileField.id}`]) && item[`field_${restoredFileField.id}`].length > 0);
    const restoredFile = restoredFileRow?.[`field_${restoredFileField.id}`]?.[0];
    assert(restoredFile?.name && restoredFile?.url, "snapshot did not restore file cell references");
    assert(restoredFile.visible_name === "Renamed smoke image.png", "snapshot did not preserve file visible name");
    const restoredFileResponse = await fetch(restoredFile.url);
    assert(restoredFileResponse.ok, "snapshot restored file URL was not readable");
    assert((restoredFileResponse.headers.get("content-type") || "").startsWith("image/"), "snapshot restored file content type mismatch");
    assert(restoredLinkedRow[`field_${linkSmoke.countField.id}`] === undefined, "snapshot exposed old computed field id");
    assert(restoredLinkedRow[`field_${restoredCountField.id}`] === "2", "snapshot did not remap count dependencies");
    const restoredTargetRows = await request("GET", `/api/database/rows/table/${restoredLinkedTable.id}/`);
    const restoredLinkedB = restoredTargetRows.results.find((item) => item[`field_${restoredLinkedTable.fields.find((field) => field.primary)?.id}`] === "Linked B updated");
    const restoredLinkedA = restoredTargetRows.results.find((item) => item[`field_${restoredLinkedTable.fields.find((field) => field.primary)?.id}`] === "Linked A");
    assert(restoredLinkedB?.id && restoredLinkedA?.id, "snapshot restored lookup target rows missing");
    assert(
      JSON.stringify(restoredLinkedRow[`field_${restoredLookupField.id}`]) === JSON.stringify([
        { id: restoredLinkedB.id, value: "Linked B updated" },
        { id: restoredLinkedA.id, value: "Linked A" },
      ]),
      "snapshot did not remap lookup dependencies"
    );
    assert(restoredLinkedRow[`field_${restoredRollupField.id}`] === "20", "snapshot did not remap rollup dependencies");
  });

  await step("public view auth and public rows", async () => {
    await request("PATCH", `/api/database/views/${view.id}/`, { public: true });
    const auth = await request("POST", `/api/database/views/${view.slug}/public/auth/`, { password: "" });
    assert(auth.access_token, "public auth token missing");
    const publicRows = await request("GET", `/api/database/views/grid/${view.id}/public/rows/`);
    assert(publicRows.count >= 1, "public rows invalid");
    const publicAggs = await request("GET", `/api/database/views/grid/${view.id}/public/aggregations/`);
    assert(typeof publicAggs === "object", "public aggregations invalid");
  });

  await step("formula type", async () => {
    const data = await request("POST", `/api/database/formula/${table.id}/type/`, {
      name: "Formula smoke",
      formula: "ADD(1, 2)",
    });
    assert(data.type, "formula type missing");
    const preciseType = await request("POST", `/api/database/formula/${table.id}/type/`, {
      name: "Precise formula smoke",
      formula: "log(125.000, 5)",
    });
    assert(
      preciseType.formula_type === "number" && preciseType.number_decimal_places === 3,
      "formula decimal precision type contract mismatch"
    );
    const preciseFormula = await request("POST", `/api/database/fields/table/${table.id}/`, {
      name: "Precise formula smoke",
      type: "formula",
      formula: "log(125.000, 5)",
    });
    assert(preciseFormula.number_decimal_places === 3, "formula field decimal precision mismatch");
    const preciseFormulaRow = await request("GET", `/api/database/rows/table/${table.id}/${row.id}/`);
    assert(preciseFormulaRow[`field_${preciseFormula.id}`] === "0.333", "formula row decimal precision mismatch");
    const numberField = fields.find((item) => item.type === "number");
    const directFieldType = await request("POST", `/api/database/formula/${table.id}/type/`, {
      name: "Direct field formula smoke",
      formula: `{${numberField.name}}`,
    });
    assert(directFieldType.formula_type === "number", "direct field formula type was not inferred from the referenced field");

    const invalid = await request("POST", `/api/database/fields/table/${table.id}/`, {
      name: "Invalid formula smoke",
      type: "formula",
      formula: "upper(1)",
    }, { allowError: true });
    assert(invalid.status === 400 && invalid.data?.error === "ERROR_WITH_FORMULA", "invalid formula was not rejected");

    const firstFormula = await request("POST", `/api/database/fields/table/${table.id}/`, {
      name: "First formula smoke",
      type: "formula",
      formula: `field('${numberField.name}') + 1`,
      formula_type: "text",
    });
    assert(firstFormula.formula_type === "number" && firstFormula.nullable === false, "server formula type/nullability mismatch");
    const secondFormula = await request("POST", `/api/database/fields/table/${table.id}/`, {
      name: "Second formula smoke",
      type: "formula",
      formula: `field('${firstFormula.name}') * 2`,
    });
    await request("PATCH", `/api/database/rows/table/${table.id}/${row.id}/`, {
      [`field_${numberField.id}`]: 4,
    });
    const formulaRow = await request("GET", `/api/database/rows/table/${table.id}/${row.id}/`);
    assert(formulaRow[`field_${firstFormula.id}`] === "5.00", "first dependent formula did not preserve source precision");
    assert(formulaRow[`field_${secondFormula.id}`] === "10.00", "second dependent formula did not preserve source precision");
    const circular = await request("PATCH", `/api/database/fields/${firstFormula.id}/`, {
      formula: `field('${secondFormula.name}')`,
    }, { allowError: true });
    assert(circular.status === 400 && circular.data?.error === "ERROR_WITH_FORMULA", "indirect circular formula was not rejected");
  });

  await step("search workspace", async () => {
    const data = await request("GET", `/api/search/workspace/${workspace.id}/?query=E2E`);
    assert(Array.isArray(data.results), "workspace search invalid");
  });

  await step("automation publish dispatch and history", async () => {
    const textField = fields.find((item) => item.type === "text");
    assert(textField?.id, "automation smoke text field missing");
    const automation = await request("POST", `/api/applications/workspace/${workspace.id}/`, {
      name: "E2E automation",
      type: "automation",
    });
    const workflows = await request("GET", `/api/automation/${automation.id}/workflows/`);
    assert(workflows.length > 0, "automation workflow missing");
    const workflow = workflows[0];
    const invalidNodeType = await request("POST", `/api/automation/workflow/${workflow.id}/nodes/`, {
      type: "unknown_node_type",
    }, { allowError: true });
    assert(
      invalidNodeType.status === 400 && invalidNodeType.data?.error === "ERROR_REQUEST_BODY_VALIDATION",
      "automation unknown node type did not return the Baserow validation contract"
    );
    const workflowCreateSession = `automation-workflow-create-${stamp}`;
    const orderProbeWorkflow = await request("POST", `/api/automation/${automation.id}/workflows/`, {
      name: "Order probe",
    }, {
      headers: { ClientSessionId: workflowCreateSession },
    });
    const undoWorkflowCreate = await request("PATCH", "/api/user/undo/", {
      scopes: { application: automation.id },
    }, {
      headers: { ClientSessionId: workflowCreateSession },
    });
    assert(
      undoWorkflowCreate.result_code === "SUCCESS" &&
        undoWorkflowCreate.actions?.[0]?.action_type === "create_automation_workflow",
      "automation workflow create undo did not execute"
    );
    const workflowsAfterCreateUndo = await request("GET", `/api/automation/${automation.id}/workflows/`);
    assert(!workflowsAfterCreateUndo.some((item) => item.id === orderProbeWorkflow.id), "automation workflow create undo left the workflow active");
    const redoWorkflowCreate = await request("PATCH", "/api/user/redo/", {
      scopes: { application: automation.id },
    }, {
      headers: { ClientSessionId: workflowCreateSession },
    });
    assert(
      redoWorkflowCreate.result_code === "SUCCESS" &&
        redoWorkflowCreate.actions?.[0]?.action_type === "create_automation_workflow",
      "automation workflow create redo did not execute"
    );
    const workflowsAfterCreateRedo = await request("GET", `/api/automation/${automation.id}/workflows/`);
    assert(workflowsAfterCreateRedo.some((item) => item.id === orderProbeWorkflow.id), "automation workflow create redo did not restore the workflow");
    await request("POST", `/api/automation/${automation.id}/workflows/order/`, {
      workflow_ids: [orderProbeWorkflow.id, workflow.id],
    });
    const reorderedWorkflows = await request("GET", `/api/automation/${automation.id}/workflows/`);
    assert(
      reorderedWorkflows[0]?.id === orderProbeWorkflow.id && reorderedWorkflows[1]?.id === workflow.id,
      "automation workflow order did not use the automation-scoped source contract"
    );
    await request("DELETE", `/api/automation/workflows/${orderProbeWorkflow.id}/`);
    const webhookUid = crypto.randomUUID();
    const trigger = await request("POST", `/api/automation/workflow/${workflow.id}/nodes/`, {
      type: "http_trigger",
      label: "Smoke webhook",
      service: { uid: webhookUid, is_public: true },
    });
    assert(trigger.type === "http_trigger" && trigger.service.uid === webhookUid, "automation HTTP trigger was not created");
    const duplicateTrigger = await request("POST", `/api/automation/node/${trigger.id}/duplicate/`, undefined, { allowError: true });
    assert(
      duplicateTrigger.status === 400 && duplicateTrigger.data?.error === "ERROR_AUTOMATION_TRIGGER_ALREADY_EXISTS",
      "automation trigger duplication did not return the Baserow trigger collision contract"
    );
    const oversizedNodeLabel = await request("PATCH", `/api/automation/node/${trigger.id}/`, {
      label: "x".repeat(76),
    }, { allowError: true });
    assert(
      oversizedNodeLabel.status === 400 && oversizedNodeLabel.data?.error === "ERROR_REQUEST_BODY_VALIDATION",
      "automation oversized node label did not return the Baserow validation contract"
    );
    const invalidTriggerUid = await request("PATCH", `/api/automation/node/${trigger.id}/`, {
      service: { uid: "not-a-uuid" },
    }, { allowError: true });
    assert(
      invalidTriggerUid.status === 400 && invalidTriggerUid.data?.error === "ERROR_REQUEST_BODY_VALIDATION",
      "automation invalid webhook uid did not return the Baserow validation contract"
    );
    const nodeCreateSession = `automation-node-create-${stamp}`;
    const action = await request("POST", `/api/automation/workflow/${workflow.id}/nodes/`, {
      type: "local_baserow_create_row",
      label: "Create smoke row",
      reference_node_id: trigger.id,
      position: "south",
      service: {
        table_id: table.id,
        field_mappings: [
          { field_id: textField.id, value: { formula: "get('trigger.body.name')" } },
        ],
      },
    }, {
      headers: { ClientSessionId: nodeCreateSession },
    });
    assert(action.type === "local_baserow_create_row", "automation action was not created");
    const undoNodeCreate = await request("PATCH", "/api/user/undo/", {
      scopes: { workflow: workflow.id },
    }, {
      headers: { ClientSessionId: nodeCreateSession },
    });
    assert(
      undoNodeCreate.result_code === "SUCCESS" && undoNodeCreate.actions?.[0]?.action_type === "create_automation_node",
      "automation node create undo did not execute"
    );
    const nodesAfterCreateUndo = await request("GET", `/api/automation/workflow/${workflow.id}/nodes/`);
    assert(!nodesAfterCreateUndo.some((node) => node.id === action.id), "automation node create undo left the node active");
    const redoNodeCreate = await request("PATCH", "/api/user/redo/", {
      scopes: { workflow: workflow.id },
    }, {
      headers: { ClientSessionId: nodeCreateSession },
    });
    assert(
      redoNodeCreate.result_code === "SUCCESS" && redoNodeCreate.actions?.[0]?.action_type === "create_automation_node",
      "automation node create redo did not execute"
    );
    const nodes = await request("GET", `/api/automation/workflow/${workflow.id}/nodes/`);
    assert(nodes.some((node) => node.id === trigger.id) && nodes.some((node) => node.id === action.id), "automation nodes list missing trigger or action");
    const invalidFieldMapping = await request("PATCH", `/api/automation/node/${action.id}/`, {
      service: {
        field_mappings: [{ field_id: 2147483647, value: { formula: "invalid" } }],
      },
    }, { allowError: true });
    assert(
      invalidFieldMapping.status === 400 && invalidFieldMapping.data?.error === "ERROR_REQUEST_BODY_VALIDATION",
      "automation invalid field mapping did not return the Baserow validation contract"
    );
    const actionAfterInvalidMapping = (await request("GET", `/api/automation/workflow/${workflow.id}/nodes/`))
      .find((node) => node.id === action.id);
    assert(
      actionAfterInvalidMapping?.service?.field_mappings?.[0]?.field_id === textField.id,
      "automation invalid field mapping mutated the persisted node service"
    );
    const refinementProbe = await request("POST", `/api/automation/workflow/${workflow.id}/nodes/`, {
      type: "local_baserow_list_rows",
      label: "Refinement contract probe",
      reference_node_id: action.id,
      position: "south",
      service: {
        table_id: table.id,
        filters: [{ id: crypto.randomUUID(), field: textField.id, type: "contains", value: "smoke", value_is_formula: false }],
        sortings: [{ field: textField.id, order_by: "desc" }],
      },
    });
    assert(
      refinementProbe.service.filters?.[0]?.field === textField.id
        && refinementProbe.service.filters?.[0]?.field_id === undefined
        && refinementProbe.service.sortings?.[0]?.field === textField.id
        && refinementProbe.service.sortings?.[0]?.order_by === "DESC",
      "automation Local Baserow refinements did not return the frontend field contract"
    );
    await request("DELETE", `/api/automation/node/${refinementProbe.id}/`);

    const simulateOn = await request("POST", `/api/automation/node/${action.id}/simulate-dispatch/`);
    assert(simulateOn.simulate_until_node_id === action.id, "automation simulate-dispatch did not mark target node");
    const simulateOff = await request("POST", `/api/automation/node/${action.id}/simulate-dispatch/`);
    assert(simulateOff.simulate_until_node_id === null, "automation simulate-dispatch did not toggle off");

    const testOn = await request("POST", `/api/automation/workflows/${workflow.id}/test/`);
    assert(testOn.allow_test_run_until, "automation test run did not enable a temporary run window");
    const testOff = await request("POST", `/api/automation/workflows/${workflow.id}/test/`);
    assert(testOff.allow_test_run_until === null, "automation test run did not toggle off");

    const duplicateStarted = await request("POST", `/api/automation/workflows/${workflow.id}/duplicate/async/`);
    assert(duplicateStarted.state === "pending" && duplicateStarted.original_automation_workflow?.id === workflow.id, "automation workflow duplicate job was not queued");
    const duplicated = await pollJob(duplicateStarted, "automation workflow duplicate");
    assert(duplicated.duplicated_automation_workflow?.id, "automation workflow duplicate did not finish");
    assert(duplicated.duplicated_automation_workflow.graph?.["0"], "duplicated automation workflow graph is missing trigger root");

    const nodeTrashWorkflowId = duplicated.duplicated_automation_workflow.id;
    const nodeTrashWorkflowNodes = await request("GET", `/api/automation/workflow/${nodeTrashWorkflowId}/nodes/`);
    const nodeTrashAction = nodeTrashWorkflowNodes.find((item) => item.type === "local_baserow_create_row");
    assert(nodeTrashAction?.id, "automation node trash probe action is missing");
    await request("DELETE", `/api/automation/node/${nodeTrashAction.id}/`);
    const nodeTrashContents = await request(
      "GET",
      `/api/trash/workspace/${workspace.id}/?application_id=${automation.id}`
    );
    assert(
      nodeTrashContents.results.some((item) =>
        item.trash_item_type === "automation_node" && item.trash_item_id === nodeTrashAction.id
      ),
      "deleted automation node was not listed in application trash"
    );
    await request("PATCH", `/api/trash/automation_node/${nodeTrashAction.id}/restore/`);
    const restoredNodeTrashWorkflowNodes = await request("GET", `/api/automation/workflow/${nodeTrashWorkflowId}/nodes/`);
    assert(
      restoredNodeTrashWorkflowNodes.some((item) => item.id === nodeTrashAction.id),
      "restored automation node was not reinserted into its workflow"
    );
    await request("DELETE", `/api/automation/node/${nodeTrashAction.id}/`);
    await request("DELETE", `/api/trash/automation_node/${nodeTrashAction.id}/?workspace_id=${workspace.id}`);
    const nodesAfterPermanentNodeDelete = await request("GET", `/api/automation/workflow/${nodeTrashWorkflowId}/nodes/`);
    assert(
      !nodesAfterPermanentNodeDelete.some((item) => item.id === nodeTrashAction.id),
      "permanently deleted automation node still exists"
    );

    const publishStarted = await request("POST", `/api/automation/workflows/${workflow.id}/publish/async/`);
    assert(publishStarted.state === "pending" && publishStarted.automation_workflow_id === workflow.id, "automation publish job was not queued");
    const publishJob = await pollJob(publishStarted, "automation workflow publish");
    assert(publishJob.published_automation_workflow_id, "automation publish did not finish");
    const publishedWorkflow = await request("GET", `/api/automation/workflows/${workflow.id}/`);
    assert(publishedWorkflow.state === "live" && publishedWorkflow.published_on, "automation workflow did not expose live published state");

    const createdText = `automation webhook ${stamp}`;
    const webhook = await rawRequest("POST", `/api/webhooks/${webhookUid}/`, { name: createdText }, { auth: false });
    assert(webhook.status === 204, "automation public webhook did not return 204");
    const tableRows = await request("GET", `/api/database/rows/table/${table.id}/?size=1000`);
    const createdRow = tableRows.results.find((item) => item[`field_${textField.id}`] === createdText);
    assert(createdRow?.id, "automation webhook did not create a row with the dynamic body value");

    const history = await request("GET", `/api/automation/workflows/${workflow.id}/history/`);
    assert(history.count >= 1 && history.results[0]?.status === "success", "automation history did not record the successful webhook run");
    const nodeHistory = await request("GET", `/api/automation/workflows/${workflow.id}/history/${history.results[0].id}/nodes/`);
    assert(nodeHistory.some((item) => item.node?.type === "http_trigger" && item.status === "success"), "automation trigger node history missing");
    assert(nodeHistory.some((item) => item.node?.type === "local_baserow_create_row" && item.status === "success"), "automation action node history missing");

    const duplicateAutomationJob = await request("POST", `/api/applications/${automation.id}/duplicate/async/`, {});
    assert(
      duplicateAutomationJob.state === "finished" && duplicateAutomationJob.duplicated_application?.type === "automation",
      "automation application duplicate did not finish"
    );
    const duplicatedAutomation = duplicateAutomationJob.duplicated_application;
    const duplicatedWorkflow = duplicatedAutomation.workflows.find((item) => item.name === workflow.name);
    assert(
      duplicatedWorkflow?.id && duplicatedWorkflow.id !== workflow.id && duplicatedWorkflow.state === "live",
      "automation duplicate did not preserve the live workflow"
    );
    const duplicatedIntegrations = duplicatedAutomation.integrations.filter((item) => item.type === "local_baserow");
    assert(duplicatedIntegrations.length >= 1, "automation duplicate did not preserve integrations");
    const duplicatedNodes = await request("GET", `/api/automation/workflow/${duplicatedWorkflow.id}/nodes/`);
    const duplicatedTrigger = duplicatedNodes.find((item) => item.type === "http_trigger");
    const duplicatedAction = duplicatedNodes.find((item) => item.type === "local_baserow_create_row");
    assert(
      duplicatedTrigger?.service?.uid && duplicatedTrigger.service.uid !== webhookUid,
      "automation duplicate did not create a fresh webhook uid"
    );
    assert(
      duplicatedAction?.service?.integration_id && duplicatedAction.service.integration_id !== action.service.integration_id,
      "automation duplicate did not remap the action integration"
    );
    const duplicatedWebhookValue = `duplicated automation webhook ${stamp}`;
    const duplicatedWebhook = await rawRequest("POST", `/api/webhooks/${duplicatedTrigger.service.uid}/`, { name: duplicatedWebhookValue }, { auth: false });
    assert(duplicatedWebhook.status === 204, "duplicated automation webhook did not return 204");
    const rowsAfterDuplicatedWebhook = await request("GET", `/api/database/rows/table/${table.id}/?size=1000`);
    assert(
      rowsAfterDuplicatedWebhook.results.some((item) => item[`field_${textField.id}`] === duplicatedWebhookValue),
      "duplicated automation webhook did not create a row"
    );
    const replacedAction = await request("POST", `/api/automation/node/${duplicatedAction.id}/replace/`, {
      new_type: "http_request",
    });
    assert(
      replacedAction.type === "http_request" && replacedAction.id !== duplicatedAction.id,
      "automation node replacement did not return a new node id"
    );
    const nodesAfterReplacement = await request("GET", `/api/automation/workflow/${duplicatedWorkflow.id}/nodes/`);
    assert(
      !nodesAfterReplacement.some((item) => item.id === duplicatedAction.id) &&
        nodesAfterReplacement.some((item) => item.id === replacedAction.id && item.type === "http_request"),
      "automation node replacement did not update the workflow graph and node list"
    );
    const invalidHttpMethod = await request("PATCH", `/api/automation/node/${replacedAction.id}/`, {
      service: { http_method: "TRACE" },
    }, { allowError: true });
    assert(
      invalidHttpMethod.status === 400 && invalidHttpMethod.data?.error === "ERROR_REQUEST_BODY_VALIDATION",
      "automation HTTP service accepted an unsupported method"
    );
    const invalidHttpFormula = await request("PATCH", `/api/automation/node/${replacedAction.id}/`, {
      service: { url: { formula: "concat(" } },
    }, { allowError: true });
    assert(
      invalidHttpFormula.status === 400 && invalidHttpFormula.data?.error === "ERROR_REQUEST_BODY_VALIDATION",
      "automation HTTP service accepted an invalid formula"
    );
    const normalizedHttp = await request("PATCH", `/api/automation/node/${replacedAction.id}/`, {
      service: {
        http_method: "post",
        url: { formula: "https://example.com/smoke", mode: "raw" },
        body_type: "json",
        timeout: 15,
      },
    });
    assert(
      normalizedHttp.service.http_method === "POST"
        && normalizedHttp.service.url?.formula === "https://example.com/smoke"
        && normalizedHttp.service.timeout === 15,
      "automation HTTP service was not normalized with the Baserow contract"
    );
    const aiIntegration = await request("POST", `/api/application/${duplicatedAutomation.id}/integrations/`, {
      type: "ai",
      name: "Automation model validation",
      ai_settings: {
        openai: { api_key: "production-smoke-not-dispatched", models: ["smoke-model"] },
      },
    });
    const aiReplacement = await request("POST", `/api/automation/node/${replacedAction.id}/replace/`, {
      new_type: "ai_agent",
    });
    const configuredAi = await request("PATCH", `/api/automation/node/${aiReplacement.id}/`, {
      service: {
        integration_id: aiIntegration.id,
        ai_generative_ai_type: "openai",
        ai_generative_ai_model: "smoke-model",
        ai_output_type: "text",
        ai_prompt: { formula: "Production smoke", mode: "raw" },
      },
    });
    assert(configuredAi.service.ai_generative_ai_model === "smoke-model", "automation AI service rejected an enabled integration model");
    const unavailableAiModel = await request("PATCH", `/api/automation/node/${aiReplacement.id}/`, {
      service: { ai_generative_ai_model: "not-enabled" },
    }, { allowError: true });
    assert(
      unavailableAiModel.status === 400 && unavailableAiModel.data?.error === "ERROR_REQUEST_BODY_VALIDATION",
      "automation AI service accepted a model not enabled by its integration"
    );
    const workspaceAiIntegration = await request("POST", `/api/application/${duplicatedAutomation.id}/integrations/`, {
      type: "ai",
      name: "Automation workspace model fallback",
      ai_settings: {},
    });
    const workspaceConfiguredAi = await request("PATCH", `/api/automation/node/${aiReplacement.id}/`, {
      service: {
        integration_id: workspaceAiIntegration.id,
        ai_generative_ai_type: "openai",
        ai_generative_ai_model: "smoke-test-model",
        ai_output_type: "text",
        ai_prompt: { formula: "Workspace model fallback", mode: "raw" },
      },
    });
    assert(
      workspaceConfiguredAi.service.integration_id === workspaceAiIntegration.id &&
        workspaceConfiguredAi.service.ai_generative_ai_model === "smoke-test-model",
      "automation AI service did not inherit the enabled workspace model"
    );
    const unavailableWorkspaceAiModel = await request("PATCH", `/api/automation/node/${aiReplacement.id}/`, {
      service: { ai_generative_ai_model: "workspace-model-not-enabled" },
    }, { allowError: true });
    assert(
      unavailableWorkspaceAiModel.status === 400 && unavailableWorkspaceAiModel.data?.error === "ERROR_REQUEST_BODY_VALIDATION",
      "automation AI service accepted a model not enabled by workspace fallback settings"
    );
    const aiAfterWorkspaceModelRejection = (await request("GET", `/api/automation/workflow/${duplicatedWorkflow.id}/nodes/`))
      .find((node) => node.id === aiReplacement.id);
    assert(
      aiAfterWorkspaceModelRejection?.service?.integration_id === workspaceAiIntegration.id &&
        aiAfterWorkspaceModelRejection?.service?.ai_generative_ai_model === "smoke-test-model",
      "automation workspace model rejection mutated the persisted AI service"
    );

    await request("DELETE", `/api/automation/workflows/${workflow.id}/`);
    const deletedWebhook = await rawRequest("POST", `/api/webhooks/${webhookUid}/`, { name: "deleted" }, { auth: false });
    assert(deletedWebhook.status === 404, "deleted automation kept its published webhook active");
    const workflowsAfterDelete = await request("GET", `/api/automation/${automation.id}/workflows/`);
    assert(
      !workflowsAfterDelete.some((item) => item.id === workflow.id),
      "reading automation workflows resurrected a trashed workflow"
    );
    const applicationAfterDelete = await request("GET", `/api/applications/${automation.id}/`);
    assert(
      !applicationAfterDelete.workflows.some((item) => item.id === workflow.id),
      "reading the automation application resurrected a trashed workflow"
    );
    const automationTrash = await request(
      "GET",
      `/api/trash/workspace/${workspace.id}/?application_id=${automation.id}`
    );
    assert(
      automationTrash.results.some((item) =>
        item.trash_item_type === "automation_workflow" && item.trash_item_id === workflow.id
      ),
      "deleted automation workflow was not listed in application trash"
    );

    await request("PATCH", `/api/trash/automation_workflow/${workflow.id}/restore/`);
    const restoredWorkflowNodes = await request("GET", `/api/automation/workflow/${workflow.id}/nodes/`);
    assert(
      restoredWorkflowNodes.some((item) => item.id === trigger.id) &&
        restoredWorkflowNodes.some((item) => item.id === action.id),
      "restored automation workflow lost its graph nodes"
    );
    const unpublishedWebhook = await rawRequest("POST", `/api/webhooks/${webhookUid}/`, { name: "restored" }, { auth: false });
    assert(unpublishedWebhook.status === 404, "restoring a workflow incorrectly restored its deleted published version");

    await request("DELETE", `/api/automation/workflows/${workflow.id}/`);
    await request("DELETE", `/api/trash/automation_workflow/${workflow.id}/?workspace_id=${workspace.id}`);
    const workflowsAfterPermanentDelete = await request("GET", `/api/automation/${automation.id}/workflows/`);
    assert(
      !workflowsAfterPermanentDelete.some((item) => item.id === workflow.id),
      "permanently deleted automation workflow still exists"
    );
    const trashAfterPermanentDelete = await request(
      "GET",
      `/api/trash/workspace/${workspace.id}/?application_id=${automation.id}`
    );
    assert(
      !trashAfterPermanentDelete.results.some((item) =>
        item.trash_item_type === "automation_workflow" && item.trash_item_id === workflow.id
      ),
      "permanently deleted automation workflow stayed in trash"
    );
  });

  await step("automation router iterator dispatch", async () => {
    const textField = fields.find((item) => item.type === "text");
    assert(textField?.id, "automation router/iterator text field missing");

    const routerAutomation = await request("POST", `/api/applications/workspace/${workspace.id}/`, {
      name: "E2E automation router",
      type: "automation",
    });
    const routerWorkflow = (await request("GET", `/api/automation/${routerAutomation.id}/workflows/`))[0];
    const routerWebhookUid = crypto.randomUUID();
    const routerEdgeUid = crypto.randomUUID();
    const routerTrigger = await request("POST", `/api/automation/workflow/${routerWorkflow.id}/nodes/`, {
      type: "http_trigger",
      label: "Router trigger",
      service: { uid: routerWebhookUid, is_public: true },
    });
    const routerNode = await request("POST", `/api/automation/workflow/${routerWorkflow.id}/nodes/`, {
      type: "router",
      label: "Router branch",
      reference_node_id: routerTrigger.id,
      position: "south",
      service: {
        edges: [
          {
            uid: routerEdgeUid,
            label: "Go",
            condition: { formula: "get('trigger.body.route') = 'go'" },
          },
        ],
      },
    });
    const invalidRouterEdge = await request("PATCH", `/api/automation/node/${routerNode.id}/`, {
      service: { edges: [{ uid: "invalid", label: "Go", condition: { formula: "true" } }] },
    }, { allowError: true });
    assert(
      invalidRouterEdge.status === 400 && invalidRouterEdge.data?.error === "ERROR_REQUEST_BODY_VALIDATION",
      "automation router accepted an invalid edge uid"
    );
    const emptyRouter = await request("PATCH", `/api/automation/node/${routerNode.id}/`, {
      service: { edges: [] },
    });
    assert(Array.isArray(emptyRouter.service.edges) && emptyRouter.service.edges.length === 0, "automation router did not preserve an explicit empty edge list");
    const restoredRouter = await request("PATCH", `/api/automation/node/${routerNode.id}/`, {
      service: {
        edges: [{
          uid: routerEdgeUid,
          label: "Go",
          condition: { formula: "get('trigger.body.route') = 'go'" },
        }],
      },
    });
    assert(restoredRouter.service.edges?.[0]?.uid === routerEdgeUid, "automation router edge was not restored after the empty-list probe");
    await request("POST", `/api/automation/workflow/${routerWorkflow.id}/nodes/`, {
      type: "local_baserow_create_row",
      label: "Router create row",
      reference_node_id: routerNode.id,
      position: "south",
      output: routerEdgeUid,
      service: {
        table_id: table.id,
        field_mappings: [
          { field_id: textField.id, value: { formula: "concat('router ', get('trigger.body.name'))" } },
        ],
      },
    });
    await pollJob(
      await request("POST", `/api/automation/workflows/${routerWorkflow.id}/publish/async/`),
      "automation router workflow publish"
    );

    const routerCreatedText = `router accepted ${stamp}`;
    const routerAccepted = await rawRequest(
      "POST",
      `/api/webhooks/${routerWebhookUid}/`,
      { route: "go", name: `accepted ${stamp}` },
      { auth: false }
    );
    assert(routerAccepted.status === 204, "automation router accepted webhook did not return 204");

    const routerBlockedText = `router blocked ${stamp}`;
    const routerBlocked = await rawRequest(
      "POST",
      `/api/webhooks/${routerWebhookUid}/`,
      { route: "stop", name: `blocked ${stamp}` },
      { auth: false }
    );
    assert(routerBlocked.status === 204, "automation router blocked webhook did not return 204");
    const routerRows = await request("GET", `/api/database/rows/table/${table.id}/?size=1000`);
    assert(routerRows.results.some((item) => item[`field_${textField.id}`] === routerCreatedText), "automation router branch did not create the expected row");
    assert(!routerRows.results.some((item) => item[`field_${textField.id}`] === routerBlockedText), "automation router default branch unexpectedly created a row");

    const periodicAutomation = await request("POST", `/api/applications/workspace/${workspace.id}/`, {
      name: "E2E automation periodic validation",
      type: "automation",
    });
    const periodicWorkflow = (await request("GET", `/api/automation/${periodicAutomation.id}/workflows/`))[0];
    const periodicTrigger = await request("POST", `/api/automation/workflow/${periodicWorkflow.id}/nodes/`, {
      type: "periodic",
      service: { interval: "minute", minute: 1 },
    });
    assert(periodicTrigger.service.interval === "MINUTE" && periodicTrigger.service.minute === 1, "automation periodic service was not normalized");
    const invalidPeriodicMinute = await request("PATCH", `/api/automation/node/${periodicTrigger.id}/`, {
      service: { minute: 0 },
    }, { allowError: true });
    assert(
      invalidPeriodicMinute.status === 400
        && invalidPeriodicMinute.data?.error === "ERROR_AUTOMATION_NODE_MISCONFIGURED_SERVICE",
      "automation periodic service accepted a minute interval below the Baserow minimum"
    );

    const iteratorAutomation = await request("POST", `/api/applications/workspace/${workspace.id}/`, {
      name: "E2E automation iterator",
      type: "automation",
    });
    const iteratorWorkflow = (await request("GET", `/api/automation/${iteratorAutomation.id}/workflows/`))[0];
    const iteratorWebhookUid = crypto.randomUUID();
    const iteratorTrigger = await request("POST", `/api/automation/workflow/${iteratorWorkflow.id}/nodes/`, {
      type: "http_trigger",
      label: "Iterator trigger",
      service: { uid: iteratorWebhookUid, is_public: true },
    });
    const iteratorNode = await request("POST", `/api/automation/workflow/${iteratorWorkflow.id}/nodes/`, {
      type: "iterator",
      label: "Iterator loop",
      reference_node_id: iteratorTrigger.id,
      position: "south",
      service: { source: { formula: "get('trigger.body.items')" } },
    });
    await request("POST", `/api/automation/workflow/${iteratorWorkflow.id}/nodes/`, {
      type: "local_baserow_create_row",
      label: "Iterator create rows",
      reference_node_id: iteratorNode.id,
      position: "child",
      service: {
        table_id: table.id,
        field_mappings: [
          { field_id: textField.id, value: { formula: `concat('iter ', get('current_iteration.${iteratorNode.id}.item.name'))` } },
        ],
      },
    });
    await pollJob(
      await request("POST", `/api/automation/workflows/${iteratorWorkflow.id}/publish/async/`),
      "automation iterator workflow publish"
    );

    const iteratorWebhook = await rawRequest(
      "POST",
      `/api/webhooks/${iteratorWebhookUid}/`,
      { items: [{ name: `one ${stamp}` }, { name: `two ${stamp}` }] },
      { auth: false }
    );
    assert(iteratorWebhook.status === 204, "automation iterator webhook did not return 204");
    const iteratorRows = await request("GET", `/api/database/rows/table/${table.id}/?size=1000`);
    assert(iteratorRows.results.some((item) => item[`field_${textField.id}`] === `iter one ${stamp}`), "automation iterator did not create first iterated row");
    assert(iteratorRows.results.some((item) => item[`field_${textField.id}`] === `iter two ${stamp}`), "automation iterator did not create second iterated row");

    const iteratorHistory = await request("GET", `/api/automation/workflows/${iteratorWorkflow.id}/history/`);
    assert(iteratorHistory.count >= 1 && iteratorHistory.results[0]?.status === "success", "automation iterator history did not record success");
    const iteratorNodeHistory = await request("GET", `/api/automation/workflows/${iteratorWorkflow.id}/history/${iteratorHistory.results[0].id}/nodes/`);
    const iteratedActionRuns = iteratorNodeHistory.filter((item) => item.node?.type === "local_baserow_create_row" && item.status === "success");
    assert(iteratedActionRuns.length >= 2, "automation iterator did not record one action run per item");
  });

  await step("builder publish runtime datasource workflow", async () => {
    const textField = fields.find((item) => item.type === "text");
    const fileField = fields.find((item) => item.type === "file");
    assert(textField?.id && fileField?.id, "builder smoke text or file field missing");

    const builderApp = await request("POST", `/api/applications/workspace/${workspace.id}/`, {
      name: "E2E builder",
      type: "builder",
    });
    assert(builderApp.id, "builder application id missing");

    const defaultPages = await request("GET", `/api/builder/${builderApp.id}/pages/`);
    const sharedPage = defaultPages.find((item) => item.shared === true);
    assert(sharedPage?.id, "builder shared page missing");
    assert(defaultPages.some((item) => item.path === "/"), "builder home page missing");

    const customCss = `.builder-smoke-${stamp}{color:rgb(20,30,40);}`;
    const customJs = `window.__builderSmoke${stamp}=true;`;
    const patchedBuilderApp = await request("PATCH", `/api/applications/${builderApp.id}/`, {
      custom_code: { css: customCss, js: customJs },
      scripts: [
        { type: "stylesheet", url: "https://example.com/smoke.css", load_type: "", crossorigin: "" },
        { type: "javascript", url: "https://example.com/smoke.js", load_type: "defer", crossorigin: "anonymous" },
      ],
    });
    assert(
      patchedBuilderApp.custom_code?.css === customCss && patchedBuilderApp.custom_code?.js === customJs,
      "builder custom code did not persist"
    );
    assert(
      patchedBuilderApp.scripts?.length === 2 && patchedBuilderApp.scripts[1].load_type === "defer",
      "builder custom scripts did not persist"
    );
    const previewCss = await rawRequest("GET", `/api/custom_code/${builderApp.id}/css/`);
    const previewCssText = await previewCss.text();
    assert(
      previewCss.ok && (previewCss.headers.get("content-type") || "").includes("text/css") && previewCssText === customCss,
      "builder preview custom CSS endpoint failed"
    );
    const previewJs = await rawRequest("GET", `/api/custom_code/${builderApp.id}/js/`);
    const previewJsText = await previewJs.text();
    assert(
      previewJs.ok && (previewJs.headers.get("content-type") || "").includes("application/javascript") && previewJsText === customJs,
      "builder preview custom JS endpoint failed"
    );

    const page = await request("POST", `/api/builder/${builderApp.id}/pages/`, {
      name: "Smoke page",
      path: `/builder-smoke-${stamp}`,
      path_params: [],
      query_params: [],
    });
    assert(page.id && page.path === `/builder-smoke-${stamp}`, "builder page was not created with the expected path");

    const patchedPage = await request("PATCH", `/api/builder/pages/${page.id}/`, {
      name: "Smoke page updated",
      visibility: "all",
    });
    assert(patchedPage.name === "Smoke page updated", "builder page update did not persist");

    const invalidHeaderRoot = await request("POST", `/api/builder/page/${page.id}/elements/`, {
      type: "header",
    }, { allowError: true });
    assert(invalidHeaderRoot.status === 400, "builder accepted a multi-page header on a regular page");
    const header = await request("POST", `/api/builder/page/${sharedPage.id}/elements/`, { type: "header" });
    assert(header.type === "header" && header.page_id === sharedPage.id, "builder shared header placement failed");
    const invalidSharedText = await request("POST", `/api/builder/page/${sharedPage.id}/elements/`, {
      type: "text",
      value: "'Invalid root'",
    }, { allowError: true });
    assert(invalidSharedText.status === 400, "builder accepted a regular root element on the shared page");
    const sharedMenu = await request("POST", `/api/builder/page/${sharedPage.id}/elements/`, {
      type: "menu",
      parent_element_id: header.id,
    });
    assert(sharedMenu.parent_element_id === header.id, "builder shared container rejected a menu child");

    const passwordField = await request("POST", `/api/database/fields/table/${table.id}/`, {
      name: "Builder portal password",
      type: "password",
    });
    const portalEmail = `builder-portal-${stamp}@example.com`;
    const portalPassword = `Builder-${stamp}!`;
    const portalRow = await request("POST", `/api/database/rows/table/${table.id}/`, {
      [`field_${textField.id}`]: portalEmail,
      [`field_${passwordField.id}`]: portalPassword,
    });
    assert(portalRow[`field_${passwordField.id}`] === true, "builder user source password was not stored write-only");

    const localIntegration = await request("POST", `/api/application/${builderApp.id}/integrations/`, {
      type: "local_baserow",
      name: "Builder portal database",
    });
    const userSource = await request("POST", `/api/application/${builderApp.id}/user-sources/`, {
      type: "local_baserow",
      name: "Builder portal users",
      integration_id: localIntegration.id,
      table_id: table.id,
      email_field_id: textField.id,
      name_field_id: textField.id,
      role_field_id: null,
      auth_providers: [{
        type: "local_baserow_password",
        password_field_id: passwordField.id,
      }],
    });
    assert(
      userSource.auth_providers?.[0]?.type === "local_baserow_password" &&
        userSource.auth_providers[0].password_field_id === passwordField.id,
      "builder user source did not serialize its password provider"
    );
    const invalidUserSource = await request("PATCH", `/api/user-source/${userSource.id}/`, {
      email_field_id: fileField.id,
    }, { allowError: true });
    assert(
      invalidUserSource.status === 400 &&
        invalidUserSource.data?.error === "ERROR_REQUEST_BODY_VALIDATION" &&
        invalidUserSource.data?.detail?.email_field_id?.[0]?.code === "invalid_field",
      "builder user source accepted an incompatible email field"
    );
    const authForm = await request("POST", `/api/builder/page/${page.id}/elements/`, {
      type: "auth_form",
      user_source_id: userSource.id,
      login_button_label: { formula: "'Sign in'", mode: "simple", version: "0.1" },
    });
    assert(authForm.user_source_id === userSource.id, "builder auth form did not keep its user source");

    const portalLogin = await request("POST", `/api/user-source/${userSource.id}/token-auth`, {
      email: portalEmail.toUpperCase(),
      password: portalPassword,
    }, { auth: false });
    assert(portalLogin.access_token && portalLogin.refresh_token, "builder user source login did not return JWTs");
    const portalRefresh = await request("POST", "/api/user-source-auth-refresh/", {
      refresh_token: portalLogin.refresh_token,
    }, { auth: false });
    assert(portalRefresh.access_token && portalRefresh.refresh_token, "builder user source refresh did not rotate JWTs");
    await request("POST", "/api/user-source-token-blacklist/", {
      refresh_token: portalRefresh.refresh_token,
    }, { auth: false });
    const rejectedPortalRefresh = await request("POST", "/api/user-source-auth-refresh/", {
      refresh_token: portalRefresh.refresh_token,
    }, { auth: false, allowError: true });
    assert(rejectedPortalRefresh.status === 403, "builder user source blacklist did not invalidate the refresh token");

    const samlIssuer = `https://saml-${stamp}.example/metadata`;
    const samlMetadata = `
      <EntityDescriptor entityID="${samlIssuer}" xmlns="urn:oasis:names:tc:SAML:2.0:metadata">
        <IDPSSODescriptor>
          <SingleSignOnService Binding="urn:oasis:names:tc:SAML:2.0:bindings:HTTP-Redirect" Location="https://saml-${stamp}.example/sso"/>
        </IDPSSODescriptor>
      </EntityDescriptor>`;
    const ssoUserSource = await request("POST", `/api/application/${builderApp.id}/user-sources/`, {
      type: "local_baserow",
      name: "Builder SSO users",
      integration_id: localIntegration.id,
      table_id: table.id,
      email_field_id: textField.id,
      name_field_id: textField.id,
      role_field_id: null,
      auth_providers: [
        {
          id: 201,
          type: "saml",
          domain: "example.com",
          metadata: samlMetadata,
          email_attr_key: "email",
          first_name_attr_key: "first_name",
          last_name_attr_key: "last_name",
        },
        {
          id: 202,
          type: "openid_connect",
          name: "Google OpenID",
          base_url: "https://accounts.google.com",
          client_id: `smoke-client-${stamp}`,
          secret: `smoke-secret-${stamp}`,
          email_attr_key: "email",
          first_name_attr_key: "name",
          last_name_attr_key: "",
          use_id_token: false,
        },
      ],
    });
    const privateOidcProvider = ssoUserSource.auth_providers.find((provider) => provider.type === "openid_connect");
    assert(
      privateOidcProvider?.authorization_url && privateOidcProvider?.access_token_url && privateOidcProvider?.jwks_url,
      "builder OIDC provider discovery did not persist the well-known endpoints"
    );
    const ssoOriginal = `https://mbza.dev/builder-sso-${stamp}`;
    const oidcLogin = await rawRequest(
      "GET",
      `/api/user-source/${encodeURIComponent(ssoUserSource.uid)}/sso/oauth2/openid_connect/login/?iss=${encodeURIComponent("https://accounts.google.com")}&original=${encodeURIComponent(ssoOriginal)}`,
      undefined,
      { auth: false }
    );
    const oidcLocation = new URL(oidcLogin.headers.get("location"));
    assert(
      oidcLogin.status === 302 && oidcLocation.host === "accounts.google.com" &&
        oidcLocation.searchParams.get("code_challenge_method") === "S256" &&
        oidcLocation.searchParams.get("state") && oidcLocation.searchParams.get("nonce"),
      "builder OIDC login did not return the discovered PKCE/nonce authorization redirect"
    );

    const ssoEmail = `builder-saml-${stamp}@example.com`;
    const samlLogin = await rawRequest(
      "GET",
      `/api/user-source/${encodeURIComponent(ssoUserSource.uid)}/sso/saml/login/?email=${encodeURIComponent(ssoEmail)}&original=${encodeURIComponent(ssoOriginal)}`,
      undefined,
      { auth: false }
    );
    const samlLocation = new URL(samlLogin.headers.get("location"));
    const samlRelayState = samlLocation.searchParams.get("RelayState");
    assert(
      samlLogin.status === 302 && samlLocation.host === `saml-${stamp}.example` &&
        samlLocation.searchParams.get("SAMLRequest") && samlRelayState?.includes("_baserow_saml_state="),
      "builder SAML login did not return the IdP redirect with one-time RelayState"
    );
    const samlAcsUrl = `${baseUrl}/api/user-source/sso/saml/acs/`;
    const samlNotBefore = new Date(Date.now() - 60_000).toISOString();
    const samlNotOnOrAfter = new Date(Date.now() + 300_000).toISOString();
    const samlResponseXml = `
      <samlp:Response xmlns:samlp="urn:oasis:names:tc:SAML:2.0:protocol" xmlns:saml="urn:oasis:names:tc:SAML:2.0:assertion" ID="_response" Version="2.0" IssueInstant="${new Date().toISOString()}" Destination="${samlAcsUrl}">
        <saml:Issuer>${samlIssuer}</saml:Issuer>
        <samlp:Status><samlp:StatusCode Value="urn:oasis:names:tc:SAML:2.0:status:Success"/></samlp:Status>
        <saml:Assertion ID="_assertion" Version="2.0" IssueInstant="${new Date().toISOString()}">
          <saml:Issuer>${samlIssuer}</saml:Issuer>
          <saml:Subject><saml:NameID>${ssoEmail}</saml:NameID><saml:SubjectConfirmation Method="urn:oasis:names:tc:SAML:2.0:cm:bearer"><saml:SubjectConfirmationData Recipient="${samlAcsUrl}" NotOnOrAfter="${samlNotOnOrAfter}"/></saml:SubjectConfirmation></saml:Subject>
          <saml:Conditions NotBefore="${samlNotBefore}" NotOnOrAfter="${samlNotOnOrAfter}"><saml:AudienceRestriction><saml:Audience>${samlAcsUrl}</saml:Audience></saml:AudienceRestriction></saml:Conditions>
          <saml:AttributeStatement><saml:Attribute Name="email"><saml:AttributeValue>${ssoEmail}</saml:AttributeValue></saml:Attribute><saml:Attribute Name="first_name"><saml:AttributeValue>Production</saml:AttributeValue></saml:Attribute><saml:Attribute Name="last_name"><saml:AttributeValue>SSO</saml:AttributeValue></saml:Attribute></saml:AttributeStatement>
        </saml:Assertion>
      </samlp:Response>`;
    const samlForm = new FormData();
    samlForm.set("SAMLResponse", Buffer.from(samlResponseXml).toString("base64"));
    samlForm.set("RelayState", samlRelayState);
    const samlCompleted = await rawRequest("POST", "/api/user-source/sso/saml/acs/", samlForm, { auth: false });
    const samlCompletedLocation = new URL(samlCompleted.headers.get("location"));
    const samlRefreshToken = samlCompletedLocation.searchParams.get(`user_source_saml_token__${ssoUserSource.id}`);
    assert(
      samlCompleted.status === 302 && `${samlCompletedLocation.origin}${samlCompletedLocation.pathname}` === ssoOriginal && samlRefreshToken,
      `builder SAML ACS did not create the user and return its user-source refresh token: ${samlCompleted.status} ${samlCompletedLocation.toString()} expected_source=${ssoUserSource.id}`
    );
    const samlRefresh = await request("POST", "/api/user-source-auth-refresh/", {
      refresh_token: samlRefreshToken,
    }, { auth: false });
    assert(samlRefresh.access_token && samlRefresh.refresh_token, "builder SAML refresh token was not usable");

    const elementsBeforeInvalidFormula = await request("GET", `/api/builder/page/${page.id}/elements/`);
    const invalidFormulaElement = await request("POST", `/api/builder/page/${page.id}/elements/`, {
      type: "heading",
      value: "not a formula",
    }, { allowError: true });
    assert(
      invalidFormulaElement.status === 400 && invalidFormulaElement.data?.error === "ERROR_REQUEST_BODY_VALIDATION",
      "builder accepted an invalid heading formula"
    );
    const elementsAfterInvalidFormula = await request("GET", `/api/builder/page/${page.id}/elements/`);
    assert(
      elementsAfterInvalidFormula.length === elementsBeforeInvalidFormula.length,
      "builder wrote an element after formula validation failed"
    );

    const element = await request("POST", `/api/builder/page/${page.id}/elements/`, {
      type: "heading",
      value: "'Builder smoke heading'",
    });
    assert(element.id && element.type === "heading", "builder heading element was not created");
    assert(
      element.level === 1 && element.visibility === "all" && element.role_type === "allow_all" &&
        element.style_padding_top === 10 && element.style_width === "normal" &&
        element.visibility_condition?.formula === "" && element.value?.formula === "'Builder smoke heading'",
      "builder heading did not expose Baserow model defaults"
    );

    const updatedElement = await request("PATCH", `/api/builder/element/${element.id}/`, {
      value: "'Builder smoke heading updated'",
    });
    assert(
      updatedElement.value?.formula === "'Builder smoke heading updated'" &&
        updatedElement.value?.mode === "simple" && updatedElement.value?.version === "0.1",
      "builder element formula update did not persist the normalized configuration"
    );

    const column = await request("POST", `/api/builder/page/${page.id}/elements/`, {
      type: "column",
      column_amount: 3,
    });
    const columnChildren = [];
    for (let place = 0; place < 3; place += 1) {
      columnChildren.push(await request("POST", `/api/builder/page/${page.id}/elements/`, {
        type: "text",
        value: `'Column child ${place}'`,
        parent_element_id: column.id,
        place_in_container: String(place),
      }));
    }
    const invalidColumnChild = await request("POST", `/api/builder/page/${page.id}/elements/`, {
      type: "text",
      value: "'Out of bounds'",
      parent_element_id: column.id,
      place_in_container: "3",
    }, { allowError: true });
    assert(invalidColumnChild.status === 400, "builder accepted a child outside the column range");
    const reducedColumn = await request("PATCH", `/api/builder/element/${column.id}/`, { column_amount: 1 });
    assert(reducedColumn.column_amount === 1, "builder column reduction did not persist");
    const reducedElements = await request("GET", `/api/builder/page/${page.id}/elements/`);
    const reducedChildren = reducedElements.filter((item) => item.parent_element_id === column.id);
    assert(
      reducedChildren.length === columnChildren.length && reducedChildren.every((item) => item.place_in_container === "0"),
      "builder did not move children out of removed column places"
    );

    const duplicated = await request("POST", `/api/builder/element/${element.id}/duplicate/`);
    const duplicatedElement = duplicated.elements?.[0];
    assert(
      duplicated.elements?.length === 1 && duplicated.workflow_actions?.length === 0 &&
        duplicatedElement.id !== element.id,
      "builder element duplicate did not return the Baserow collection contract"
    );
    await request("PATCH", `/api/builder/element/${duplicatedElement.id}/move/`, { before_id: element.id });
    const elements = await request("GET", `/api/builder/page/${page.id}/elements/`);
    assert(elements.some((item) => item.id === element.id) && elements.some((item) => item.id === duplicatedElement.id), "builder elements list missing created elements");

    const dataSource = await request("POST", `/api/builder/page/${page.id}/data-sources/`, {
      type: "local_baserow_list_rows",
      name: "Smoke rows",
      table_id: table.id,
      default_result_count: 100,
    });
    assert(dataSource.id && dataSource.schema?.items?.properties?.[`field_${textField.id}`], "builder data source schema did not include the table text field");

    const dataSourceDispatch = await request("POST", `/api/builder/data-source/${dataSource.id}/dispatch/?count=1000`);
    assert(dataSourceDispatch.results?.some((item) => item.id === row.id), "builder authenticated data source dispatch did not return the existing row");

    const recordNames = await request("GET", `/api/builder/data-source/${dataSource.id}/record-names/?record_ids=${row.id}`);
    assert(recordNames[String(row.id)], "builder record names endpoint did not return the requested row");

    const workflowValue = `builder workflow ${stamp}`;
    const workflowAction = await request("POST", `/api/builder/page/${page.id}/workflow_actions/`, {
      type: "local_baserow_create_row",
      event: "click",
      element_id: element.id,
      service: {
        table_id: table.id,
        field_mappings: [{ field_id: textField.id, value: workflowValue }],
      },
    });
    assert(workflowAction.id && workflowAction.element_id === element.id, "builder workflow action was not created for the element");
    await request("POST", `/api/builder/page/${page.id}/workflow_actions/order/`, {
      workflow_action_ids: [workflowAction.id],
      element_id: element.id,
    });

    const duplicatedWithAction = await request("POST", `/api/builder/element/${element.id}/duplicate/`);
    assert(
      duplicatedWithAction.elements?.length === 1 && duplicatedWithAction.workflow_actions?.length === 1 &&
        duplicatedWithAction.workflow_actions[0].element_id === duplicatedWithAction.elements[0].id &&
        duplicatedWithAction.workflow_actions[0].id !== workflowAction.id,
      "builder element duplicate did not copy and remap its workflow action"
    );

    const workflowForm = new FormData();
    workflowForm.append("metadata", JSON.stringify({ source: "smoke" }));
    const workflowResult = await request("POST", `/api/builder/workflow_action/${workflowAction.id}/dispatch/`, workflowForm);
    assert(workflowResult?.[`field_${textField.id}`] === workflowValue, "builder workflow action did not create a row with the mapped value");

    const fileInput = await request("POST", `/api/builder/page/${page.id}/elements/`, {
      type: "input_file",
      label: { formula: "'Attachment'" },
      multiple: true,
      required: false,
      max_filesize: 1,
      allowed_filetypes: ["txt"],
      preview: false,
    });
    const fileAction = await request("POST", `/api/builder/page/${page.id}/workflow_actions/`, {
      type: "local_baserow_create_row",
      event: "click",
      element_id: fileInput.id,
      service: {
        table_id: table.id,
        field_mappings: [
          { field_id: textField.id, value: `builder file ${stamp}` },
          { field_id: fileField.id, value: { formula: `get('form_data.${fileInput.id}')` } },
        ],
      },
    });
    const fileUploadId = crypto.randomUUID();
    const fileForm = new FormData();
    fileForm.append("metadata", JSON.stringify({
      form_data: {
        [String(fileInput.id)]: [{ __file__: true, name: `builder-${stamp}.txt`, file: fileUploadId }],
      },
    }));
    fileForm.append(fileUploadId, new File([`builder file ${stamp}`], "browser-file.txt", { type: "text/plain" }));
    const fileResult = await request("POST", `/api/builder/workflow_action/${fileAction.id}/dispatch/`, fileForm);
    assert(
      fileResult?.[`field_${fileField.id}`]?.[0]?.visible_name === `builder-${stamp}.txt` &&
        fileResult[`field_${fileField.id}`][0].mime_type === "text/plain",
      "builder file input did not persist the multipart file in the file cell"
    );

    const domain = await request("POST", `/api/builder/${builderApp.id}/domains/`, {
      type: "custom",
      domain_name: `builder-smoke-${stamp}.mbza.test`,
    });
    assert(domain.id && domain.published === false, "builder domain was not created unpublished");
    const publish = await request("POST", `/api/builder/domains/${domain.id}/publish/async/`, { domain_id: domain.id });
    assert(publish.state === "finished" && publish.builder_id === builderApp.id, "builder publish job did not finish");

    let publishedByName = await request("GET", `/api/builder/domains/published/by_name/${domain.domain_name}/`, undefined, { auth: false });
    let publishedPage = publishedByName.pages.find((item) => item.path === page.path);
    assert(
      publishedByName.id === publish.published_builder_id && publishedByName.id !== builderApp.id && publishedPage?.id !== page.id,
      "published builder lookup by domain did not return an isolated application copy"
    );
    const publishedPasswordSource = publishedByName.user_sources.find((item) => item.name === userSource.name);
    assert(
      publishedPasswordSource?.auth_providers?.[0]?.password_field_id === passwordField.id,
      "published builder password provider lost its configured marker"
    );
    const publishedSsoSource = publishedByName.user_sources.find((item) => item.name === ssoUserSource.name);
    const publicSamlProvider = publishedSsoSource?.auth_providers?.find((provider) => provider.type === "saml");
    const publicOidcProvider = publishedSsoSource?.auth_providers?.find((provider) => provider.type === "openid_connect");
    assert(
      publicSamlProvider?.domain === "example.com" && !publicSamlProvider.metadata &&
        publicOidcProvider?.name === "Google OpenID" && publicOidcProvider?.base_url === "https://accounts.google.com" &&
        !publicOidcProvider.secret && !publicOidcProvider.client_id && !publicOidcProvider.authorization_url,
      "published builder exposed private SAML/OIDC provider configuration"
    );
    const publishedSsoOriginal = `https://${domain.domain_name}/login`;
    const publishedSamlLogin = await rawRequest(
      "GET",
      `/api/user-source/${encodeURIComponent(publishedSsoSource.uid)}/sso/saml/login/?email=${encodeURIComponent(ssoEmail)}&original=${encodeURIComponent(publishedSsoOriginal)}`,
      undefined,
      { auth: false }
    );
    const publishedSamlLocation = new URL(publishedSamlLogin.headers.get("location"));
    const publishedSamlForm = new FormData();
    publishedSamlForm.set("SAMLResponse", Buffer.from(samlResponseXml).toString("base64"));
    publishedSamlForm.set("RelayState", publishedSamlLocation.searchParams.get("RelayState"));
    const publishedSamlCompleted = await rawRequest(
      "POST",
      "/api/user-source/sso/saml/acs/",
      publishedSamlForm,
      { auth: false }
    );
    const publishedSamlCompletedLocation = new URL(publishedSamlCompleted.headers.get("location"));
    assert(
      publishedSamlCompleted.status === 302 &&
        `${publishedSamlCompletedLocation.origin}${publishedSamlCompletedLocation.pathname}` === publishedSsoOriginal &&
        publishedSamlCompletedLocation.searchParams.get(`user_source_saml_token__${publishedSsoSource.id}`),
      "published builder SAML callback selected the draft user source instead of the published one"
    );
    const firstPublishedBuilderId = publishedByName.id;
    const firstPublishedPageId = publishedPage.id;
    await request("PATCH", `/api/builder/pages/${page.id}/`, { name: "Draft changed after publication" });
    const unchangedPublished = await request("GET", `/api/builder/domains/published/by_name/${domain.domain_name}/`, undefined, { auth: false });
    assert(
      unchangedPublished.pages.find((item) => item.id === firstPublishedPageId)?.name === "Smoke page updated",
      "draft changes leaked into the published builder"
    );
    const republish = await request("POST", `/api/builder/domains/${domain.id}/publish/async/`, { domain_id: domain.id });
    publishedByName = await request("GET", `/api/builder/domains/published/by_name/${domain.domain_name}/`, undefined, { auth: false });
    publishedPage = publishedByName.pages.find((item) => item.path === page.path);
    assert(
      republish.published_builder_id === publishedByName.id && publishedByName.id !== firstPublishedBuilderId &&
        publishedPage?.name === "Draft changed after publication",
      "builder republication did not replace the immutable public copy"
    );
    const removedPublicationPage = await rawRequest(
      "GET",
      `/api/builder/domains/published/page/${firstPublishedPageId}/elements/`,
      undefined,
      { auth: false }
    );
    assert(removedPublicationPage.status === 404, "old builder publication content was not deleted after republication");
    const publishedById = await request("GET", `/api/builder/domains/published/by_id/${builderApp.id}/`);
    assert(publishedById.id === builderApp.id, "published builder lookup by id returned the wrong app");

    const publicCss = await rawRequest("GET", `/api/custom_code/${publishedByName.id}/css/public/`, undefined, { auth: false });
    const publicCssText = await publicCss.text();
    assert(
      publicCss.ok && (publicCss.headers.get("content-type") || "").includes("text/css") && publicCssText === customCss,
      "published builder custom CSS endpoint failed"
    );
    const publicJs = await rawRequest("GET", `/api/custom_code/${publishedByName.id}/js/public/`, undefined, { auth: false });
    const publicJsText = await publicJs.text();
    assert(
      publicJs.ok && (publicJs.headers.get("content-type") || "").includes("application/javascript") && publicJsText === customJs,
      "published builder custom JS endpoint failed"
    );

    const publicElements = await request("GET", `/api/builder/domains/published/page/${publishedPage.id}/elements/`, undefined, { auth: false });
    const publishedElement = publicElements.find((item) => item.type === element.type);
    assert(publishedElement?.id && publishedElement.id !== element.id, "published builder elements endpoint missing copied element");
    const publicDataSources = await request("GET", `/api/builder/domains/published/page/${publishedPage.id}/data_sources/`, undefined, { auth: false });
    const publishedDataSource = publicDataSources.find((item) => item.name === dataSource.name);
    assert(publishedDataSource?.id && publishedDataSource.id !== dataSource.id, "published builder data sources endpoint missing copied data source");
    const publicWorkflowActions = await request("GET", `/api/builder/domains/published/page/${publishedPage.id}/workflow_actions/`, undefined, { auth: false });
    const publishedWorkflowAction = publicWorkflowActions.find((item) =>
      JSON.stringify(item.service || {}).includes(workflowValue)
    );
    assert(publishedWorkflowAction?.id && publishedWorkflowAction.id !== workflowAction.id, "published builder workflow actions endpoint missing copied action");

    const publicWorkflowForm = new FormData();
    publicWorkflowForm.append("metadata", JSON.stringify({ source: "public-smoke" }));
    const publicWorkflowResult = await request(
      "POST",
      `/api/builder/workflow_action/${publishedWorkflowAction.id}/dispatch/`,
      publicWorkflowForm,
      { auth: false }
    );
    assert(
      publicWorkflowResult?.[`field_${textField.id}`] === workflowValue,
      "anonymous published builder workflow action dispatch failed"
    );

    const publicDispatch = await request("POST", `/api/builder/domains/published/data-source/${publishedDataSource.id}/dispatch/?count=1000`, {}, { auth: false });
    assert(publicDispatch.results?.some((item) => item[`field_${textField.id}`] === workflowValue), "published builder data source dispatch did not return the workflow-created row");
    const publicDispatchAll = await request("POST", `/api/builder/domains/published/page/${publishedPage.id}/dispatch-data-sources/?count=1000`, {}, { auth: false });
    assert(publicDispatchAll[String(publishedDataSource.id)]?.results?.some((item) => item.id === row.id), "published builder dispatch-all did not include data source rows");

    const duplicateBuilderJob = await request("POST", `/api/applications/${builderApp.id}/duplicate/async/`, {});
    assert(
      duplicateBuilderJob.state === "finished" && duplicateBuilderJob.duplicated_application?.type === "builder",
      "builder application duplicate did not finish"
    );
    const duplicatedBuilder = duplicateBuilderJob.duplicated_application;
    assert(
      duplicatedBuilder.custom_code?.css === customCss && duplicatedBuilder.custom_code?.js === customJs,
      "builder duplicate did not preserve custom code"
    );
    assert(duplicatedBuilder.scripts?.length === 2, "builder duplicate did not preserve custom scripts");
    const duplicatedSmokePage = duplicatedBuilder.pages.find((item) => item.path === `/builder-smoke-${stamp}`);
    assert(
      duplicatedSmokePage?.id && duplicatedSmokePage.id !== page.id,
      "builder duplicate did not preserve the smoke page"
    );
    const duplicatedPageDataSources = await request("GET", `/api/builder/page/${duplicatedSmokePage.id}/data-sources/`);
    const duplicatedSmokeDataSource = duplicatedPageDataSources.find((item) => item.name === "Smoke rows");
    assert(
      duplicatedSmokeDataSource?.id && duplicatedSmokeDataSource.id !== dataSource.id,
      "builder duplicate did not preserve data sources"
    );
    const duplicatedPageElements = await request("GET", `/api/builder/page/${duplicatedSmokePage.id}/elements/`);
    assert(
      duplicatedPageElements.some((item) => item.value?.formula === "'Builder smoke heading updated'"),
      "builder duplicate did not preserve page elements"
    );
    const duplicatedPageActions = await request("GET", `/api/builder/page/${duplicatedSmokePage.id}/workflow_actions/`);
    assert(
      duplicatedPageActions.some((item) => item.type === "local_baserow_create_row" || item.type === "create_row"),
      "builder duplicate did not preserve workflow actions"
    );
    const duplicatedDomains = await request("GET", `/api/builder/${duplicatedBuilder.id}/domains/`);
    assert(
      !duplicatedDomains.some((item) => item.domain_name === domain.domain_name),
      "builder duplicate must not copy published domains"
    );
  });

  await step("document pages endpoints", async () => {
    const documentApp = await request("POST", `/api/applications/workspace/${workspace.id}/`, {
      name: "E2E document",
      type: "document",
    });
    assert(documentApp.id, "document application id missing");
    const pages = await request("GET", `/api/document/${documentApp.id}/pages/`);
    assert(Array.isArray(pages), "document pages must be an array");
    assert(pages.length >= 1, "document default page missing");
    const page = await request("POST", `/api/document/${documentApp.id}/pages/`, {
      title: "Smoke page",
      content: { blocks: [] },
      parent_id: pages[0].id,
    });
    assert(page.id, "created document page id missing");
    const fetched = await request("GET", `/api/document/pages/${page.id}/`);
    assert(fetched.id === page.id, "document page fetch returned wrong page");
    const patched = await request("PATCH", `/api/document/pages/${page.id}/`, { title: "Smoke page updated" });
    assert(patched.title === "Smoke page updated", "document page update did not persist");
    documentSmoke = { application: documentApp, parentPage: pages[0], page: patched };
  });

  await step("dashboard widgets endpoints", async () => {
    const dashboardApp = await request("POST", `/api/applications/workspace/${workspace.id}/`, {
      name: "E2E dashboard",
      type: "dashboard",
    });
    assert(dashboardApp.id, "dashboard application id missing");
    const widgets = await request("GET", `/api/dashboard/${dashboardApp.id}/widgets/`);
    assert(Array.isArray(widgets), "dashboard widgets must be an array");
    const dataSources = await request("GET", `/api/dashboard/${dashboardApp.id}/data-sources/`);
    assert(Array.isArray(dataSources), "dashboard data sources must be an array");
    const integrations = await request("GET", `/api/application/${dashboardApp.id}/integrations/`);
    assert(
      integrations.length === 1 && integrations[0].type === "local_baserow",
      "dashboard local Baserow integration was not initialized"
    );
    const widget = await request("POST", `/api/dashboard/${dashboardApp.id}/widgets/`, {
      type: "summary",
      title: "Smoke widget",
    });
    assert(widget.id && widget.data_source_id, "dashboard widget or data source id missing");
    const textField = fields.find((item) => item.type === "text");
    const numberField = fields.find((item) => item.type === "number");
    assert(textField?.id && numberField?.id, "dashboard smoke fields missing");
    const summarySource = await request("PATCH", `/api/dashboard/data-sources/${widget.data_source_id}/`, {
      table_id: table.id,
      view_id: view.id,
      field_id: textField.id,
      aggregation_type: "count",
    });
    assert(
      summarySource.type === "local_baserow_aggregate_rows" &&
      summarySource.schema?.properties?.result,
      "dashboard summary data source was not configured"
    );
    const summaryResult = await request("POST", `/api/dashboard/data-sources/${widget.data_source_id}/dispatch/`, {});
    assert(typeof summaryResult.result === "number" && summaryResult.result > 0, "dashboard summary dispatch returned no rows");
    const patched = await request("PATCH", `/api/dashboard/widgets/${widget.id}/`, { title: "Smoke widget updated" });
    assert(patched.title === "Smoke widget updated", "dashboard widget update did not persist");

    const chart = await request("POST", `/api/dashboard/${dashboardApp.id}/widgets/`, {
      type: "chart",
      title: "Smoke chart",
      default_series_chart_type: "BAR",
    });
    assert(chart.id && chart.data_source_id, "dashboard chart or data source id missing");
    const chartSource = await request("PATCH", `/api/dashboard/data-sources/${chart.data_source_id}/`, {
      table_id: table.id,
      view_id: view.id,
      aggregation_series: [{ field_id: numberField.id, aggregation_type: "sum" }],
      aggregation_group_bys: [{ field_id: textField.id }],
      aggregation_sorts: [{
        sort_on: "SERIES",
        reference: `field_${numberField.id}_sum`,
        direction: "DESC",
      }],
    });
    assert(
      chartSource.aggregation_series?.[0]?.id && chartSource.context_data?.fields?.[`field_${textField.id}`],
      "dashboard chart series or context data missing"
    );
    const chartSeriesId = chartSource.aggregation_series[0].id;
    const configuredChart = await request("PATCH", `/api/dashboard/widgets/${chart.id}/`, {
      series_config: [{ series_id: chartSeriesId, series_chart_type: "BAR" }],
    });
    assert(configuredChart.series_config?.[0]?.series_id === chartSeriesId, "dashboard chart series config did not persist");
    const chartResult = await request("POST", `/api/dashboard/data-sources/${chart.data_source_id}/dispatch/`, {});
    assert(Array.isArray(chartResult.result) && chartResult.result.length > 0, "dashboard chart dispatch returned no buckets");
    await request("DELETE", `/api/dashboard/widgets/${widget.id}/`);
    const remainingSources = await request("GET", `/api/dashboard/${dashboardApp.id}/data-sources/`);
    assert(
      remainingSources.length === 1 && remainingSources[0].id === chart.data_source_id,
      "dashboard widget deletion removed the retained chart source or left an orphan summary source"
    );
    dashboardSmoke = {
      application: dashboardApp,
      widget: configuredChart,
      dataSource: chartSource,
      integration: integrations[0],
    };
  });

  await step("notifications endpoints", async () => {
    const notifications = await request("GET", `/api/notifications/${workspace.id}/?offset=0&limit=50`);
    assert(typeof notifications.count === "number", "notifications count missing");
    assert(typeof notifications.unread_count === "number", "notifications unread count missing");
    assert(Array.isArray(notifications.results), "notifications results must be an array");
    const collaboratorNotification = notifications.results.find((item) => (
      item.type === "collaborator_added_to_row" &&
      item.data?.row_id === row.id &&
      item.data?.field_id === collaboratorField.id
    ));
    assert(collaboratorNotification, "collaborator assignment notification missing");
    assert(collaboratorNotification.workspace?.id === workspace.id, "collaborator notification workspace mismatch");
    assert(collaboratorNotification.sender?.id === currentUserId, "collaborator notification sender mismatch");
    await request("POST", `/api/notifications/${workspace.id}/mark-all-as-read/`);
  });

  await step("audit log endpoints", async () => {
    const audit = await request("GET", `/api/audit-log/?workspace_id=${workspace.id}&sorts=%2Btimestamp&size=5`);
    assert(typeof audit.count === "number", "audit log count missing");
    assert(Array.isArray(audit.results), "audit log results must be an array");
    assert(audit.results.length > 0, "audit log should contain smoke workspace events");

    const invalidSort = await request("GET", `/api/audit-log/?workspace_id=${workspace.id}&sorts=timestamp`, undefined, { allowError: true });
    assert(invalidSort.status === 400, "audit log invalid sort direction did not return 400");
    assert(invalidSort.data?.error === "ERROR_INVALID_SORT_DIRECTION", "audit log invalid sort direction code mismatch");

    const users = await request("GET", `/api/audit-log/users/?workspace_id=${workspace.id}&size=1&page=1`);
    assert(typeof users.count === "number", "audit log users count missing");
    assert(Array.isArray(users.results) && users.results.length <= 1, "audit log users pagination invalid");

    const actionTypes = await request("GET", `/api/audit-log/action-types/?workspace_id=${workspace.id}&size=1&page=1`);
    assert(typeof actionTypes.count === "number", "audit log action types count missing");
    assert(Array.isArray(actionTypes.results) && actionTypes.results.length <= 1, "audit log action types pagination invalid");
  });

  await step("workspace export/import", async () => {
    assert(documentSmoke?.application?.id && dashboardSmoke?.application?.id, "document/dashboard export fixtures missing");
    const selectedApplicationIds = [app.id, documentSmoke.application.id, dashboardSmoke.application.id];
    const startedExportJob = await request("POST", `/api/workspaces/${workspace.id}/export/async/`, {
      application_ids: selectedApplicationIds,
    });
    assert(startedExportJob.type === "export_applications", "workspace export job type mismatch");
    const exportJob = await pollJob(startedExportJob, "workspace export", 900);
    assert(exportJob.state === "finished", "workspace export did not finish");
    assert(exportJob.application_count === 3, "workspace export did not include all requested applications");
    const exports = await request("GET", `/api/workspaces/${workspace.id}/export/`);
    assert(Array.isArray(exports.results), "workspace export list invalid");
    assert(exports.results.some((item) => item.id === exportJob.id && item.url), "workspace export list did not include exported file");

    const exportedResponse = await fetch(exportJob.url);
    assert(exportedResponse.ok, "workspace export file was not readable");
    const exportedPayload = new Uint8Array(await exportedResponse.arrayBuffer());
    const workspaceArchive = unzipSync(exportedPayload);
    const workspaceManifest = JSON.parse(strFromU8(workspaceArchive["manifest.json"]));
    assert(workspaceArchive["manifest_signature.json"], "workspace export signature file missing");
    assert(workspaceManifest.version === "1.0.0", "workspace export manifest version mismatch");
    assert(workspaceManifest.configuration?.only_structure === false, "workspace export configuration mismatch");
    const exportedItem = workspaceManifest.applications?.database?.items?.find((item) => item.id === app.id);
    assert(exportedItem?.files?.schema, "workspace export manifest did not include selected database");
    const exportedJson = JSON.parse(strFromU8(workspaceArchive[exportedItem.files.schema]));
    assert(exportedJson.version === 1, "workspace export schema version mismatch");
    assert(exportedJson.applications === undefined, "workspace export schema should contain one application snapshot");
    assert(exportedJson.tables?.length >= 2, "workspace export did not include tables");
    const exportedDataSyncTable = exportedJson.tables.find((item) => item.table?.name === dataSyncSmoke?.table?.name);
    const sourceTextField = fields.find((field) => field.type === "text");
    assert(sourceTextField?.id, "workspace export source text field missing");
    assert(exportedDataSyncTable?.data_sync?.data_sync?.type === "local_baserow_table", "workspace export did not include data sync metadata");
    assert(
      exportedDataSyncTable.data_sync.synced_properties?.some((item) => item.key === `field_${sourceTextField.id}`),
      "workspace export did not include data sync synced property keys"
    );
    const exportedDocumentItem = workspaceManifest.applications?.document?.items?.find(
      (item) => item.id === documentSmoke.application.id
    );
    const exportedDashboardItem = workspaceManifest.applications?.dashboard?.items?.find(
      (item) => item.id === dashboardSmoke.application.id
    );
    assert(exportedDocumentItem?.files?.schema, "workspace export manifest did not include the document");
    assert(exportedDashboardItem?.files?.schema, "workspace export manifest did not include the dashboard");
    const exportedDocument = JSON.parse(strFromU8(workspaceArchive[exportedDocumentItem.files.schema]));
    const exportedDashboard = JSON.parse(strFromU8(workspaceArchive[exportedDashboardItem.files.schema]));
    assert(
      exportedDocument.document?.pages?.some((page) => page.id === documentSmoke.page.id && page.parent_id === documentSmoke.parentPage.id),
      "workspace export did not preserve the document page hierarchy"
    );
    assert(
      exportedDashboard.dashboard?.widgets?.some((widget) => widget.id === dashboardSmoke.widget.id) &&
        exportedDashboard.dashboard?.data_sources?.some((bundle) => bundle.data_source?.id === dashboardSmoke.dataSource.id),
      "workspace export did not preserve dashboard widgets and data sources"
    );

    const form = new FormData();
    form.append("file", new Blob([exportedPayload], { type: "application/zip" }), "workspace-export.zip");
    const upload = await request("POST", `/api/workspaces/${workspace.id}/import/upload-file/`, form);
    const resourceId = upload.id || upload.resource_id;
    assert(resourceId, "workspace import upload resource missing");
    const startedImportJob = await request("POST", `/api/workspaces/${workspace.id}/import/async/`, {
      resource_id: resourceId,
      application_ids: selectedApplicationIds,
    });
    assert(startedImportJob.type === "import_applications", "workspace import job type mismatch");
    const importJob = await pollJob(startedImportJob, "workspace import", 900);
    assert(importJob.installed_applications?.length === 3, "workspace import did not restore requested applications");
    assert(importJob.imported_applications?.length === importJob.installed_applications.length, "workspace import aliases diverged");
    const importedApp = importJob.installed_applications.find((item) => item.type === "database");
    const importedDocument = importJob.installed_applications.find((item) => item.type === "document");
    const importedDashboard = importJob.installed_applications.find((item) => item.type === "dashboard");
    assert(importedApp?.id && importedDocument?.id && importedDashboard?.id, "workspace import application types missing");
    const importedTables = await request("GET", `/api/database/tables/database/${importedApp.id}/`);
    assert(importedTables.some((item) => item.name === "E2E table"), "workspace import did not restore source table");
    const importedDataSyncTable = importedTables.find((item) => item.name === dataSyncSmoke?.table?.name);
    assert(importedDataSyncTable?.data_sync?.id, "workspace import did not restore data sync metadata");
    const importedMainTable = importedTables.find((item) => item.name === "E2E table");
    const importedRows = await request("GET", `/api/database/rows/table/${importedMainTable.id}/`);
    assert(importedRows.results?.length >= 1, "workspace import did not restore rows");
    const importedTextField = importedMainTable.fields.find((item) => item.name === "Text smoke");
    assert(importedTextField?.id, "workspace import source text field missing");
    const importedAIField = importedMainTable.fields.find((item) => item.name === "AI smoke");
    const importedAIFileField = importedMainTable.fields.find((item) => item.name === "File smoke");
    assert(importedAIField.ai_file_field_id === importedAIFileField.id, "workspace import did not remap AI file field");
    assert(
      importedAIField.ai_prompt?.formula === `CONCAT('Summary ', get('fields.field_${importedTextField.id}'))`,
      "workspace import did not remap AI prompt field reference"
    );
    const importedDataSync = await request("GET", `/api/database/data-sync/${importedDataSyncTable.data_sync.id}/`);
    assert(importedDataSync.periodic_interval === "day" && importedDataSync.periodic_interval_count === 2, "workspace import did not restore data sync periodic settings");
    assert(
      importedDataSync.synced_properties?.some((item) => item.key === `field_${importedTextField.id}`),
      "workspace import did not remap data sync synced property keys"
    );
    const importedFileField = importedMainTable.fields.find((item) => item.name === "File smoke");
    const importedFileRow = importedRows.results.find((item) => Array.isArray(item[`field_${importedFileField.id}`]) && item[`field_${importedFileField.id}`].length > 0);
    const importedFile = importedFileRow?.[`field_${importedFileField.id}`]?.[0];
    assert(importedFile?.name && importedFile?.url, "workspace import did not restore file cell references");
    assert(importedFile.visible_name === "Renamed smoke image.png", "workspace import did not preserve file visible name");
    assertSecureFileObject(importedFile, "workspace imported file");
    const importedFileResponse = await fetch(importedFile.url);
    assert(importedFileResponse.ok, "workspace imported file URL was not readable");
    assert((importedFileResponse.headers.get("content-type") || "").startsWith("image/"), "workspace imported file content type mismatch");
    const importedDocumentPages = await request("GET", `/api/document/${importedDocument.id}/pages/`);
    const importedParentPage = importedDocumentPages.find((page) => page.title === documentSmoke.parentPage.title);
    const importedChildPage = importedDocumentPages.find((page) => page.title === "Smoke page updated");
    assert(
      importedParentPage?.id && importedChildPage?.parent_id === importedParentPage.id,
      "workspace import did not remap the document parent page"
    );
    const importedDashboardWidgets = await request("GET", `/api/dashboard/${importedDashboard.id}/widgets/`);
    const importedChart = importedDashboardWidgets.find((widget) => widget.title === "Smoke chart");
    assert(importedChart?.data_source_id, "workspace import did not restore the dashboard chart");
    const importedDashboardSources = await request("GET", `/api/dashboard/${importedDashboard.id}/data-sources/`);
    const importedChartSource = importedDashboardSources.find((source) => source.id === importedChart.data_source_id);
    const importedNumberField = importedMainTable.fields.find((item) => item.name === "Number smoke");
    assert(
      importedChartSource?.table_id === importedMainTable.id &&
        importedChartSource?.view_id &&
        importedChartSource?.aggregation_series?.[0]?.field_id === importedNumberField.id,
      "workspace import did not remap dashboard database references"
    );
    assert(
      importedChart.series_config?.[0]?.series_id === importedChartSource.aggregation_series[0].id,
      "workspace import did not remap dashboard chart series"
    );
    await request("DELETE", `/api/workspaces/${workspace.id}/import/${resourceId}/`);
  });

  await step("trash and restore", async () => {
    const field = fields.find((item) => item.type === "phone_number");
    await request("DELETE", `/api/database/fields/${field.id}/`);
    const structure = await request("GET", "/api/trash/");
    assert(structure.workspaces?.some((item) => item.id === workspace.id), "trash structure missing active workspace");
    const restored = await request("PATCH", "/api/trash/restore/", {
      trash_item_type: "field",
      trash_item_id: field.id,
    });
    assert(restored.restored === true, "trash restore did not restore field");
  });

  await step("trash coverage for rows views tables apps teams workspaces", async () => {
    async function workspaceTrash(workspaceId, type, id) {
      const contents = await request("GET", `/api/trash/workspace/${workspaceId}/`);
      return contents.results.find((item) => item.trash_item_type === type && item.trash_item_id === id);
    }

    const trashDb = await request("POST", `/api/applications/workspace/${workspace.id}/`, { name: "Trash coverage database", type: "database" });
    const trashTable = await request("POST", `/api/database/tables/database/${trashDb.id}/`, { name: "Trash coverage table" });
    const trashFields = await request("GET", `/api/database/fields/table/${trashTable.id}/`);
    const primaryField = trashFields.find((item) => item.primary) || trashFields[0];
    const trashFileField = await request("POST", `/api/database/fields/table/${trashTable.id}/`, { name: "Trash file", type: "file" });

    const trashRow = await request("POST", `/api/database/rows/table/${trashTable.id}/`, {
      [`field_${primaryField.id}`]: "restore row",
    });
    await request("DELETE", `/api/database/rows/table/${trashTable.id}/${trashRow.id}/`);
    assert(await workspaceTrash(workspace.id, "row", trashRow.id), "row was not listed in trash");
    await request("PATCH", "/api/trash/restore/", {
      trash_item_type: "row",
      trash_item_id: trashRow.id,
      parent_trash_item_id: trashTable.id,
    });
    const restoredRow = await request("GET", `/api/database/rows/table/${trashTable.id}/${trashRow.id}/`);
    assert(restoredRow.id === trashRow.id, "row was not restored from trash");

    const fileRow = await request("POST", `/api/database/rows/table/${trashTable.id}/`, {
      [`field_${primaryField.id}`]: "permanent row file",
      [`field_${trashFileField.id}`]: [uploadedSmokeFile],
    });
    await request("DELETE", `/api/database/rows/table/${trashTable.id}/${fileRow.id}/`);
    assert(await workspaceTrash(workspace.id, "row", fileRow.id), "file row was not listed in trash");
    await request("DELETE", `/api/trash/row/${fileRow.id}/?workspace_id=${workspace.id}&parent_trash_item_id=${trashTable.id}`);
    assert(!(await workspaceTrash(workspace.id, "row", fileRow.id)), "file row stayed in trash after permanent delete");
    const deletedFileHead = await fetch(uploadedSmokeFile.url, { method: "HEAD" });
    assert(deletedFileHead.status === 404, "permanently deleted row did not remove unreferenced R2 file");

    const trashView = await request("POST", `/api/database/views/table/${trashTable.id}/`, { name: "Trash view", type: "grid" });
    await request("DELETE", `/api/database/views/${trashView.id}/`);
    assert(await workspaceTrash(workspace.id, "view", trashView.id), "view was not listed in trash");
    await request("PATCH", "/api/trash/restore/", {
      trash_item_type: "view",
      trash_item_id: trashView.id,
    });
    const restoredViews = await request("GET", `/api/database/views/table/${trashTable.id}/`);
    assert(restoredViews.some((item) => item.id === trashView.id), "view was not restored from trash");

    const permanentView = await request("POST", `/api/database/views/table/${trashTable.id}/`, { name: "Trash view permanent", type: "grid" });
    await request("DELETE", `/api/database/views/${permanentView.id}/`);
    await request("DELETE", `/api/trash/view/${permanentView.id}/?workspace_id=${workspace.id}`);
    assert(!(await workspaceTrash(workspace.id, "view", permanentView.id)), "view stayed in trash after permanent delete");

    const restoreTable = await request("POST", `/api/database/tables/database/${trashDb.id}/`, { name: "Trash restore table" });
    await request("DELETE", `/api/database/tables/${restoreTable.id}/`);
    assert(await workspaceTrash(workspace.id, "table", restoreTable.id), "table was not listed in trash");
    await request("PATCH", "/api/trash/restore/", {
      trash_item_type: "table",
      trash_item_id: restoreTable.id,
    });
    const restoredTables = await request("GET", `/api/database/tables/database/${trashDb.id}/`);
    assert(restoredTables.some((item) => item.id === restoreTable.id), "table was not restored from trash");

    const permanentTable = await request("POST", `/api/database/tables/database/${trashDb.id}/`, { name: "Trash permanent table" });
    await request("DELETE", `/api/database/tables/${permanentTable.id}/`);
    assert(await workspaceTrash(workspace.id, "table", permanentTable.id), "table was not listed in trash");
    await request("DELETE", `/api/trash/table/${permanentTable.id}/?workspace_id=${workspace.id}`);
    assert(!(await workspaceTrash(workspace.id, "table", permanentTable.id)), "table stayed in trash after permanent delete");

    const appRestore = await request("POST", `/api/applications/workspace/${workspace.id}/`, { name: "Trash restore app", type: "database" });
    await request("DELETE", `/api/applications/${appRestore.id}/`);
    assert(await workspaceTrash(workspace.id, "application", appRestore.id), "application was not listed in trash");
    await request("PATCH", "/api/trash/restore/", {
      trash_item_type: "application",
      trash_item_id: appRestore.id,
    });
    const restoredApps = await request("GET", `/api/workspaces/${workspace.id}/applications/`);
    assert(restoredApps.some((item) => item.id === appRestore.id), "application was not restored from trash");

    const appPermanent = await request("POST", `/api/applications/workspace/${workspace.id}/`, { name: "Trash permanent app", type: "database" });
    await request("DELETE", `/api/applications/${appPermanent.id}/`);
    await request("DELETE", `/api/trash/application/${appPermanent.id}/?workspace_id=${workspace.id}`);
    assert(!(await workspaceTrash(workspace.id, "application", appPermanent.id)), "application stayed in trash after permanent delete");

    const team = await request("POST", `/api/teams/workspace/${workspace.id}/`, {
      name: `Trash team ${stamp}`,
      default_role_uid: "VIEWER",
    });
    await request("DELETE", `/api/teams/${team.id}/`);
    assert(await workspaceTrash(workspace.id, "team", team.id), "team was not listed in trash");
    await request("PATCH", "/api/trash/restore/", {
      trash_item_type: "team",
      trash_item_id: team.id,
    });
    const teamsAfterRestore = await request("GET", `/api/teams/workspace/${workspace.id}/`);
    assert(teamsAfterRestore.some((item) => item.id === team.id), "team was not restored from trash");
    await request("DELETE", `/api/teams/${team.id}/`);
    await request("DELETE", `/api/trash/team/${team.id}/?workspace_id=${workspace.id}`);
    const teamsAfterDelete = await request("GET", `/api/teams/workspace/${workspace.id}/`);
    assert(!teamsAfterDelete.some((item) => item.id === team.id), "team stayed active after permanent delete");

    const workspaceRestore = await request("POST", "/api/workspaces/", { name: `Trash restore workspace ${stamp}` });
    await request("DELETE", `/api/workspaces/${workspaceRestore.id}/`);
    const hiddenWorkspace = await request("GET", `/api/workspaces/${workspaceRestore.id}/`, undefined, { allowError: true });
    assert(hiddenWorkspace.status === 404, "trashed workspace remained available as active workspace");
    const trashStructure = await request("GET", "/api/trash/");
    assert(trashStructure.workspaces.some((item) => item.id === workspaceRestore.id && item.trashed === true), "trashed workspace missing from trash structure");
    await request("PATCH", "/api/trash/restore/", {
      trash_item_type: "workspace",
      trash_item_id: workspaceRestore.id,
    });
    const restoredWorkspace = await request("GET", `/api/workspaces/${workspaceRestore.id}/`);
    assert(restoredWorkspace.id === workspaceRestore.id, "workspace was not restored from trash");
    await request("DELETE", `/api/workspaces/${workspaceRestore.id}/`);

    const workspacePermanent = await request("POST", "/api/workspaces/", { name: `Trash permanent workspace ${stamp}` });
    await request("DELETE", `/api/workspaces/${workspacePermanent.id}/`);
    assert(await workspaceTrash(workspacePermanent.id, "workspace", workspacePermanent.id), "workspace was not listed in its trash contents");
    await request("DELETE", `/api/trash/workspace/${workspacePermanent.id}/?workspace_id=${workspacePermanent.id}`);
    const deletedWorkspace = await request("GET", `/api/workspaces/${workspacePermanent.id}/`, undefined, { allowError: true });
    assert([403, 404].includes(deletedWorkspace.status), "workspace stayed available after permanent delete");
  });

  await step("undo redo", async () => {
    const undo = await request("PATCH", "/api/user/undo/", { scopes: [] });
    const redo = await request("PATCH", "/api/user/redo/", { scopes: [] });
    assert(Array.isArray(undo.actions) && Array.isArray(redo.actions), "undo/redo invalid");
  });

  await step("cleanup workspace", async () => {
    await cleanupActiveSmokeWorkspaces();
  });

  console.log(`\nApplication smoke test passed: ${results.length} steps`);
}

main().catch(async (error) => {
  console.error(`\nApplication smoke test failed: ${error.message}`);
  if (accessToken) {
    try {
      const cleaned = await cleanupActiveSmokeWorkspaces();
      console.error(`Cleaned failed smoke workspaces: ${cleaned.join(", ") || "none"}`);
    } catch (cleanupError) {
      console.error(`Failed to clean smoke workspaces: ${cleanupError.message}`);
    }
  }
  process.exit(1);
});
