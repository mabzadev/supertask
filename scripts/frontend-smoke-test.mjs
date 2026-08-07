#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { chromium } from "playwright";

const frontendUrl = (process.env.OPENTABL_FRONTEND_URL || "https://tabl.mbza.dev").replace(/\/$/, "");
const apiUrl = (process.env.OPENTABL_API_URL || "https://opentabl.mbza.workers.dev").replace(/\/$/, "");
const stamp = Date.now();
const email = `opentabl-ui-e2e-${stamp}@example.com`;
const password = `OpenTabl-${stamp}!`;
const reportsDir = path.resolve("reports");
const reportPath = path.join(reportsDir, "frontend-smoke-latest.json");
const screenshotPath = path.join(reportsDir, "frontend-smoke-latest.png");

let accessToken = "";
let browser = null;
let latestPage = null;

const report = {
  ok: false,
  frontendUrl,
  apiUrl,
  email,
  steps: [],
  viewChecks: [],
  dashboardChecks: [],
  consoleErrors: [],
  pageErrors: [],
  failedResponses: [],
  artifacts: {
    report: reportPath,
    screenshot: screenshotPath,
  },
};

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function fatalPageText(text) {
  return /Something went wrong|Request failed|not found under namespace|Cannot read properties|t\.completed|formViewMode undefined/i.test(text);
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

async function step(name, fn) {
  const started = Date.now();
  const value = await fn();
  report.steps.push({ name, ms: Date.now() - started });
  console.log(`ok ${name}`);
  return value;
}

async function apiRequest(method, apiPath, body, options = {}) {
  const headers = new Headers(options.headers || {});
  if (accessToken && options.auth !== false) headers.set("Authorization", `JWT ${accessToken}`);
  let payload = body;
  if (body !== undefined && !(body instanceof FormData)) {
    headers.set("content-type", "application/json");
    payload = JSON.stringify(body);
  }
  const response = await fetch(`${apiUrl}${apiPath}`, { method, headers, body: payload });
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
    if (options.allowError) return { status: response.status, data };
    throw new Error(`${method} ${apiPath} -> ${response.status}: ${typeof data === "string" ? data : JSON.stringify(data)}`);
  }
  return data;
}

