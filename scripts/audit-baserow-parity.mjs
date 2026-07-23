import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const defaultSourceRoot = "/Users/appmonster/Workspace/baserow";

const banned = [
  { name: "TODO", regex: /\bTODO\b/ },
  { name: "FIXME", regex: /\bFIXME\b/ },
  { name: "mock", regex: /\bmock(?:ed|s)?\b/i },
  { name: "fake", regex: /fake/i },
  { name: "stub", regex: /stub/i },
  { name: "placeholder", regex: /\bplaceholder\b/i },
  { name: "not implemented", regex: /not implemented/i },
  { name: "supports a subset", regex: /supports a subset/i },
];

export const requiredDomains = [
  "license",
  "endpoint_inventory",
  "fields",
  "rows",
  "formula_lookup_rollup_count",
  "airtable_import",
  "views_grid_gallery_form_survey",
  "views_kanban_calendar_timeline",
  "trash",
  "files_r2_user_files",
  "workspace_import_export_snapshots",
  "enterprise_rbac_teams_field_permissions",
  "auth_providers_sso",
  "data_sync",
  "builder",
  "automation",
  "webhooks_notifications_audit_log_search",
];

export const requiredTests = [
  "npm run type-check",
  "npm run audit:endpoints",
  "npm run audit:baserow-parity",
  "npm run audit:formula-parity",
  "npm run lint",
  "npm run test",
  "npm run test:frontend",
  "npm run db:migrate:local",
  "npm run db:migrate:remote",
  "npm run test:app",
  "npm run test:ui",
];

const allowedDomainStatuses = new Set(["complete", "partial", "missing", "blocked"]);

function walk(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(full));
    else if (/\.(ts|tsx|js|mjs)$/.test(entry.name)) out.push(full);
  }
  return out;
}

export function runAudit(options = {}) {
  const root = options.root || process.cwd();
  const statusPath = path.join(root, "parity-status.json");
  const packagePath = path.join(root, "package.json");
  const srcRoot = path.join(root, "src");
  const sourceRoot = options.sourceRoot || process.env.BASEROW_SOURCE_ROOT || defaultSourceRoot;
  const failures = [];

  let packageJson = null;
  if (!fs.existsSync(packagePath)) {
    failures.push("package.json is missing.");
  } else {
    packageJson = JSON.parse(fs.readFileSync(packagePath, "utf8"));
  }

  if (!fs.existsSync(statusPath)) {
    failures.push("parity-status.json is missing.");
  } else {
    const status = JSON.parse(fs.readFileSync(statusPath, "utf8"));
    for (const domain of requiredDomains) {
      const domainStatus = status.domains?.[domain];
      if (!domainStatus) {
        failures.push(`Missing parity domain: ${domain}`);
        continue;
      }
      if (!allowedDomainStatuses.has(domainStatus)) {
        failures.push(`Invalid parity status for ${domain}: ${domainStatus}`);
      }
      const note = String(status.domain_notes?.[domain] || "");
      if (note.trim().length < 80) {
        failures.push(`Parity domain ${domain} must have a concrete domain_notes entry.`);
      }
      if (domainStatus === "partial" && !/(Domain remains partial until|still need|pending)/i.test(note)) {
        failures.push(`Partial parity domain ${domain} must state what remains before completion.`);
      }
    }
    if (status.policy?.license !== "single hardcoded personal enterprise license") {
      failures.push("License policy must remain hardcoded personal enterprise.");
    }
    if (!Array.isArray(status.active_frontend_features?.field_types) || status.active_frontend_features.field_types.length < 27) {
      failures.push("Field type inventory is incomplete.");
    }
    if (!Array.isArray(status.active_frontend_features?.view_types) || !status.active_frontend_features.view_types.includes("timeline")) {
      failures.push("View type inventory is incomplete.");
    }
    if (!Array.isArray(status.required_tests)) {
      failures.push("required_tests must be listed in parity-status.json.");
    } else {
      for (const command of requiredTests) {
        if (!status.required_tests.includes(command)) {
          failures.push(`Missing required test command: ${command}`);
        }
        const script = command.match(/^npm run ([^ ]+)$/)?.[1];
        if (script && packageJson && !packageJson.scripts?.[script]) {
          failures.push(`Required test command ${command} has no matching package.json script.`);
        }
      }
    }
    if (!packageJson?.devDependencies?.playwright && !packageJson?.dependencies?.playwright) {
      failures.push("Playwright must remain installed for npm run test:ui.");
    }
    if (!String(packageJson?.scripts?.["test:frontend"] || "").includes("test:enterprise")) {
      failures.push("npm run test:frontend must include the enterprise frontend test suite.");
    }
  }

  if (!fs.existsSync(sourceRoot)) {
    failures.push(`Baserow source not found at ${sourceRoot}`);
  }

  let scannedFiles = [];
  if (!fs.existsSync(srcRoot)) {
    failures.push("src directory is missing.");
  } else {
    scannedFiles = walk(srcRoot);
    for (const file of scannedFiles) {
      const rel = path.relative(root, file);
      const text = fs.readFileSync(file, "utf8");
      for (const rule of banned) {
        if (rule.regex.test(text)) {
          failures.push(`${rel}: banned marker "${rule.name}"`);
        }
      }
    }
  }

  return {
    failures,
    sourceRoot,
    domainCount: requiredDomains.length,
    scannedFileCount: scannedFiles.length,
  };
}

function printAuditResult(result) {
  if (result.failures.length > 0) {
    console.error("Baserow parity audit failed:");
    for (const failure of result.failures) console.error(`- ${failure}`);
    process.exit(1);
  }

  console.log("Baserow parity audit passed.");
  console.log(`- source: ${result.sourceRoot}`);
  console.log(`- domains: ${result.domainCount}`);
  console.log(`- src marker scan: ${result.scannedFileCount} files`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  printAuditResult(runAudit());
}
