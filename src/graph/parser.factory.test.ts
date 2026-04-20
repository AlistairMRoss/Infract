import { describe, test, expect, beforeAll } from "bun:test";
import { resolve } from "node:path";
import { parseSSTProject } from "./parser.js";
import type { SSTProject } from "./types.js";

const fixtureRoot = resolve(import.meta.dir, "../../testdata/factoryProject");

let project: SSTProject;

beforeAll(() => {
  project = parseSSTProject(fixtureRoot);
});

describe("factory detection", () => {
  test("still detects direct sst.aws.Function construction (regression)", () => {
    const direct = project.resources.get("DirectFunction");
    expect(direct).toBeDefined();
    expect(direct!.type).toBe("Function");
    expect(direct!.handler).toBe("apis/direct/src/api.handler");
  });

  test("detects rest-args factory: createLambdaRest(args[0], {...args[1]})", () => {
    const admin = project.resources.get("AdminApi");
    expect(admin).toBeDefined();
    expect(admin!.type).toBe("Function");
    expect(admin!.handler).toBe("apis/admin/src/api.handler");
    expect(admin!.links).toContain("AdminTable");
  });

  test("detects named-param factory: createLambdaNamed(name, config)", () => {
    const user = project.resources.get("UserApi");
    expect(user).toBeDefined();
    expect(user!.type).toBe("Function");
    expect(user!.handler).toBe("apis/user/src/api.handler");
    expect(user!.links).toContain("AdminTable");
  });

  test("merges factory static overrides with call-site config", () => {
    const billing = project.resources.get("BillingApi");
    expect(billing).toBeDefined();
    expect(billing!.handler).toBe("apis/billing/src/api.handler");
    // Call-site link
    expect(billing!.links).toContain("AdminTable");
    // Factory static link
    expect(billing!.links).toContain("SharedSecret");
    // Factory static permission
    expect(
      billing!.permissions.some((p) => p.actions.includes("s3:PutObject")),
    ).toBe(true);
  });

  test("detects function-declaration factories (not just arrow functions)", () => {
    const usage = project.resources.get("UsageTable");
    expect(usage).toBeDefined();
    expect(usage!.type).toBe("Dynamo");
  });

  test("factory-created Functions are picked up as compute resources", () => {
    const computeNames = [...project.resources.values()]
      .filter((r) => r.type === "Function")
      .map((r) => r.name)
      .sort();
    expect(computeNames).toEqual(
      ["AdminApi", "BillingApi", "DirectFunction", "UserApi"].sort(),
    );
  });
});