async function createApiFixture() {
  const signup = await apiRequest("POST", "/api/user/", {
    name: "OpenTabl UI E2E",
    email,
    password,
    authenticate: true,
  }, { auth: false });
  accessToken = signup.access_token || signup.token;
  assert(accessToken, "signup did not return an access token");

  const workspace = await apiRequest("POST", "/api/workspaces/", {
    name: `UI smoke workspace ${stamp}`,
  });
  const app = await apiRequest("POST", `/api/applications/workspace/${workspace.id}/`, {
    name: `UI smoke database ${stamp}`,
    type: "database",
  });
  const table = await apiRequest("POST", `/api/database/tables/database/${app.id}/`, {
    name: `UI smoke table ${stamp}`,
  });

  const primaryField = (table.fields || []).find((field) => field.primary) || table.fields?.[0];
  const gridView = (table.views || []).find((view) => view.type === "grid") || table.views?.[0];
  assert(primaryField?.id, "created table did not include a primary field");
  assert(gridView?.id, "created table did not include a grid view");

  const statusField = await apiRequest("POST", `/api/database/fields/table/${table.id}/`, {
    name: "UI Status",
    type: "single_select",
    select_options: [
      { value: "Todo", color: "blue" },
      { value: "Done", color: "green" },
    ],
  });
  const dateField = await apiRequest("POST", `/api/database/fields/table/${table.id}/`, {
    name: "UI Date",
    type: "date",
    date_format: "EU",
    date_include_time: false,
  });
  const amountField = await apiRequest("POST", `/api/database/fields/table/${table.id}/`, {
    name: "UI Amount",
    type: "number",
    number_decimal_places: 2,
  });

  const row = await apiRequest("POST", `/api/database/rows/table/${table.id}/`, {
    [`field_${primaryField.id}`]: "UI seeded row",
    [`field_${statusField.id}`]: statusField.select_options[0],
    [`field_${dateField.id}`]: "21/05/2026",
    [`field_${amountField.id}`]: "1234.50",
  });
  assert(row.id, "seed row was not created");

  async function createView(name, type, body = {}) {
    const created = await apiRequest("POST", `/api/database/views/table/${table.id}/`, {
      name,
      type,
      ...body,
    });
    if (type === "kanban" && created.single_select_field !== statusField.id) {
      return apiRequest("PATCH", `/api/database/views/${created.id}/`, { single_select_field: statusField.id });
    }
    if (type === "calendar" && created.date_field !== dateField.id) {
      return apiRequest("PATCH", `/api/database/views/${created.id}/`, { date_field: dateField.id });
    }
    if (type === "timeline" && (created.start_date_field !== dateField.id || created.end_date_field !== dateField.id)) {
      return apiRequest("PATCH", `/api/database/views/${created.id}/`, {
        start_date_field: dateField.id,
        end_date_field: dateField.id,
        timescale: "week",
      });
    }
    return created;
  }

  const views = [
    { label: "grid", view: gridView },
    { label: "gallery", view: await createView("UI gallery", "gallery") },
    { label: "form", view: await createView("UI form", "form") },
    { label: "survey", view: await createView("UI survey", "survey") },
    { label: "kanban", view: await createView("UI kanban", "kanban", { single_select_field: statusField.id }) },
    { label: "calendar", view: await createView("UI calendar", "calendar", { date_field: dateField.id }) },
    { label: "timeline", view: await createView("UI timeline", "timeline", { start_date_field: dateField.id, end_date_field: dateField.id, timescale: "week" }) },
  ];

  const dashboardApp = await apiRequest("POST", `/api/applications/workspace/${workspace.id}/`, {
    name: `UI smoke dashboard ${stamp}`,
    type: "dashboard",
  });
  const summaryWidget = await apiRequest("POST", `/api/dashboard/${dashboardApp.id}/widgets/`, {
    type: "summary",
    title: "UI record count",
  });
  await apiRequest("PATCH", `/api/dashboard/data-sources/${summaryWidget.data_source_id}/`, {
    table_id: table.id,
    view_id: gridView.id,
    field_id: primaryField.id,
    aggregation_type: "count",
  });

  const chartWidget = await apiRequest("POST", `/api/dashboard/${dashboardApp.id}/widgets/`, {
    type: "chart",
    title: "UI amount chart",
    default_series_chart_type: "BAR",
  });
  const chartSource = await apiRequest("PATCH", `/api/dashboard/data-sources/${chartWidget.data_source_id}/`, {
    table_id: table.id,
    view_id: gridView.id,
    aggregation_series: [{ field_id: amountField.id, aggregation_type: "sum" }],
    aggregation_group_bys: [{ field_id: primaryField.id }],
    aggregation_sorts: [{
      sort_on: "SERIES",
      reference: `field_${amountField.id}_sum`,
      direction: "DESC",
    }],
  });
  await apiRequest("PATCH", `/api/dashboard/widgets/${chartWidget.id}/`, {
    series_config: [{
      series_id: chartSource.aggregation_series[0].id,
      series_chart_type: "BAR",
    }],
  });

  return {
    workspace,
    app,
    table,
    primaryField,
    gridView,
    views,
    dashboardApp,
    summaryWidget,
    chartWidget,
  };
}

function attachPageGuards(page, viewportName) {
  page.on("console", (message) => {
    if (message.type() === "error") {
      report.consoleErrors.push({
        viewport: viewportName,
        text: message.text().slice(0, 1000),
      });
    }
  });
  page.on("pageerror", (error) => {
    report.pageErrors.push({
      viewport: viewportName,
      text: String(error?.stack || error).slice(0, 2000),
    });
  });
  page.on("response", (response) => {
    const status = response.status();
    const url = response.url();
    if (status >= 500 || (url.startsWith(`${apiUrl}/api/`) && status >= 400)) {
      report.failedResponses.push({
        viewport: viewportName,
        status,
        url,
      });
    }
  });
}

async function assertHealthyPage(page, label) {
  await page.waitForLoadState("domcontentloaded");
  await page.waitForLoadState("networkidle", { timeout: 10000 }).catch(() => undefined);
  const text = await page.locator("body").innerText({ timeout: 15000 });
  assert(!fatalPageText(text), `${label} rendered a fatal frontend error:\n${text.slice(0, 1200)}`);
  return text;
}

