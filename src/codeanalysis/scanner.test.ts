import { describe, test, expect } from "bun:test";
import { resolve } from "node:path";
import { scanFunction } from "./scanner.js";
import type { SSTResource } from "../graph/types.js";

const projectRoot = resolve(import.meta.dir, "../..");

function makeResource(handler: string): SSTResource {
  return {
    name: "test",
    type: "Function",
    handler,
    links: [],
    permissions: [],
    parentApi: null,
    definedAt: null,
  };
}

describe("scanFunction", () => {
  test("detects GetObjectCommand and SendEmailCommand in email.ts", () => {
    const result = scanFunction(projectRoot, makeResource("packages/functions/src/email.handler"));
    const actions = new Set(result.sdkCalls.map((c) => c.action));
    expect(actions.has("s3:GetObject")).toBe(true);
    expect(actions.has("ses:SendEmail")).toBe(true);
  });

  test("detects GetCommand from lib-dynamodb in user.ts", () => {
    const result = scanFunction(projectRoot, makeResource("packages/functions/src/user.handler"));
    expect(result.sdkCalls.some((c) => c.action === "dynamodb:GetItem")).toBe(true);
  });

  test("detects PutObjectCommand in upload.ts", () => {
    const result = scanFunction(projectRoot, makeResource("packages/functions/src/upload.handler"));
    expect(result.sdkCalls.some((c) => c.action === "s3:PutObject")).toBe(true);
  });

  test("returns empty for nonexistent handler", () => {
    const result = scanFunction(projectRoot, makeResource("packages/functions/src/nonexistent.handler"));
    expect(result.sdkCalls).toHaveLength(0);
  });

  test("includes correct line numbers", () => {
    const result = scanFunction(projectRoot, makeResource("packages/functions/src/email.handler"));
    const getObject = result.sdkCalls.find((c) => c.action === "s3:GetObject");
    expect(getObject!.lineNumber).toBe(10);
  });

  test("only detects commands actually imported from AWS SDK", () => {
    const result = scanFunction(projectRoot, makeResource("packages/functions/src/user.handler"));
    const queryCall = result.sdkCalls.find((c) => c.action === "dynamodb:Query");
    expect(queryCall).toBeUndefined();
  });
});
