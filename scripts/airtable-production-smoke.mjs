#!/usr/bin/env node

const baseUrl = (process.env.SUPERTASK_API_URL || "https://supertask.mbza.workers.dev").replace(/\/$/, "");
const airtableUrl = process.env.SUPERTASK_AIRTABLE_URL || "https://airtable.com/appZkaH3aWX3ZjT3b";
const airtableSession = process.env.SUPERTASK_AIRTABLE_SESSION || "";
const airtableSessionSignature = process.env.SUPERTASK_AIRTABLE_SESSION_SIGNATURE || "";
const stamp = Date.now();
const email = process.env.SUPERTASK_AIRTABLE_RESUME_EMAIL || `supertask-airtable-${stamp}@example.com`;
const password = process.env.SUPERTASK_AIRTABLE_RESUME_PASSWORD || `Supertask-Airtable-${stamp}!`;
const resumeJobId = Number(process.env.SUPERTASK_AIRTABLE_RESUME_JOB_ID || 0);

let accessToken = "";
let workspaceId = null;

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function request(method, path, body, allowError = false) {
  return requestWithAuthentication(method, path, body, allowError, true);
}

async function requestWithAuthentication(method, path, body, allowError, retryAuthentication) {
  const headers = new Headers();
  if (accessToken) headers.set("Authorization", `JWT ${accessToken}`);
  let payload;
  if (body !== undefined) {
    headers.set("content-type", "application/json");
    payload = JSON.stringify(body);
  }
  const response = await fetch(`${baseUrl}${path}`, { method, headers, body: payload });
  if (response.status === 401 && retryAuthentication && path !== "/api/user/token-auth/") {
    const login = await requestWithAuthentication("POST", "/api/user/token-auth/", { email, password }, false, false);
    accessToken = login.access_token;
    assert(accessToken, "Token refresh login did not return an access token.");
    return requestWithAuthentication(method, path, body, allowError, false);
  }
  const text = await response.text();
  let data = text;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    // The status and raw response are included in the error below.
  }
  if (!response.ok && !allowError) {
    throw new Error(`${method} ${path} -> ${response.status}: ${typeof data === "string" ? data : JSON.stringify(data)}`);
  }
  return allowError ? { status: response.status, data } : data;
}