async function login(page) {
  await page.goto(`${frontendUrl}/login`, { waitUntil: "domcontentloaded" });
  await page.getByPlaceholder("Enter your email address..").fill(email);
  await page.getByPlaceholder("Enter your password..").fill(password);
  await page.getByRole("button", { name: /^Login$/ }).click();
  await page.waitForURL(/\/workspace\//, { timeout: 20000 });
  const text = await assertHealthyPage(page, "login");
  assert(!/Enter your email address/i.test(text), "login left the browser on the login form");
}

async function openView(page, fixture, label, view) {
  await page.goto(`${frontendUrl}/database/${fixture.app.id}/table/${fixture.table.id}/${view.id}`, {
    waitUntil: "domcontentloaded",
  });
  const text = await assertHealthyPage(page, `${label} view`);
  assert(text.includes(fixture.table.name) || text.includes("Grid") || text.includes("Form") || text.includes("Survey"), `${label} view did not render recognizable table/view content`);
  report.viewChecks.push({
    label,
    viewId: view.id,
    url: page.url(),
    textSample: text.slice(0, 500),
  });
}

async function openDashboardApplication(page, fixture, viewportName, exerciseEditing) {
  await page.goto(`${frontendUrl}/dashboard/${fixture.dashboardApp.id}`, {
    waitUntil: "domcontentloaded",
  });
  const text = await assertHealthyPage(page, `${viewportName} dashboard application`);
  assert(text.includes(fixture.dashboardApp.name), `${viewportName} dashboard application title is missing`);
  assert(text.includes(fixture.summaryWidget.title), `${viewportName} dashboard summary widget is missing`);
  assert(text.includes(fixture.chartWidget.title), `${viewportName} dashboard chart widget is missing`);
  await page.locator(".dashboard-widget").first().waitFor({ state: "visible", timeout: 15000 });
  assert(await page.locator(".dashboard-widget").count() === 2, `${viewportName} dashboard did not render both widgets`);

  if (exerciseEditing) {
    await page.getByText(/^(Edit mode|Mode édition)$/).click({ timeout: 10000 });
    await page.locator(".dashboard-widget").filter({ hasText: fixture.summaryWidget.title }).click({ timeout: 10000 });
    await page.locator(".dashboard-sidebar").waitFor({ state: "visible", timeout: 10000 });
    await page.getByRole("button", { name: /^(Done editing|Edition terminée)$/ }).click({ timeout: 10000 });
    await page.locator(".dashboard-sidebar").waitFor({ state: "detached", timeout: 10000 });
  }

  report.dashboardChecks.push({
    viewport: viewportName,
    dashboardId: fixture.dashboardApp.id,
    widgetIds: [fixture.summaryWidget.id, fixture.chartWidget.id],
    url: page.url(),
    textSample: text.slice(0, 500),
  });
}

async function runDesktopScenario(context, fixture) {
  const page = await context.newPage();
  latestPage = page;
  attachPageGuards(page, "desktop");
  await step("desktop login", () => login(page));

  await step("desktop dashboard clickable", async () => {
    await page.goto(`${frontendUrl}/workspace/${fixture.workspace.id}`, { waitUntil: "domcontentloaded" });
    const dashboardText = await assertHealthyPage(page, "dashboard");
    assert(dashboardText.includes(fixture.workspace.name), "dashboard did not show the created workspace");
    assert(dashboardText.includes(fixture.app.name), "dashboard did not show the created database");
    await page.locator("a").filter({ hasText: fixture.app.name }).first().click({ timeout: 10000 });
    await page.locator("a").filter({ hasText: fixture.table.name }).first().click({ timeout: 10000 });
    await page.waitForURL(new RegExp(`/database/${fixture.app.id}/table/${fixture.table.id}/`), { timeout: 20000 });
    await assertHealthyPage(page, "clicked table");
  });

  await step("desktop grid add row and edit cell", async () => {
    await page.goto(`${frontendUrl}/database/${fixture.app.id}/table/${fixture.table.id}/${fixture.gridView.id}`, {
      waitUntil: "domcontentloaded",
    });
    await assertHealthyPage(page, "grid");
    await page.locator(".grid-view__add-row").first().click({ timeout: 15000 });
    const value = `UI playwright row ${stamp}`;
    await page.locator(".grid-view__cell.active").first().click({ timeout: 15000 });
    await page.keyboard.type(value);
    await page.keyboard.press("Enter");
    await page.waitForFunction((needle) => document.body.innerText.includes(needle), value, { timeout: 15000 });
    await assertHealthyPage(page, "grid after row edit");
  });

  await step("desktop add column through UI", async () => {
    const fieldName = `UI Browser Text ${stamp}`;
    await page.locator(".grid-view__add-column").first().click({ timeout: 15000 });
    await page.locator(".select__item-link").filter({ hasText: "Single line text" }).first().click({ timeout: 10000 });
    await page.getByPlaceholder("Name").fill(fieldName);
    await page.getByRole("button", { name: /^Create$/ }).click({ timeout: 10000 });
    await page.waitForFunction((needle) => document.body.innerText.includes(needle), fieldName, { timeout: 15000 });
    await assertHealthyPage(page, "grid after field create");

    const fields = await apiRequest("GET", `/api/database/fields/table/${fixture.table.id}/`);
    assert(fields.some((field) => field.name === fieldName && field.type === "text"), "field created in UI was not persisted by the API");
  });

  for (const item of fixture.views) {
    await step(`desktop open ${item.label} view`, () => openView(page, fixture, item.label, item.view));
  }

  await step("desktop dashboard application renders and edits", () =>
    openDashboardApplication(page, fixture, "desktop", true)
  );

  await page.screenshot({ path: screenshotPath, fullPage: true }).catch(() => undefined);
}

async function runMobileScenario(context, fixture) {
  const page = await context.newPage();
  latestPage = page;
  attachPageGuards(page, "mobile");
  await step("mobile login", () => login(page));
  await step("mobile dashboard opens", async () => {
    await page.goto(`${frontendUrl}/workspace/${fixture.workspace.id}`, { waitUntil: "domcontentloaded" });
    const text = await assertHealthyPage(page, "mobile dashboard");
    assert(text.includes(fixture.workspace.name) || text.includes("Home"), "mobile dashboard did not render recognizable workspace content");
  });
  for (const item of fixture.views) {
    await step(`mobile open ${item.label} view`, () => openView(page, fixture, item.label, item.view));
  }
  await step("mobile dashboard application renders", () =>
    openDashboardApplication(page, fixture, "mobile", false)
  );
}

async function cleanupWorkspaces() {
  if (!accessToken) return;
  const workspaces = await apiRequest("GET", "/api/workspaces/", undefined, { allowError: true });
  if (!Array.isArray(workspaces)) return;
  for (const workspace of workspaces) {
    await apiRequest("DELETE", `/api/workspaces/${workspace.id}/`, undefined, { allowError: true });
  }
}

async function writeReport() {
  fs.mkdirSync(reportsDir, { recursive: true });
  fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);
}

