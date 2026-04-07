import type {
  Resource,
  IAMRole,
  Policy,
  PolicyStatement,
  ResourceGraph,
} from "./types.js";

/** Top-level JSON output of `pulumi preview --json`. */
interface PulumiPreview {
  steps: PreviewStep[];
}

interface PreviewStep {
  op: string;
  urn: string;
  type: string;
  name: string;
  resourceInputs?: Record<string, unknown>;
  newState?: ResourceState;
  oldState?: ResourceState;
}

interface ResourceState {
  type: string;
  urn: string;
  inputs?: Record<string, unknown>;
  outputs?: Record<string, unknown>;
}

/** Parse Pulumi preview JSON and build a ResourceGraph. */
export function parsePreviewJSON(data: string): ResourceGraph {
  const preview: PulumiPreview = JSON.parse(data);

  const graph: ResourceGraph = {
    resources: new Map(),
    roles: new Map(),
  };

  // First pass: create all resources
  for (const step of preview.steps) {
    const properties = mergeProperties(step.resourceInputs, step.newState);

    const resource: Resource = {
      urn: step.urn,
      type: step.type,
      name: step.name,
      op: step.op,
      properties,
      links: [],
      iamRoleURN: null,
      handler: null,
    };

    extractResourceDetails(resource);
    graph.resources.set(step.urn, resource);
  }

  // Second pass: resolve relationships
  resolveIAMRoles(graph);
  resolveLinks(graph);

  return graph;
}

function mergeProperties(
  inputs?: Record<string, unknown>,
  state?: ResourceState | null,
): Record<string, unknown> {
  const props: Record<string, unknown> = { ...inputs };

  if (state?.inputs) {
    for (const [k, v] of Object.entries(state.inputs)) {
      if (!(k in props)) props[k] = v;
    }
  }
  if (state?.outputs) {
    for (const [k, v] of Object.entries(state.outputs)) {
      if (!(k in props)) props[k] = v;
    }
  }

  return props;
}

function extractResourceDetails(r: Resource): void {
  if (r.type === "aws:lambda/function:Function") {
    if (typeof r.properties.handler === "string") {
      r.handler = r.properties.handler;
    }
    if (typeof r.properties.role === "string") {
      r.iamRoleURN = r.properties.role;
    }
  }
}

function resolveIAMRoles(graph: ResourceGraph): void {
  // Collect roles
  for (const r of graph.resources.values()) {
    if (r.type === "aws:iam/role:Role") {
      graph.roles.set(r.urn, {
        urn: r.urn,
        name: r.name,
        inlinePolicies: [],
        attachedPolicies: [],
        effectiveActions: [],
        deniedActions: [],
      });
    }
  }

  // Attach policies to roles
  for (const r of graph.resources.values()) {
    if (r.type === "aws:iam/rolePolicy:RolePolicy") {
      const roleURN = findRoleURN(r.properties, graph);
      if (!roleURN) continue;
      const role = graph.roles.get(roleURN);
      if (!role) continue;

      const policy = parseInlinePolicy(r);
      if (policy) role.inlinePolicies.push(policy);
    }

    if (r.type === "aws:iam/rolePolicyAttachment:RolePolicyAttachment") {
      const roleURN = findRoleURN(r.properties, graph);
      if (!roleURN) continue;
      const role = graph.roles.get(roleURN);
      if (!role) continue;

      const policyArn = r.properties.policyArn;
      if (typeof policyArn === "string") {
        role.attachedPolicies.push(policyArn);
      }
    }
  }

  // Resolve Lambda -> Role connections
  for (const r of graph.resources.values()) {
    if (
      r.type === "aws:lambda/function:Function" &&
      r.iamRoleURN
    ) {
      const role = findRoleByRef(r.iamRoleURN, graph);
      if (role) r.iamRoleURN = role.urn;
    }
  }
}

function findRoleURN(
  props: Record<string, unknown>,
  graph: ResourceGraph,
): string | null {
  const roleRef = props.role;
  if (typeof roleRef !== "string") return null;

  if (roleRef.startsWith("urn:pulumi:")) return roleRef;

  // Try to match by name
  for (const role of graph.roles.values()) {
    if (role.name === roleRef) return role.urn;
  }
  return null;
}

function findRoleByRef(ref: string, graph: ResourceGraph): IAMRole | null {
  const direct = graph.roles.get(ref);
  if (direct) return direct;

  for (const role of graph.roles.values()) {
    if (role.name === ref) return role;
  }
  return null;
}

function parseInlinePolicy(r: Resource): Policy | null {
  const policyDoc = r.properties.policy;
  if (typeof policyDoc !== "string") return null;

  try {
    const doc = JSON.parse(policyDoc) as {
      Statement: Array<{
        Effect: string;
        Action: string | string[];
        Resource?: string | string[];
      }>;
    };

    const statements: PolicyStatement[] = doc.Statement.map((stmt) => ({
      effect: stmt.Effect as "Allow" | "Deny",
      actions: toStringArray(stmt.Action),
      resources: stmt.Resource ? toStringArray(stmt.Resource) : [],
    }));

    return { name: r.name, statements };
  } catch {
    return null;
  }
}

function toStringArray(v: string | string[]): string[] {
  return Array.isArray(v) ? v : [v];
}

/** Detect SST link relationships via SST_RESOURCE_* environment variables. */
function resolveLinks(graph: ResourceGraph): void {
  for (const r of graph.resources.values()) {
    if (r.type !== "aws:lambda/function:Function") continue;

    const env = extractEnvironmentVars(r);
    for (const key of Object.keys(env)) {
      if (key.startsWith("SST_RESOURCE_")) {
        const linkedName = key.slice("SST_RESOURCE_".length);
        for (const candidate of graph.resources.values()) {
          if (candidate.name === linkedName) {
            r.links.push(candidate.urn);
            break;
          }
        }
      }
    }
  }
}

function extractEnvironmentVars(r: Resource): Record<string, string> {
  const env = r.properties.environment;
  if (!env || typeof env !== "object") return {};

  const envObj = env as Record<string, unknown>;
  const vars = envObj.variables;
  if (!vars || typeof vars !== "object") return {};

  const result: Record<string, string> = {};
  for (const [k, v] of Object.entries(vars as Record<string, unknown>)) {
    if (typeof v === "string") result[k] = v;
  }
  return result;
}
