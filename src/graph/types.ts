/** A cloud resource from the Pulumi preview output. */
export interface Resource {
  urn: string;
  type: string; // e.g., aws:lambda/function:Function
  name: string;
  op: string; // create, update, delete, same
  properties: Record<string, unknown>;
  links: string[]; // URNs of linked resources (SST link mechanism)
  iamRoleURN: string | null;
  handler: string | null; // For Lambda: handler path
}

/** Parsed IAM role with its policies. */
export interface IAMRole {
  urn: string;
  name: string;
  inlinePolicies: Policy[];
  attachedPolicies: string[]; // ARNs of managed policies
  effectiveActions: string[]; // Computed: all allowed actions
  deniedActions: string[]; // Computed: explicitly denied actions
}

/** A parsed IAM policy document. */
export interface Policy {
  name: string;
  statements: PolicyStatement[];
}

/** A single statement in an IAM policy. */
export interface PolicyStatement {
  effect: "Allow" | "Deny";
  actions: string[];
  resources: string[];
}

/** A detected AWS SDK call in source code. */
export interface SDKCall {
  service: string; // e.g., s3, ses, dynamodb
  method: string; // e.g., GetObjectCommand, sendEmail
  action: string; // IAM action: e.g., s3:GetObject
  filePath: string;
  lineNumber: int;
}

// TypeScript doesn't have `int` — using number
type int = number;

/** Combined analysis results for a compute resource. */
export interface FunctionAnalysis {
  resource: Resource;
  role: IAMRole | null;
  detectedSDKCalls: SDKCall[];
  requiredActions: string[];
  linkedResources: string[];
  usedResources: string[]; // Resource type categories inferred from SDK calls
}

/** A detected permission or linking gap. */
export interface Violation {
  severity: "error" | "warning";
  type: "missing-permission" | "unlinked-resource" | "missing-role";
  resource: string; // Function name
  message: string;
  suggestion: string;
  filePath?: string;
  lineNumber?: number;
}

/** In-memory representation of all resources and their relationships. */
export interface ResourceGraph {
  resources: Map<string, Resource>; // URN -> Resource
  roles: Map<string, IAMRole>; // URN -> IAMRole
}

/** Returns true if the resource is a compute resource. */
export function isCompute(r: Resource): boolean {
  return (
    r.type === "aws:lambda/function:Function" ||
    r.type === "aws:ecs/taskDefinition:TaskDefinition"
  );
}

/** Human-friendly category for a resource type. */
export function resourceCategory(r: Resource): string {
  switch (r.type) {
    case "aws:lambda/function:Function":
      return "Lambda function";
    case "aws:dynamodb/table:Table":
      return "DynamoDB table";
    case "aws:s3/bucket:Bucket":
    case "aws:s3/bucketV2:BucketV2":
      return "S3 bucket";
    case "aws:ses/emailIdentity:EmailIdentity":
    case "aws:sesv2/emailIdentity:EmailIdentity":
      return "SES identity";
    case "aws:sqs/queue:Queue":
      return "SQS queue";
    case "aws:sns/topic:Topic":
      return "SNS topic";
    case "aws:iam/role:Role":
      return "IAM role";
    case "aws:iam/policy:Policy":
    case "aws:iam/rolePolicy:RolePolicy":
      return "IAM policy";
    default:
      return r.type;
  }
}

/** Get all compute resources from the graph. */
export function getComputeResources(graph: ResourceGraph): Resource[] {
  return [...graph.resources.values()].filter(isCompute);
}
