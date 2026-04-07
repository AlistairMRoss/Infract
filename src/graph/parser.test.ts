import { describe, test, expect } from "bun:test";
import { parseSSTProject } from "./parser.js";
import { resourceCategory } from "./types.js";

const flussRoot = "/home/alist/Work/FlussDashBoard/FlussV3";

describe("parseSSTProject", () => {
  test("finds resources in FlussV3 project", () => {
    const project = parseSSTProject(flussRoot);
    expect(project.resources.size).toBeGreaterThan(0);
  });

  test("detects API Gateways", () => {
    const project = parseSSTProject(flussRoot);
    const apis = [...project.resources.values()].filter(
      (r) => r.type === "ApiGatewayV2",
    );
    expect(apis.length).toBeGreaterThanOrEqual(2);
  });

  test("detects API routes with handlers", () => {
    const project = parseSSTProject(flussRoot);
    const routes = [...project.resources.values()].filter(
      (r) => r.type === "ApiRoute",
    );
    expect(routes.length).toBeGreaterThan(0);
    for (const route of routes) {
      expect(route.handler).toBeTruthy();
    }
  });

  test("routes inherit links from parent API", () => {
    const project = parseSSTProject(flussRoot);
    const billingRoute = [...project.resources.values()].find(
      (r) => r.type === "ApiRoute" && r.name.startsWith("BillingApi:"),
    );
    expect(billingRoute).toBeDefined();
    expect(billingRoute!.links.length).toBeGreaterThan(0);
  });

  test("detects queue subscribers with permissions", () => {
    const project = parseSSTProject(flussRoot);
    const subscribers = [...project.resources.values()].filter(
      (r) => r.type === "QueueSubscriber",
    );
    expect(subscribers.length).toBeGreaterThanOrEqual(1);

    const sub = subscribers.find((s) => s.name.includes("BillingErrorQueue"));
    expect(sub).toBeDefined();
    expect(sub!.handler).toBeTruthy();
    expect(sub!.permissions[0].actions).toContain("ses:SendEmail");
  });

  test("extracts permissions from API transform config", () => {
    const project = parseSSTProject(flussRoot);
    const billingApi = project.resources.get("BillingApi");
    expect(billingApi).toBeDefined();
    expect(billingApi!.permissions[0].actions).toContain("sts:AssumeRole");
  });
});

describe("resourceCategory", () => {
  test("maps SST types to readable names", () => {
    expect(resourceCategory("Function")).toBe("Lambda function");
    expect(resourceCategory("Dynamo")).toBe("DynamoDB table");
    expect(resourceCategory("Bucket")).toBe("S3 bucket");
    expect(resourceCategory("Queue")).toBe("SQS queue");
  });
});
