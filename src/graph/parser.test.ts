import { describe, test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parsePreviewJSON } from "./parser.js";
import { resourceCategory } from "./types.js";

const fixture = readFileSync(
  resolve(import.meta.dir, "../../testdata/preview.json"),
  "utf-8",
);

describe("parsePreviewJSON", () => {
  test("parses all resources", () => {
    const graph = parsePreviewJSON(fixture);
    expect(graph.resources.size).toBe(13);
  });

  test("extracts 3 IAM roles", () => {
    const graph = parsePreviewJSON(fixture);
    expect(graph.roles.size).toBe(3);
  });

  test("identifies 3 Lambda functions as compute", () => {
    const graph = parsePreviewJSON(fixture);
    const lambdas = [...graph.resources.values()].filter(
      (r) => r.type === "aws:lambda/function:Function",
    );
    expect(lambdas).toHaveLength(3);
  });

  test("extracts Lambda handler path", () => {
    const graph = parsePreviewJSON(fixture);
    const sendEmail = graph.resources.get(
      "urn:pulumi:dev::my-app::aws:lambda/function:Function::sendEmail",
    );
    expect(sendEmail?.handler).toBe("packages/functions/src/email.handler");
  });

  test("detects SST links via SST_RESOURCE_ env vars", () => {
    const graph = parsePreviewJSON(fixture);

    const sendEmail = graph.resources.get(
      "urn:pulumi:dev::my-app::aws:lambda/function:Function::sendEmail",
    );
    expect(sendEmail?.links).toHaveLength(1);

    const getUser = graph.resources.get(
      "urn:pulumi:dev::my-app::aws:lambda/function:Function::getUser",
    );
    expect(getUser?.links).toHaveLength(1);

    const uploadFile = graph.resources.get(
      "urn:pulumi:dev::my-app::aws:lambda/function:Function::uploadFile",
    );
    expect(uploadFile?.links).toHaveLength(0);
  });

  test("parses inline IAM policies", () => {
    const graph = parsePreviewJSON(fixture);
    const role = graph.roles.get(
      "urn:pulumi:dev::my-app::aws:iam/role:Role::sendEmailFunctionRole",
    );
    expect(role).toBeDefined();
    expect(role!.inlinePolicies).toHaveLength(1);
    expect(role!.attachedPolicies).toHaveLength(1);

    const stmt = role!.inlinePolicies[0].statements[0];
    expect(stmt.effect).toBe("Allow");
    expect(stmt.actions).toContain("ses:SendEmail");
    expect(stmt.actions).toContain("ses:SendRawEmail");
  });
});

describe("resourceCategory", () => {
  test("maps known types", () => {
    expect(resourceCategory({ type: "aws:lambda/function:Function" } as any)).toBe("Lambda function");
    expect(resourceCategory({ type: "aws:dynamodb/table:Table" } as any)).toBe("DynamoDB table");
    expect(resourceCategory({ type: "aws:s3/bucketV2:BucketV2" } as any)).toBe("S3 bucket");
    expect(resourceCategory({ type: "aws:ses/emailIdentity:EmailIdentity" } as any)).toBe("SES identity");
  });

  test("returns raw type for unknown", () => {
    expect(resourceCategory({ type: "aws:unknown/thing:Thing" } as any)).toBe("aws:unknown/thing:Thing");
  });
});
