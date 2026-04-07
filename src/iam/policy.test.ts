import { describe, test, expect } from "bun:test";
import type { IAMRole } from "../graph/types.js";
import { computeEffectiveActions, hasPermission, matchAction } from "./policy.js";

describe("computeEffectiveActions", () => {
  test("combines inline + managed policy actions", () => {
    const role: IAMRole = {
      urn: "test",
      name: "testRole",
      inlinePolicies: [
        {
          name: "sesPolicy",
          statements: [
            { effect: "Allow", actions: ["ses:SendEmail", "ses:SendRawEmail"], resources: [] },
          ],
        },
      ],
      attachedPolicies: [
        "arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole",
      ],
      effectiveActions: [],
      deniedActions: [],
    };

    computeEffectiveActions(role);

    expect(hasPermission(role, "ses:SendEmail")).toBe(true);
    expect(hasPermission(role, "logs:CreateLogGroup")).toBe(true);
    expect(hasPermission(role, "s3:GetObject")).toBe(false);
  });

  test("deny overrides allow", () => {
    const role: IAMRole = {
      urn: "test",
      name: "testRole",
      inlinePolicies: [
        {
          name: "policy",
          statements: [
            { effect: "Allow", actions: ["s3:*"], resources: [] },
            { effect: "Deny", actions: ["s3:DeleteObject"], resources: [] },
          ],
        },
      ],
      attachedPolicies: [],
      effectiveActions: [],
      deniedActions: [],
    };

    computeEffectiveActions(role);

    expect(hasPermission(role, "s3:GetObject")).toBe(true);
    expect(hasPermission(role, "s3:PutObject")).toBe(true);
    expect(hasPermission(role, "s3:DeleteObject")).toBe(false);
  });
});

describe("matchAction", () => {
  test("exact match", () => {
    expect(matchAction("s3:GetObject", "s3:GetObject")).toBe(true);
    expect(matchAction("s3:GetObject", "s3:PutObject")).toBe(false);
  });

  test("wildcard match", () => {
    expect(matchAction("s3:*", "s3:GetObject")).toBe(true);
    expect(matchAction("s3:Get*", "s3:GetObject")).toBe(true);
    expect(matchAction("s3:Get*", "s3:PutObject")).toBe(false);
    expect(matchAction("*", "anything:here")).toBe(true);
  });

  test("service must match", () => {
    expect(matchAction("dynamodb:*", "s3:GetObject")).toBe(false);
  });
});

describe("hasPermission with wildcards", () => {
  test("s3:* grants all s3 actions", () => {
    const role: IAMRole = {
      urn: "test",
      name: "test",
      inlinePolicies: [],
      attachedPolicies: [],
      effectiveActions: ["s3:*"],
      deniedActions: [],
    };

    expect(hasPermission(role, "s3:GetObject")).toBe(true);
    expect(hasPermission(role, "s3:PutObject")).toBe(true);
    expect(hasPermission(role, "dynamodb:GetItem")).toBe(false);
  });
});
