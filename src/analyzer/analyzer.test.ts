import { describe, test, expect, beforeAll } from "bun:test";
import { parseSSTProject } from "../graph/parser.js";
import { analyze, type AnalysisResult } from "./analyzer.js";
import type { SSTProject } from "../graph/types.js";

const flussRoot = "/home/alist/Work/FlussDashBoard/FlussV3";

let project: SSTProject;
let result: AnalysisResult;

beforeAll(() => {
  project = parseSSTProject(flussRoot);
  result = analyze(project);
}, 30000);

describe("analyze (FlussV3)", () => {
  test("analyzes compute resources", () => {
    expect(result.functions.length).toBeGreaterThan(0);
  });

  test("correctly resolves ExternalBillingAccount as linked on BillingApi routes", () => {
    const v = result.violations.find(
      (v) =>
        v.resource.startsWith("BillingApi:") &&
        v.type === "unlinked-resource" &&
        v.message.includes("ExternalBillingAccount"),
    );
    expect(v).toBeUndefined();
  });

  test("does not flag Resource.App as unlinked", () => {
    const v = result.violations.find(
      (v) => v.type === "unlinked-resource" && v.message.includes("Resource.App"),
    );
    expect(v).toBeUndefined();
  });

  test("correctly identifies linked BillingErrorFromEmail", () => {
    const v = result.violations.find(
      (v) => v.resource.includes("BillingErrorQueue") && v.type === "unlinked-resource" && v.message.includes("BillingErrorFromEmail"),
    );
    expect(v).toBeUndefined();
  });

  test("respects filter option", () => {
    const filtered = analyze(project, { filter: "Webhook" });
    expect(filtered.functions).toHaveLength(1);
    expect(filtered.functions[0].resource.name).toBe("Webhook");
  });
});