async function main() {
  console.log(`Frontend smoke test against ${frontendUrl} using ${apiUrl}`);
  const fixture = await step("api fixture setup", createApiFixture);

  browser = await chromium.launch({
    headless: process.env.HEADED !== "1",
  });

  const desktop = await browser.newContext({
    viewport: { width: 1366, height: 900 },
    ignoreHTTPSErrors: true,
  });
  await runDesktopScenario(desktop, fixture);
  await desktop.close();

  const mobile = await browser.newContext({
    viewport: { width: 390, height: 844 },
    isMobile: true,
    hasTouch: true,
    deviceScaleFactor: 2,
    ignoreHTTPSErrors: true,
  });
  await runMobileScenario(mobile, fixture);
  await mobile.close();

  assert(report.consoleErrors.length === 0, `frontend console errors detected: ${JSON.stringify(report.consoleErrors.slice(0, 5), null, 2)}`);
  assert(report.pageErrors.length === 0, `frontend page errors detected: ${JSON.stringify(report.pageErrors.slice(0, 5), null, 2)}`);
  assert(report.failedResponses.length === 0, `frontend failed responses detected: ${JSON.stringify(report.failedResponses.slice(0, 5), null, 2)}`);

  report.ok = true;
  console.log(`\nFrontend smoke test passed: ${report.steps.length} steps`);
}

main()
  .catch(async (error) => {
    report.error = String(error?.stack || error);
    if (/Executable doesn't exist|browserType.launch/i.test(report.error)) {
      report.installHint = "Run: npx playwright install chromium";
    }
    if (latestPage) {
      await latestPage.screenshot({ path: screenshotPath, fullPage: true }).catch(() => undefined);
    }
    console.error(`\nFrontend smoke test failed: ${error.message}`);
    process.exitCode = 1;
  })
  .finally(async () => {
    await browser?.close().catch(() => undefined);
    await cleanupWorkspaces().catch((error) => {
      report.cleanupError = String(error?.stack || error);
    });
    await writeReport();
  });
