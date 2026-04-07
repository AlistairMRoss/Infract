import type {
  SSTProject,
  SSTResource,
  FunctionAnalysis,
  Violation,
  Permission,
} from "../graph/types.js";
import { getComputeResources } from "../graph/types.js";
import { scanFunction } from "../codeanalysis/scanner.js";

export interface AnalysisResult {
  functions: FunctionAnalysis[];
  violations: Violation[];
  project: SSTProject;
}

export interface AnalyzerOptions {
  filter?: string;
}

/** Run the full analysis pipeline on an SST project. */
export function analyze(
  project: SSTProject,
  options: AnalyzerOptions = {},
): AnalysisResult {
  const functions: FunctionAnalysis[] = [];

  for (const resource of getComputeResources(project)) {
    if (options.filter && !matchFilter(resource.name, options.filter)) {
      continue;
    }
    functions.push(analyzeFunction(project, resource));
  }

  const violations: Violation[] = [];
  for (const fn of functions) {
    violations.push(...detectViolations(fn, project));
  }

  return { functions, violations, project };
}

function analyzeFunction(
  project: SSTProject,
  resource: SSTResource,
): FunctionAnalysis {
  const scanResult = scanFunction(project.projectRoot, resource);

  const actionSet = new Set<string>();
  for (const call of scanResult.sdkCalls) {
    actionSet.add(call.action);
  }

  return {
    resource,
    detectedSDKCalls: scanResult.sdkCalls,
    requiredActions: [...actionSet],
    linkedResources: resource.links,
    referencedResources: scanResult.resourceRefs,
    effectivePermissions: resource.permissions,
  };
}

function detectViolations(fn: FunctionAnalysis, project: SSTProject): Violation[] {
  const violations: Violation[] = [];

  // 1. Check permission gaps
  if (fn.effectivePermissions.length > 0) {
    for (const call of fn.detectedSDKCalls) {
      if (!hasPermissionForAction(fn.effectivePermissions, call.action)) {
        violations.push({
          severity: "error",
          type: "missing-permission",
          resource: fn.resource.name,
          message: `calls ${call.method} but lacks ${call.action} permission`,
          suggestion: `Add { actions: ["${call.action}"], resources: ["*"] } to this function's permissions`,
          filePath: call.filePath,
          lineNumber: call.lineNumber,
        });
      }
    }
  } else if (fn.detectedSDKCalls.length > 0) {
    const actions = [...new Set(fn.detectedSDKCalls.map((c) => c.action))];
    violations.push({
      severity: "warning",
      type: "missing-permission",
      resource: fn.resource.name,
      message: `makes AWS SDK calls requiring [${actions.join(", ")}] but has no explicit permissions defined`,
      suggestion: "Verify that linked resources auto-grant sufficient permissions, or add explicit permissions",
    });
  }

  // 2. Check for Resource.X references to resources that aren't linked
  const linkedNames = new Set(resolveLinkedNames(fn.linkedResources, project));
  for (const ref of fn.referencedResources) {
    // Skip SST built-in globals (always available, no link needed)
    if (SST_BUILTIN_RESOURCES.has(ref.resourceName)) continue;

    if (!linkedNames.has(ref.resourceName)) {
      violations.push({
        severity: "error",
        type: "unlinked-resource",
        resource: fn.resource.name,
        message: `references Resource.${ref.resourceName}.${ref.property} but "${ref.resourceName}" is not linked to this function`,
        suggestion: `Add the ${ref.resourceName} resource to this function's link array`,
        filePath: ref.filePath,
        lineNumber: ref.lineNumber,
      });
    }
  }

  return violations;
}

/** SST built-in Resource properties that are always available without linking. */
const SST_BUILTIN_RESOURCES = new Set(["App"]);

function hasPermissionForAction(permissions: Permission[], action: string): boolean {
  for (const perm of permissions) {
    for (const granted of perm.actions) {
      if (matchAction(granted, action)) return true;
    }
  }
  return false;
}

function matchAction(pattern: string, action: string): boolean {
  if (pattern === "*" || pattern === action) return true;

  const [patternService, patternAction] = pattern.split(":", 2);
  const [actionService, actionAction] = action.split(":", 2);

  if (!patternAction || !actionAction) return false;
  if (patternService !== actionService) return false;

  if (patternAction === "*") return true;
  if (patternAction.endsWith("*")) {
    return actionAction.startsWith(patternAction.slice(0, -1));
  }
  return patternAction.toLowerCase() === actionAction.toLowerCase();
}

function resolveLinkedNames(links: string[], project: SSTProject): string[] {
  const names: string[] = [];

  for (const link of links) {
    if (link.startsWith("...")) continue;

    if (project.resources.has(link)) {
      names.push(link);
      continue;
    }

    // Case-insensitive match
    for (const [resourceName] of project.resources) {
      if (resourceName.toLowerCase() === link.toLowerCase()) {
        names.push(resourceName);
        break;
      }
    }

    // Add as-is (may be a linkable or external resource)
    names.push(link);
  }

  return names;
}

function matchFilter(name: string, filter: string): boolean {
  if (filter.endsWith("*")) return name.startsWith(filter.slice(0, -1));
  if (filter.startsWith("*")) return name.endsWith(filter.slice(1));
  return name.includes(filter);
}
