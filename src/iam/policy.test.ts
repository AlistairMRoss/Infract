import { describe, test, expect } from "bun:test";
import { matchAction } from "./policy.js";

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
