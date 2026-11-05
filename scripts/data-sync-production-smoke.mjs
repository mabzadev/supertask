#!/usr/bin/env node

const baseUrl = (process.env.SUPERTASK_API_URL || "https://supertask.mbza.workers.dev").replace(/\/$/, "");
const icalUrl = process.env.SUPERTASK_DATA_SYNC_ICAL_URL ||
  "https://calendar.google.com/calendar/ical/en.usa%23holiday%40group.v.calendar.google.com/public/basic.ics";
const githubOwner = process.env.SUPERTASK_DATA_SYNC_GITHUB_OWNER || "cloudflare";
const githubRepo = process.env.SUPERTASK_DATA_SYNC_GITHUB_REPO || "security-audit-skill";
const stamp = Date.now();
const email = `supertask-data-sync-${stamp}@example.com`;
const password = `Supertask-Data-Sync-${stamp}!`;

let accessToken = "";

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function request(method, path, body, allowError = false) {
  const headers = new Headers();
  if (accessToken) headers.set("Authorization", `JWT ${accessToken}`);
  let payload;
  if (body !== undefined) {
    headers.set("content-type", "application/json");
    payload = JSON.stringify(body);
  }
  let response;
  let lastError;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      response = await fetch(`${baseUrl}${path}`, { method, headers, body: payload });
      break;
    } catch (error) {
      lastError = error;
      if (attempt < 3) await new Promise((resolve) => setTimeout(resolve, attempt * 250));
    }
  }
  if (!response) throw new Error(`${method} ${path} -> fetch failed: ${lastError?.message || lastError}`);
  const text = await response.text();
  let data = text;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    // Raw response text is included in the error below.
  }
  if (!response.ok && !allowError) {
    throw new Error(`${method} ${path} -> ${response.status}: ${typeof data === "string" ? data : JSON.stringify(data)}`);
  }
  return allowError ? { status: response.status, data } : data;
}

async function pollJob(job, label) {
  assert(job?.id, `${label} job id missing`);
  let current = job;
  const timeoutSeconds = Number(process.env.SUPERTASK_DATA_SYNC_TIMEOUT_SECONDS || 180);
  for (let attempt = 0; attempt < timeoutSeconds; attempt += 1) {
    if (["finished", "failed", "cancelled"].includes(current.state)) break;
    await new Promise((resolve) => setTimeout(resolve, 1000));
    current = await request("GET", `/api/jobs/${job.id}/`);
  }
  assert(
    current.state === "finished",
    `${label} job did not finish: ${current.state || "unknown"}${current.human_readable_error ? ` (${current.human_readable_error})` : ""}`
  );
  return current;
}

async function cleanup() {
  if (!accessToken) return;
  const workspaces = await request("GET", "/api/workspaces/", undefined, true);
  if (workspaces.status !== 200 || !Array.isArray(workspaces.data)) return;
  for (const workspace of workspaces.data) {
    await request("DELETE", `/api/workspaces/${workspace.id}/`, undefined, true);
    await request("DELETE", `/api/trash/workspace/${workspace.id}/?workspace_id=${workspace.id}`, undefined, true);
  }
}

async function synchronizeAndRead(table, label) {
  const job = await request("POST", `/api/database/data-sync/${table.data_sync.id}/sync/async/`);
  const finished = await pollJob(job, label);
  assert(
    Number(finished.result?.imported_count ?? finished.imported_count ?? 0) > 0,
    `${label} did not import rows`
  );
  const fields = await request("GET", `/api/database/fields/table/${table.id}/`);
  const rows = await request("GET", `/api/database/rows/table/${table.id}/?size=200`);
  assert(Array.isArray(rows.results) && rows.results.length > 0, `${label} table has no rows`);
  return { fields, rows: rows.results, count: Number(rows.count || rows.results.length) };
}

function utcTimeAfter(seconds) {
  const target = new Date(Date.now() + seconds * 1000);
  return [target.getUTCHours(), target.getUTCMinutes(), target.getUTCSeconds()]
    .map((part) => String(part).padStart(2, "0"))
    .join(":");
}

async function verifyPeriodicSync(dataSyncId) {
  const before = await request("GET", `/api/database/data-sync/${dataSyncId}/`);
  const scheduled = await request("PATCH", `/api/database/data-sync/${dataSyncId}/periodic-interval/`, {
    interval: "HOURLY",
    when: utcTimeAfter(20),
  });
  assert(scheduled.interval === "HOURLY", "iCal periodic interval was not enabled");
  const timeoutSeconds = Number(process.env.SUPERTASK_DATA_SYNC_CRON_TIMEOUT_SECONDS || 420);
  for (let attempt = 0; attempt < timeoutSeconds; attempt += 2) {
    await new Promise((resolve) => setTimeout(resolve, 2000));
    const current = await request("GET", `/api/database/data-sync/${dataSyncId}/`);
    if (current.last_periodic_sync && current.last_periodic_sync !== before.last_periodic_sync) {
      assert(current.next_periodic_sync, "iCal periodic sync did not schedule its next run");
      return current;
    }
  }
  throw new Error(`iCal periodic sync was not executed by Cloudflare cron within ${timeoutSeconds} seconds`);
}

