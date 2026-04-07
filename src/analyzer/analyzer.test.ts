import { describe, test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parsePreviewJSON } from "../graph/parser.js";
import { analyze } from "./analyzer.js";

const projectRoot = resolve(import.meta.dir, "../..");
const fixture = readFileSync(
  resolve(projectRoot, "testdata/preview.json"),
  "utf-8",
);

describe("analyze", () => {
  test("analyzes all 3 functions", () => {
    const graph = parsePreviewJSON(fixture);
    const result = analyze(graph, { projectRoot });
    expect(result.functions).toHaveLength(3);
  });

  test("detects missing s3:GetObject permission on sendEmail", () => {
    const graph = parsePreviewJSON(fixture);
    const result = analyze(graph, { projectRoot });

    const s3Violation = result.violations.find(
      (v) =>
        v.resource === "sendEmail" &&
        v.type === "missing-permission" &&
        v.message.includes("s3:GetObject"),
    );
    expect(s3Violation).toBeDefined();
    expect(s3Violation!.severity).toBe("error");
  });

  test("detects unlinked S3 usage on uploadFile", () => {
    const graph = parsePreviewJSON(fixture);
    const result = analyze(graph, { projectRoot });

    const unlinkViolation = result.violations.find(
      (v) => v.resource === "uploadFile" && v.type === "unlinked-resource",
    );
    expect(unlinkViolation).toBeDefined();
    expect(unlinkViolation!.severity).toBe("warning");
  });

  test("does not flag getUser for permission issues (has dynamodb:GetItem)", () => {
    const graph = parsePreviewJSON(fixture);
    const result = analyze(graph, { projectRoot });

    const getUserPermViolation = result.violations.find(
      (v) => v.resource === "getUser" && v.type === "missing-permission",
    );
    expect(getUserPermViolation).toBeUndefined();
  });

  test("respects filter option", () => {
    const graph = parsePreviewJSON(fixture);
    const result = analyze(graph, { projectRoot, filter: "send*" });
    expect(result.functions).toHaveLength(1);
    expect(result.functions[0].resource.name).toBe("sendEmail");
  });

  test("produces violations with file paths and line numbers", () => {
    const graph = parsePreviewJSON(fixture);
    const result = analyze(graph, { projectRoot });

    const permViolation = result.violations.find(
      (v) => v.type === "missing-permission",
    );
    expect(permViolation?.filePath).toContain("email.ts");
    expect(permViolation?.lineNumber).toBeGreaterThan(0);
  });
});
