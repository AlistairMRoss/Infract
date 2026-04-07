import type { AnalysisResult } from "../analyzer/analyzer.js";

/** Output analysis results as JSON. */
export function reportJSON(result: AnalysisResult): void {
  const errors = result.violations.filter(
    (v) => v.severity === "error",
  ).length;

  const output = {
    summary: {
      totalResources: result.graph.resources.size,
      totalFunctions: result.functions.length,
      totalErrors: errors,
      totalWarnings: result.violations.length - errors,
    },
    functions: result.functions.map((fn) => ({
      name: fn.resource.name,
      handler: fn.resource.handler,
      linkedResources: fn.linkedResources,
      requiredActions: fn.requiredActions,
      grantedActions: fn.role?.effectiveActions ?? [],
      sdkCalls: fn.detectedSDKCalls.map((call) => ({
        service: call.service,
        method: call.method,
        action: call.action,
        filePath: call.filePath,
        lineNumber: call.lineNumber,
      })),
    })),
    violations: result.violations.map((v) => ({
      severity: v.severity,
      type: v.type,
      resource: v.resource,
      message: v.message,
      suggestion: v.suggestion,
      ...(v.filePath ? { filePath: v.filePath, lineNumber: v.lineNumber } : {}),
    })),
  };

  console.log(JSON.stringify(output, null, 2));
}
