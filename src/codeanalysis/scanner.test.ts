import { describe, test, expect } from "bun:test";
import { resolve } from "node:path";
import { scanFunction } from "./scanner.js";
import type { Resource } from "../graph/types.js";

const projectRoot = resolve(import.meta.dir, "../..");

function makeResource(handler: string): Resource {
  return {
    urn: "",
    type: "aws:lambda/function:Function",
    name: "test",
    op: "create",
    properties: {},
    links: [],
    iamRoleURN: null,
    handler,
  };
}

describe("scanFunction", () => {
  test("detects GetObjectCommand and SendEmailCommand in email.ts", () => {
    const calls = scanFunction(projectRoot, makeResource("packages/functions/src/email.handler"));

    const actions = new Set(calls.map((c) => c.action));
    expect(actions.has("s3:GetObject")).toBe(true);
    expect(actions.has("ses:SendEmail")).toBe(true);
  });

  test("detects GetCommand from lib-dynamodb in user.ts", () => {
    const calls = scanFunction(projectRoot, makeResource("packages/functions/src/user.handler"));

    expect(calls.length).toBeGreaterThan(0);
    expect(calls.some((c) => c.action === "dynamodb:GetItem")).toBe(true);
  });

  test("detects PutObjectCommand in upload.ts", () => {
    const calls = scanFunction(projectRoot, makeResource("packages/functions/src/upload.handler"));

    expect(calls.some((c) => c.action === "s3:PutObject")).toBe(true);
  });

  test("returns empty for nonexistent handler", () => {
    const calls = scanFunction(projectRoot, makeResource("packages/functions/src/nonexistent.handler"));
    expect(calls).toHaveLength(0);
  });

  test("returns empty for null handler", () => {
    const r = makeResource("packages/functions/src/email.handler");
    r.handler = null;
    const calls = scanFunction(projectRoot, r);
    expect(calls).toHaveLength(0);
  });

  test("includes correct line numbers", () => {
    const calls = scanFunction(projectRoot, makeResource("packages/functions/src/email.handler"));

    const getObject = calls.find((c) => c.action === "s3:GetObject");
    expect(getObject).toBeDefined();
    expect(getObject!.lineNumber).toBe(10);

    const sendEmail = calls.find((c) => c.action === "ses:SendEmail");
    expect(sendEmail).toBeDefined();
    expect(sendEmail!.lineNumber).toBe(18);
  });

  test("only detects commands that are actually imported from AWS SDK", () => {
    // QueryCommand is imported in user.ts but never instantiated with `new`
    const calls = scanFunction(projectRoot, makeResource("packages/functions/src/user.handler"));
    const queryCall = calls.find((c) => c.action === "dynamodb:Query");
    expect(queryCall).toBeUndefined();
  });
});
