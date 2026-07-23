import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const auditModule = await import("../scripts/audit-baserow-parity.mjs");
const runAudit = auditModule.runAudit as (options: { root: string; sourceRoot: string }) => { failures: string[] };
const requiredDomains = auditModule.requiredDomains as string[];
const requiredTests = auditModule.requiredTests as string[];

function writeMinimalAuditRoot(root: string) {
  mkdirSync(join(root, "src"), { recursive: true });
  writeFileSync(join(root, "package.json"), JSON.stringify({
    scripts: Object.fromEntries(requiredTests.map((command) => {
      const script = command.match(/^npm run ([^ ]+)$/)?.[1];
      return [script, "echo ok"];
    }).filter(([script]) => Boolean(script))),
    devDependencies: { playwright: "1.0.0" },
  }));
  writeFileSync(join(root, "parity-status.json"), JSON.stringify({
    policy: { license: "single hardcoded personal enterprise license" },
    domains: Object.fromEntries(requiredDomains.map((domain) => [domain, "partial"])),
    domain_notes: Object.fromEntries(requiredDomains.map((domain) => [
      domain,
      `Domain remains partial until ${domain} has a fixture-backed completion proof and production validation evidence.`,
    ])),
    active_frontend_features: {
      field_types: Array.from({ length: 27 }, (_, index) => `field_${index}`),
      view_types: ["grid", "gallery", "form", "survey", "kanban", "calendar", "timeline"],
    },
    required_tests: requiredTests,
  }));
}

describe("baserow parity audit gate", () => {
  it("blocks fake and stub markers in production source identifiers", () => {
    const root = mkdtempSync(join(tmpdir(), "opentabl-parity-root-"));
    const sourceRoot = mkdtempSync(join(tmpdir(), "opentabl-baserow-source-"));
    try {
      writeMinimalAuditRoot(root);
      writeFileSync(join(root, "src", "index.ts"), "const fakeWorkflowAction = {}; const apiStub = {};\n");

      const result = runAudit({ root, sourceRoot });

      expect(result.failures).toEqual(expect.arrayContaining([
        'src/index.ts: banned marker "fake"',
        'src/index.ts: banned marker "stub"',
      ]));
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(sourceRoot, { recursive: true, force: true });
    }
  });

  it("requires every mandatory test command to be listed and backed by package scripts", () => {
    const root = mkdtempSync(join(tmpdir(), "opentabl-parity-root-"));
    const sourceRoot = mkdtempSync(join(tmpdir(), "opentabl-baserow-source-"));
    try {
      writeMinimalAuditRoot(root);
      const status = JSON.parse(readFileSync(join(root, "parity-status.json"), "utf8"));
      status.required_tests = requiredTests.filter((command) => command !== "npm run test:ui");
      writeFileSync(join(root, "parity-status.json"), JSON.stringify(status));

      const result = runAudit({ root, sourceRoot });

      expect(result.failures).toContain("Missing required test command: npm run test:ui");
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(sourceRoot, { recursive: true, force: true });
    }
  });
});
