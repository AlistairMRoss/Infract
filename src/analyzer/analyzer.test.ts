import { describe, test, expect } from "bun:test";
import { parseSSTProject } from "../graph/parser.js";
import { analyze } from "./analyzer.js";

const flussRoot = "/home/alist/Work/FlussDashBoard/FlussV3";

describe("analyze (FlussV3)", () => {
  test("analyzes compute resources", () => {
    const project = parseSSTProject(flussRoot);
    const result = analyze(project);
    expect(result.functions.length).toBeGreaterThan(0);
  });

  test("detects unlinked ExternalBillingAccount", () => {
    const project = parseSSTProject(flussRoot);
    const result = analyze(project);

    const v = result.violations.find(
      (v) => v.type === "unlinked-resource" && v.message.includes("ExternalBillingAccount"),
    );
    expect(v).toBeDefined();
  });

  test("does not flag Resource.App as unlinked", () => {
    const project = parseSSTProject(flussRoot);
    const result = analyze(project);

    const v = result.violations.find(
      (v) => v.type === "unlinked-resource" && v.message.includes("Resource.App"),
    );
    expect(v).toBeUndefined();
  });

  test("correctly identifies linked BillingErrorFromEmail", () => {
    const project = parseSSTProject(flussRoot);
    const result = analyze(project);

    const v = result.violations.find(
      (v) => v.resource.includes("BillingErrorQueue") && v.type === "unlinked-resource" && v.message.includes("BillingErrorFromEmail"),
    );
    expect(v).toBeUndefined();
  });

  test("respects filter option", () => {
    const project = parseSSTProject(flussRoot);
    const result = analyze(project, { filter: "Webhook" });
    expect(result.functions).toHaveLength(1);
    expect(result.functions[0].resource.name).toBe("Webhook");
  });
});
