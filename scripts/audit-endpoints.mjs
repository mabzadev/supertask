#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";

const root = process.cwd();
const frontendRoot = path.join(root, "frontend", "modules");
const backendRoot = path.join(root, "src");
const reportDir = path.join(root, "reports");
const reportPath = path.join(reportDir, "endpoint-audit.json");

const backendPrefixes = new Map([
  ["src/index.ts:app", ""],
  ["src/routes/index.ts:api", "/api"],
  ["src/routes/user.ts:user", "/api/user"],
  ["src/routes/user-files.ts:userFiles", "/api/user-files"],
  ["src/routes/files.ts:files", "/api/files"],
  ["src/routes/workspaces.ts:workspaces", "/api/workspaces"],
  ["src/routes/applications.ts:applications", "/api/applications"],
  ["src/routes/application-extras.ts:applicationExtras", "/api/application"],
  ["src/routes/application-extras.ts:integrationItems", "/api/integration"],
  ["src/routes/application-extras.ts:userSourceItems", "/api/user-source"],
  ["src/routes/application-extras.ts:userSourceAuth", "/api"],
  ["src/routes/settings.ts:r", "/api/settings"],
  ["src/routes/jobs.ts:jobs", "/api/jobs"],
  ["src/routes/trash.ts:trash", "/api/trash"],
  ["src/routes/notifications.ts:notifications", "/api/notifications"],
  ["src/routes/snapshots.ts:snapshots", "/api/snapshots"],
  ["src/routes/admin.ts:r", "/api/admin"],
  ["src/routes/templates.ts:r", "/api/templates"],
  ["src/routes/search.ts:search", "/api/search"],
  ["src/routes/auth-provider.ts:r", "/api/auth-provider"],
  ["src/routes/two-factor-auth.ts:r", "/api/two-factor-auth"],
  ["src/routes/audit-log.ts:auditLog", "/api/audit-log"],
  ["src/routes/builder.ts:builder", "/api/builder"],
  ["src/routes/custom-code.ts:customCode", "/api/custom_code"],
  ["src/routes/automation.ts:automation", "/api/automation"],
  ["src/routes/licenses.ts:licenses", "/api/licenses"],
  ["src/routes/document.ts:document", "/api/document"],
  ["src/routes/dashboard.ts:dashboard", "/api/dashboard"],
  ["src/routes/whiteboards.ts:whiteboards", "/api/whiteboards"],
  ["src/routes/collaboration.ts:collaboration", "/api/collaboration"],
  ["src/routes/mcp.ts:mcp", "/api/mcp"],
  ["src/routes/mcp.ts:mcpServer", "/mcp"],
  ["src/routes/media.ts:media", "/media"],
  ["src/routes/assistant.ts:assistant", "/assistant"],
  ["src/routes/database/tables.ts:tables", "/api/database/tables"],
  ["src/routes/database/fields.ts:fields", "/api/database/fields"],
  ["src/routes/database/rows.ts:rows", "/api/database/rows"],
  ["src/routes/database/views.ts:views", "/api/database/views"],
  ["src/routes/database/webhooks.ts:webhooks", "/api/database/webhooks"],
  ["src/routes/database/tokens.ts:tokens", "/api/database/tokens"],
  ["src/routes/database/export.ts:r", "/api/database/export"],
  ["src/routes/database/data-sync.ts:r", "/api/database/data-sync"],
  ["src/routes/database/field-rules.ts:r", "/api/database/field-rules"],
  ["src/routes/database/formula.ts:formula", "/api/database/formula"],
]);

const frontendExtensions = new Set([".js", ".ts", ".vue"]);
const backendExtensions = new Set([".ts"]);
const methods = new Set(["get", "post", "patch", "put", "delete"]);

function walk(dir, extensions, ignore = new Set()) {
  if (!fs.existsSync(dir)) return [];
  const files = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (ignore.has(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...walk(full, extensions, ignore));
    } else if (extensions.has(path.extname(entry.name))) {
      files.push(full);
    }
  }
  return files;
}

function relative(file) {
  return path.relative(root, file).replaceAll(path.sep, "/");
}

function joinPaths(prefix, route) {
  const combined = `${prefix}/${route}`.replaceAll(/\/+/g, "/");
  return combined === "/" ? "/" : combined;
}

function canonicalPath(raw, { stripApi = true } = {}) {
  let value = raw.trim();
  value = stripLiteralQuotes(value);
  value = value.replaceAll(/\\`/g, "`");
  value = value.replaceAll(/\$\{[^}]+\}/g, ":param");
  value = value.split("?")[0].split("#")[0];
  if (!value.startsWith("/")) value = `/${value}`;
  value = value.replaceAll(/\/+/g, "/");
  value = value.replaceAll(/:([A-Za-z0-9_]+)\{[^}]+\}/g, ":$1*");
  value = value.replaceAll(/\/$/g, "") || "/";
  if (stripApi && value !== "/api" && value.startsWith("/api/")) {
    value = value.slice(4) || "/";
  }
  return value;
}

