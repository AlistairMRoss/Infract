import type {
  ResourceGraph,
  Resource,
  FunctionAnalysis,
  Violation,
} from "../graph/types.js";
import { getComputeResources } from "../graph/types.js";
import { computeEffectiveActions, hasPermission } from "../iam/policy.js";
import { scanFunction, AWS_SDK_PATTERNS } from "../codeanalysis/index.js";

export interface AnalysisResult {
  functions: FunctionAnalysis[];
  violations: Violation[];
  graph: ResourceGraph;
}

export interface AnalyzerOptions {
  projectRoot: string;
  filter?: string;
}

/** Run the full analysis pipeline. */
export function analyze(
  graph: ResourceGraph,
  options: AnalyzerOptions,
): AnalysisResult {
  // Compute effective IAM actions for all roles
  for (const role of graph.roles.values()) {
    computeEffectiveActions(role);
  }

  // Analyze each compute resource
  const functions: FunctionAnalysis[] = [];
  for (const resource of getComputeResources(graph)) {
    if (options.filter && !matchFilter(resource.name, options.filter)) {
      continue;
    }
    functions.push(analyzeFunction(graph, resource, options.projectRoot));
  }

  // Detect violations
  const violations: Violation[] = [];
  for (const fn of functions) {
    violations.push(...detectViolations(fn));
  }

  return { functions, violations, graph };
}

function analyzeFunction(
  graph: ResourceGraph,
  resource: Resource,
  projectRoot: string,
): FunctionAnalysis {
  const analysis: FunctionAnalysis = {
    resource,
    role: null,
    detectedSDKCalls: [],
    requiredActions: [],
    linkedResources: resource.links,
    usedResources: [],
  };

  // Resolve IAM role
  if (resource.iamRoleURN) {
    analysis.role = graph.roles.get(resource.iamRoleURN) ?? null;
  }

  // Scan source code for SDK calls
  analysis.detectedSDKCalls = scanFunction(projectRoot, resource);

  // Build required actions and used resource types
  const actionSet = new Set<string>();
  const resourceTypeSet = new Set<string>();

  for (const call of analysis.detectedSDKCalls) {
    actionSet.add(call.action);
    const pattern = AWS_SDK_PATTERNS.find((p) => p.service === call.service);
    if (pattern) resourceTypeSet.add(pattern.resourceType);
  }

  analysis.requiredActions = [...actionSet];
  analysis.usedResources = [...resourceTypeSet];

  return analysis;
}

function detectViolations(fn: FunctionAnalysis): Violation[] {
  const violations: Violation[] = [];

  // Check permission gaps
  if (fn.role) {
    for (const call of fn.detectedSDKCalls) {
      if (!hasPermission(fn.role, call.action)) {
        violations.push({
          severity: "error",
          type: "missing-permission",
          resource: fn.resource.name,
          message: `calls ${call.method} but lacks ${call.action} permission`,
          suggestion: `Add ${call.action} to the function's IAM role`,
          filePath: call.filePath,
          lineNumber: call.lineNumber,
        });
      }
    }
  } else if (fn.detectedSDKCalls.length > 0) {
    violations.push({
      severity: "warning",
      type: "missing-role",
      resource: fn.resource.name,
      message: `makes ${fn.detectedSDKCalls.length} AWS SDK call(s) but has no IAM role attached`,
      suggestion:
        "Attach an IAM role with appropriate permissions to this function",
    });
  }

  // Check unlinked resource usage
  const linkedTypes = new Set<string>();
  for (const linkURN of fn.linkedResources) {
    linkedTypes.add(resourceTypeFromURN(linkURN));
  }

  for (const usedType of fn.usedResources) {
    if (!linkedTypes.has(usedType)) {
      violations.push({
        severity: "warning",
        type: "unlinked-resource",
        resource: fn.resource.name,
        message: `uses ${usedType} but no ${usedType} resource is linked`,
        suggestion: `Use .link() in your SST config to bind a ${usedType} resource to this function`,
      });
    }
  }

  return violations;
}

function resourceTypeFromURN(urn: string): string {
  if (urn.includes("dynamodb")) return "DynamoDB";
  if (urn.includes("s3")) return "S3";
  if (urn.includes("ses")) return "SES";
  if (urn.includes("sqs")) return "SQS";
  if (urn.includes("sns")) return "SNS";
  if (urn.includes("events") || urn.includes("eventbridge")) return "EventBridge";
  if (urn.includes("secretsmanager")) return "SecretsManager";
  if (urn.includes("ssm")) return "SSM";
  return "Unknown";
}

function matchFilter(name: string, filter: string): boolean {
  if (filter.endsWith("*")) return name.startsWith(filter.slice(0, -1));
  if (filter.startsWith("*")) return name.endsWith(filter.slice(1));
  return name.includes(filter);
}