async function pollJob(jobId) {
  const maxSeconds = Number(process.env.SUPERTASK_AIRTABLE_TIMEOUT_SECONDS || 900);
  for (let attempt = 0; attempt < maxSeconds; attempt += 1) {
    const job = await request("GET", `/api/jobs/${jobId}/`);
    if (["finished", "failed", "cancelled"].includes(job.state)) return job;
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  throw new Error(`Airtable job ${jobId} did not finish within ${maxSeconds} seconds.`);
}

async function cleanup() {
  if (!accessToken) return;
  const workspaces = await request("GET", "/api/workspaces/", undefined, true);
  if (workspaces.status === 200 && Array.isArray(workspaces.data)) {
    for (const workspace of workspaces.data) {
      await request("DELETE", `/api/workspaces/${workspace.id}/`, undefined, true);
      await request("DELETE", `/api/trash/workspace/${workspace.id}/?workspace_id=${workspace.id}`, undefined, true);
    }
  }
  workspaceId = null;
}

async function main() {
  assert(
    Boolean(airtableSession) === Boolean(airtableSessionSignature),
    "SUPERTASK_AIRTABLE_SESSION and SUPERTASK_AIRTABLE_SESSION_SIGNATURE must be provided together."
  );
  let jobId = resumeJobId;
  if (resumeJobId) {
    const login = await request("POST", "/api/user/token-auth/", { email, password });
    accessToken = login.access_token;
    workspaceId = Number(process.env.SUPERTASK_AIRTABLE_RESUME_WORKSPACE_ID || 0) || null;
  } else {
    const signup = await request("POST", "/api/user/", {
      name: "Supertask Airtable production smoke",
      email,
      password,
      authenticate: true,
    });
    accessToken = signup.access_token;
    assert(accessToken, "Signup did not return an access token.");

    const workspace = await request("POST", "/api/workspaces/", { name: `Airtable production smoke ${stamp}` });
    workspaceId = Number(workspace.id);
    assert(workspaceId > 0, "Workspace creation did not return an id.");

    const createdJob = await request("POST", "/api/jobs/", {
      type: "airtable",
      workspace_id: workspaceId,
      airtable_share_url: airtableUrl,
      skip_files: false,
      ...(airtableSession ? {
        session: airtableSession,
        session_signature: airtableSessionSignature,
      } : {}),
    });
    jobId = Number(createdJob.id);
  }
  const job = await pollJob(jobId);
  assert(job.state === "finished", `Airtable job failed: ${job.human_readable_error || job.error || job.state}`);
  assert(job.database?.id, "Finished Airtable job did not return a database.");
  assert(job.database.airtable_failed_attachment_count === 0, `Airtable import left ${job.database.airtable_failed_attachment_count} failed attachments.`);

  const tables = await request("GET", `/api/database/tables/database/${job.database.id}/`);
  assert(Array.isArray(tables) && tables.length > 1, "Airtable import did not create its source tables.");

  const observedTypes = new Set();
  let selectCellCount = 0;
  const storedFiles = [];
  for (const table of tables.filter((item) => item.name !== "Airtable import report")) {
    const fields = await request("GET", `/api/database/fields/table/${table.id}/`);
    const tableRows = [];
    for (let page = 1; ; page += 1) {
      const rows = await request("GET", `/api/database/rows/table/${table.id}/?size=200&page=${page}`);
      tableRows.push(...(rows.results || []));
      if (tableRows.length >= Number(rows.count || tableRows.length) || (rows.results || []).length === 0) break;
    }
    for (const field of fields) observedTypes.add(field.type);
    for (const row of tableRows) {
      for (const field of fields) {
        const value = row[`field_${field.id}`];
        if (field.type === "single_select" && value) {
          selectCellCount += 1;
          assert(typeof value.value === "string" && value.value.length > 0, `Single select field ${field.id} lost its label.`);
        }
        if (field.type === "multiple_select" && Array.isArray(value)) {
          for (const option of value) {
            selectCellCount += 1;
            assert(typeof option.value === "string" && option.value.length > 0, `Multiple select field ${field.id} lost an option label.`);
          }
        }
        if (field.type === "file" && Array.isArray(value)) {
          for (const file of value) {
            assert(typeof file.url === "string" && file.url.startsWith(`${baseUrl}/api/files/`), `Attachment ${file.visible_name || file.name} was not stored in R2.`);
            assert(!file.url.includes("airtable.com"), `Attachment ${file.visible_name || file.name} still references Airtable.`);
            storedFiles.push(file);
          }
        }
      }
    }
  }

  const requiredTypes = (process.env.SUPERTASK_AIRTABLE_EXPECTED_TYPES || "boolean,date,file,long_text,single_select,text")
    .split(",")
    .map((type) => type.trim())
    .filter(Boolean);
  for (const type of requiredTypes) {
    assert(observedTypes.has(type), `The production Airtable import did not preserve field type ${type}.`);
  }
  assert(selectCellCount > 0, "The production Airtable import did not preserve select cell labels.");
  assert(storedFiles.length > 0, "The production Airtable import did not store any attachment in R2.");

  for (let index = 0; index < storedFiles.length; index += 25) {
    await Promise.all(storedFiles.slice(index, index + 25).map(async (file) => {
      const response = await fetch(file.url, { method: "HEAD" });
      assert(response.ok, `Stored attachment ${file.visible_name || file.name} is not readable (${response.status}).`);
      assert(Number(response.headers.get("content-length") || file.size || 0) > 0, `Stored attachment ${file.visible_name || file.name} is empty.`);
    }));
  }
  for (const file of storedFiles.slice(0, 10)) {
    const response = await fetch(file.url);
    assert(response.ok, `Stored attachment sample ${file.visible_name || file.name} is not readable (${response.status}).`);
    assert((await response.arrayBuffer()).byteLength > 0, `Stored attachment sample ${file.visible_name || file.name} is empty.`);
  }

  console.log(JSON.stringify({
    status: "passed",
    job_id: job.id,
    database_id: job.database.id,
    tables: tables.length,
    field_types: [...observedTypes].sort(),
    select_cells: selectCellCount,
    stored_files: storedFiles.length,
  }, null, 2));
}

main()
  .catch((error) => {
    console.error(`Airtable production smoke failed: ${error.message}`);
    process.exitCode = 1;
  })
  .finally(cleanup);