function stripLiteralQuotes(value) {
  return value.replace(/^['"`]|['"`]$/g, "");
}

function sourceAt(contents, index) {
  return contents.slice(0, index).split("\n").length;
}

function extractFrontendCalls() {
  const calls = new Map();
  const dynamicCalls = [];
  const files = walk(frontendRoot, frontendExtensions, new Set(["dist", "node_modules", ".nuxt"]));
  const callRegex =
    /(?:[\w$.]+\.)?(?:\$client|client)\s*\.\s*(get|post|patch|put|delete)\s*\(\s*(`(?:\\.|[^`])*`|'(?:\\.|[^'])*'|"(?:\\.|[^"])*")/gs;

  for (const file of files) {
    const rel = relative(file);
    const contents = fs.readFileSync(file, "utf8");
    for (const match of contents.matchAll(callRegex)) {
      const method = match[1].toUpperCase();
      const rawPath = match[2];
      const line = sourceAt(contents, match.index ?? 0);
      if (!rawPath) {
        dynamicCalls.push({ file: rel, line, method });
        continue;
      }
      const endpoint = canonicalPath(rawPath);
      const key = `${method} ${endpoint}`;
      const current = calls.get(key) ?? { method, path: endpoint, sources: [] };
      current.sources.push(`${rel}:${line}`);
      calls.set(key, current);
    }
  }
  return { calls: [...calls.values()].sort(sortEndpoint), dynamicCalls };
}

function extractBackendRoutes() {
  const routes = [];
  const files = walk(backendRoot, backendExtensions, new Set(["node_modules", "dist"]));
  const routeRegex =
    /\b([A-Za-z_$][\w$]*)\s*\.\s*(get|post|patch|put|delete|all)\s*\(\s*(`(?:\\.|[^`])*`|'(?:\\.|[^'])*'|"(?:\\.|[^"])*")/gs;

  for (const file of files) {
    const rel = relative(file);
    const contents = fs.readFileSync(file, "utf8");
    for (const match of contents.matchAll(routeRegex)) {
      const variable = match[1];
      const method = match[2].toUpperCase();
      const rawPath = match[3];
      const prefix = backendPrefixes.get(`${rel}:${variable}`);
      if (prefix == null) continue;
      const endpoint = canonicalPath(joinPaths(prefix, stripLiteralQuotes(rawPath)), { stripApi: true });
      routes.push({
        method,
        path: endpoint,
        source: `${rel}:${sourceAt(contents, match.index ?? 0)}`,
      });
    }
  }
  return routes.sort(sortEndpoint);
}

function routeToRegex(route) {
  const escaped = route
    .replaceAll(/[-/\\^$+?.()|[\]{}]/g, "\\$&")
    .replaceAll(/:([A-Za-z0-9_]+)\*/g, ".+")
    .replaceAll(/:([A-Za-z0-9_]+)/g, "[^/]+");
  return new RegExp(`^${escaped}/?$`);
}

function backendMatches(frontendCall, backendRoute) {
  if (backendRoute.method !== "ALL" && backendRoute.method !== frontendCall.method) return false;
  return routeToRegex(backendRoute.path).test(frontendCall.path);
}

function sortEndpoint(a, b) {
  return a.path.localeCompare(b.path) || a.method.localeCompare(b.method);
}

function scanNotImplemented() {
  const matches = [];
  for (const file of walk(path.join(root, "src"), backendExtensions)) {
    const rel = relative(file);
    const contents = fs.readFileSync(file, "utf8");
    const regex = /API route not implemented|NOT_IMPLEMENTED|not implemented/gi;
    for (const match of contents.matchAll(regex)) {
      matches.push({ source: `${rel}:${sourceAt(contents, match.index ?? 0)}`, text: match[0] });
    }
  }
  return matches;
}

const frontend = extractFrontendCalls();
const backendRoutes = extractBackendRoutes();
const missing = frontend.calls
  .filter((call) => !backendRoutes.some((route) => backendMatches(call, route)))
  .sort(sortEndpoint);
const notImplemented = scanNotImplemented();

const report = {
  generatedAt: new Date().toISOString(),
  frontendCallCount: frontend.calls.length,
  backendRouteCount: backendRoutes.length,
  missingCount: missing.length,
  dynamicFrontendCallCount: frontend.dynamicCalls.length,
  notImplementedCount: notImplemented.length,
  missing,
  dynamicFrontendCalls: frontend.dynamicCalls,
  notImplemented,
  backendRoutes,
};

fs.mkdirSync(reportDir, { recursive: true });
fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);

console.log(`Endpoint audit`);
console.log(`- frontend calls: ${report.frontendCallCount}`);
console.log(`- backend routes: ${report.backendRouteCount}`);
console.log(`- missing endpoints: ${report.missingCount}`);
console.log(`- dynamic frontend calls ignored: ${report.dynamicFrontendCallCount}`);
console.log(`- not implemented markers in src: ${report.notImplementedCount}`);
console.log(`- report: ${path.relative(root, reportPath)}`);

if (missing.length > 0) {
  console.log("\nMissing endpoints:");
  for (const item of missing.slice(0, 80)) {
    console.log(`${item.method.padEnd(6)} ${item.path}  (${item.sources.slice(0, 3).join(", ")})`);
  }
  if (missing.length > 80) {
    console.log(`... ${missing.length - 80} more in ${path.relative(root, reportPath)}`);
  }
}

if (notImplemented.length > 0) {
  console.log("\nNot implemented markers:");
  for (const item of notImplemented.slice(0, 20)) {
    console.log(`${item.source}: ${item.text}`);
  }
}

process.exit(missing.length || notImplemented.length ? 1 : 0);