async function main() {
  const signup = await request("POST", "/api/user/", {
    name: "Supertask Data Sync production smoke",
    email,
    password,
    authenticate: true,
  });
  accessToken = signup.access_token;
  assert(accessToken, "Signup did not return an access token.");

  const workspace = await request("POST", "/api/workspaces/", {
    name: `Data Sync production smoke ${stamp}`,
  });
  const database = await request("POST", `/api/applications/workspace/${workspace.id}/`, {
    name: "Data Sync live providers",
    type: "database",
  });

  const icalProperties = await request("POST", "/api/database/data-sync/properties/", {
    type: "ical_calendar",
    ical_url: icalUrl,
  });
  assert(
    JSON.stringify(icalProperties.map((property) => property.key)) === JSON.stringify(["uid", "dtstart", "dtend", "summary"]),
    "iCal properties do not match the Baserow contract"
  );
  const icalTable = await request("POST", `/api/database/data-sync/database/${database.id}/`, {
    type: "ical_calendar",
    table_name: "Live iCal",
    ical_url: icalUrl,
    synced_properties: ["uid", "dtstart", "dtend", "summary"],
  });
  const ical = await synchronizeAndRead(icalTable, "iCal sync");
  const icalFields = new Map(ical.fields.map((field) => [field.name, field]));
  assert(icalFields.get("Unique ID")?.type === "text", "iCal unique id field type mismatch");
  assert(icalFields.get("Start date")?.type === "date", "iCal start date field type mismatch");
  assert(icalFields.get("Summary")?.type === "text", "iCal summary field type mismatch");
  assert(
    ical.rows.some((row) => String(row[`field_${icalFields.get("Summary").id}`] || "").length > 0),
    "iCal rows did not preserve event summaries"
  );
  const periodicIcal = await verifyPeriodicSync(icalTable.data_sync.id);

  const githubProperties = await request("POST", "/api/database/data-sync/properties/", {
    type: "github_issues",
    github_issues_owner: githubOwner,
    github_issues_repo: githubRepo,
  });
  const githubPropertyByKey = new Map(githubProperties.map((property) => [property.key, property]));
  assert(githubPropertyByKey.get("id")?.unique_primary === true, "GitHub issue id is not the unique primary property");
  assert(githubPropertyByKey.get("title")?.field_type === "text", "GitHub title property type mismatch");
  assert(githubPropertyByKey.get("url")?.field_type === "url", "GitHub URL property type mismatch");
  const githubTable = await request("POST", `/api/database/data-sync/database/${database.id}/`, {
    type: "github_issues",
    table_name: "Live GitHub issues",
    github_issues_owner: githubOwner,
    github_issues_repo: githubRepo,
    synced_properties: ["id", "title", "state", "url"],
  });
  const github = await synchronizeAndRead(githubTable, "GitHub sync");
  const githubFields = new Map(github.fields.map((field) => [field.name, field]));
  const githubTitle = githubFields.get("Title");
  const githubUrl = githubFields.get("URL to Issue");
  assert(githubTitle?.type === "text", "GitHub destination title field type mismatch");
  assert(githubUrl?.type === "url", "GitHub destination URL field type mismatch");
  assert(
    github.rows.some((row) => String(row[`field_${githubTitle.id}`] || "").length > 0),
    "GitHub rows did not preserve issue titles"
  );
  assert(
    github.rows.every((row) => String(row[`field_${githubUrl.id}`] || "").startsWith(`https://github.com/${githubOwner}/${githubRepo}/issues/`)),
    "GitHub rows did not preserve canonical issue URLs"
  );

  console.log(JSON.stringify({
    status: "passed",
    providers: {
      ical_calendar: { url: icalUrl, rows: ical.count },
      github_issues: { repository: `${githubOwner}/${githubRepo}`, rows: github.count },
    },
    periodic_sync: {
      last_periodic_sync: periodicIcal.last_periodic_sync,
      next_periodic_sync: periodicIcal.next_periodic_sync,
    },
  }, null, 2));
}

main()
  .catch((error) => {
    console.error(`Data Sync production smoke failed: ${error.message}`);
    process.exitCode = 1;
  })
  .finally(cleanup);
