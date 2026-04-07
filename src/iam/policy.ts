import type { IAMRole } from "../graph/types.js";

/** Maps well-known AWS managed policy ARNs to their allowed actions. */
const WELL_KNOWN_POLICIES: Record<string, string[]> = {
  "arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole": [
    "logs:CreateLogGroup",
    "logs:CreateLogStream",
    "logs:PutLogEvents",
  ],
  "arn:aws:iam::aws:policy/AmazonDynamoDBReadOnlyAccess": [
    "dynamodb:BatchGetItem",
    "dynamodb:DescribeTable",
    "dynamodb:GetItem",
    "dynamodb:Query",
    "dynamodb:Scan",
  ],
  "arn:aws:iam::aws:policy/AmazonDynamoDBFullAccess": ["dynamodb:*"],
  "arn:aws:iam::aws:policy/AmazonS3ReadOnlyAccess": ["s3:Get*", "s3:List*"],
  "arn:aws:iam::aws:policy/AmazonS3FullAccess": ["s3:*"],
  "arn:aws:iam::aws:policy/AmazonSESFullAccess": ["ses:*"],
  "arn:aws:iam::aws:policy/AmazonSQSFullAccess": ["sqs:*"],
  "arn:aws:iam::aws:policy/AmazonSNSFullAccess": ["sns:*"],
};

/** Compute the effective IAM actions for a role. */
export function computeEffectiveActions(role: IAMRole): string[] {
  const allowed = new Set<string>();
  const denied = new Set<string>();

  // Process inline policies
  for (const policy of role.inlinePolicies) {
    for (const stmt of policy.statements) {
      const target = stmt.effect === "Allow" ? allowed : denied;
      for (const action of stmt.actions) {
        target.add(action);
      }
    }
  }

  // Process attached managed policies
  for (const policyARN of role.attachedPolicies) {
    const normalizedARN = normalizePolicyARN(policyARN);
    const actions = WELL_KNOWN_POLICIES[normalizedARN];
    if (actions) {
      for (const action of actions) {
        allowed.add(action);
      }
    }
  }

  role.effectiveActions = [...allowed];
  role.deniedActions = [...denied];
  return role.effectiveActions;
}

function normalizePolicyARN(arn: string): string {
  for (const knownARN of Object.keys(WELL_KNOWN_POLICIES)) {
    const suffix = extractPolicySuffix(knownARN);
    if (suffix && arn.includes(suffix)) return knownARN;
  }
  return arn;
}

function extractPolicySuffix(arn: string): string | null {
  const idx = arn.indexOf("policy/");
  return idx === -1 ? null : arn.slice(idx);
}

/**
 * Check if a role has a specific IAM action permitted.
 * Deny overrides Allow.
 */
export function hasPermission(role: IAMRole, requiredAction: string): boolean {
  // Check explicit denials first
  for (const denied of role.deniedActions) {
    if (matchAction(denied, requiredAction)) return false;
  }
  for (const action of role.effectiveActions) {
    if (matchAction(action, requiredAction)) return true;
  }
  return false;
}

/**
 * Check if an IAM action pattern matches a specific action.
 * Supports wildcards: "s3:*" matches "s3:GetObject".
 */
export function matchAction(pattern: string, action: string): boolean {
  if (pattern === "*" || pattern === action) return true;

  const [patternService, patternAction] = pattern.split(":", 2);
  const [actionService, actionAction] = action.split(":", 2);

  if (!patternAction || !actionAction) return false;
  if (patternService !== actionService) return false;

  return matchWildcard(patternAction, actionAction);
}

function matchWildcard(pattern: string, s: string): boolean {
  if (pattern === "*") return true;
  if (pattern.endsWith("*")) {
    return s.startsWith(pattern.slice(0, -1));
  }
  return pattern.toLowerCase() === s.toLowerCase();
}
