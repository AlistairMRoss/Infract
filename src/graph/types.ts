/** An SST resource (Dynamo table, Bucket, Queue, Function, etc.) */
export interface SSTResource {
  name: string;
  type: SSTResourceType;
  /** For Functions: handler file path */
  handler: string | null;
  /** Names of linked resources */
  links: string[];
  /** Explicit IAM permissions granted */
  permissions: Permission[];
  /** For API routes: the parent API name */
  parentApi: string | null;
  /** Source file and line where this resource is defined */
  definedAt: { file: string; line: number } | null;
}

export type SSTResourceType =
  | "Function"
  | "ApiGatewayV2"
  | "Dynamo"
  | "Bucket"
  | "Queue"
  | "Secret"
  | "Linkable"
  | "ApiRoute"
  | "QueueSubscriber"
  | "Unknown";

/** An explicit IAM permission on a function or API. */
export interface Permission {
  actions: string[];
  resources: string[];
}

/** A detected AWS SDK call in source code. */
export interface SDKCall {
  service: string;
  method: string;
  action: string;
  filePath: string;
  lineNumber: number;
}

/** A Resource.X.name / Resource.X.url reference found in handler code. */
export interface ResourceRef {
  resourceName: string;
  property: string; // "name", "url", "email", etc.
  filePath: string;
  lineNumber: number;
}

/** Combined analysis results for a compute resource (Function, route handler, queue subscriber). */
export interface FunctionAnalysis {
  resource: SSTResource;
  detectedSDKCalls: SDKCall[];
  requiredActions: string[];
  /** Resource names linked to this function (from SST config) */
  linkedResources: string[];
  /** Resource names actually referenced in code via Resource.X */
  referencedResources: ResourceRef[];
  /** Effective permissions from direct + inherited (API-level) */
  effectivePermissions: Permission[];
}

/** A detected permission or linking gap. */
export interface Violation {
  severity: "error" | "warning";
  type: "missing-permission" | "unlinked-resource" | "missing-role" | "unused-link";
  resource: string;
  message: string;
  suggestion: string;
  filePath?: string;
  lineNumber?: number;
}

/** The parsed SST project graph. */
export interface SSTProject {
  /** All resources by name */
  resources: Map<string, SSTResource>;
  /** Root project directory */
  projectRoot: string;
}

/** Human-friendly category for an SST resource type. */
export function resourceCategory(type: SSTResourceType): string {
  switch (type) {
    case "Function": return "Lambda function";
    case "ApiGatewayV2": return "API Gateway";
    case "ApiRoute": return "API route";
    case "Dynamo": return "DynamoDB table";
    case "Bucket": return "S3 bucket";
    case "Queue": return "SQS queue";
    case "QueueSubscriber": return "Queue subscriber";
    case "Secret": return "Secret";
    case "Linkable": return "Linkable";
    default: return type;
  }
}

/** Get all compute resources (functions, route handlers, queue subscribers). */
export function getComputeResources(project: SSTProject): SSTResource[] {
  return [...project.resources.values()].filter(
    (r) => r.type === "Function" || r.type === "ApiRoute" || r.type === "QueueSubscriber",
  );
}

/** Map SST resource type to a service category for matching against SDK calls. */
export function resourceTypeToServiceCategory(type: SSTResourceType): string | null {
  switch (type) {
    case "Dynamo": return "DynamoDB";
    case "Bucket": return "S3";
    case "Queue": return "SQS";
    default: return null;
  }
}
