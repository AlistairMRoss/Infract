import chalk from "chalk";
import type { AnalysisResult } from "../analyzer/analyzer.js";
import type { Violation } from "../graph/types.js";
import { resourceCategory } from "../graph/types.js";
import { hasPermission } from "../iam/policy.js";

/** Output analysis results to the console. */
export function reportConsole(result: AnalysisResult, explain: boolean): void {
  if (explain) {
    reportExplain(result);
  } else {
    reportSummary(result);
  }
}

function reportExplain(result: AnalysisResult): void {
  // Resource graph summary
  console.log();
  console.log(chalk.bold("Resource Graph"));
  console.log(`Found ${result.graph.resources.size} resources:`);

  const counts = new Map<string, number>();
  for (const res of result.graph.resources.values()) {
    const cat = resourceCategory(res);
    counts.set(cat, (counts.get(cat) ?? 0) + 1);
  }
  for (const [cat, count] of counts) {
    console.log(`  ${count} ${cat}(s)`);
  }

  // Link analysis
  console.log();
  console.log(chalk.bold("Resource Links"));
  for (const fn of result.functions) {
    if (fn.linkedResources.length > 0) {
      const names = fn.linkedResources.map((urn) => {
        const res = result.graph.resources.get(urn);
        return res ? res.name : urn;
      });
      console.log(`  ${fn.resource.name} -> linked to: [${names.join(", ")}]`);
    } else {
      console.log(
        chalk.yellow(`  ${fn.resource.name} -> linked to: [] (no links)`),
      );
    }
  }

  // IAM permissions
  console.log();
  console.log(chalk.bold("IAM Permissions"));
  for (const fn of result.functions) {
    if (fn.role) {
      console.log(`  ${fn.resource.name} has role: ${fn.role.name}`);
      if (fn.role.attachedPolicies.length > 0) {
        console.log(
          `    Attached policies: ${fn.role.attachedPolicies.join(", ")}`,
        );
      }
      if (fn.role.inlinePolicies.length > 0) {
        console.log(`    Inline policies: ${fn.role.inlinePolicies.length}`);
      }
      console.log(
        `    Effective actions: [${fn.role.effectiveActions.join(", ")}]`,
      );
    } else {
      console.log(
        chalk.yellow(`  ${fn.resource.name} has no IAM role attached`),
      );
    }
  }

  // Code analysis
  console.log();
  console.log(chalk.bold("SDK Usage Detection"));
  for (const fn of result.functions) {
    if (fn.detectedSDKCalls.length === 0) {
      console.log(
        chalk.cyan(`  ${fn.resource.name}: no AWS SDK calls detected`),
      );
      continue;
    }

    const handler = fn.resource.handler ?? "(unknown handler)";
    console.log(`  ${fn.resource.name} (${handler})`);

    for (const call of fn.detectedSDKCalls) {
      const permitted = fn.role ? hasPermission(fn.role, call.action) : false;
      if (permitted) {
        console.log(
          chalk.green(
            `    Line ${call.lineNumber}: ${call.method} -> requires ${call.action} OK`,
          ),
        );
      } else {
        console.log(
          chalk.red(
            `    Line ${call.lineNumber}: ${call.method} -> requires ${call.action} MISSING`,
          ),
        );
      }
    }
  }

  // Violations
  console.log();
  reportViolations(result.violations);
}

function reportSummary(result: AnalysisResult): void {
  console.log();
  console.log(
    `Analyzed ${result.functions.length} function(s), found ${result.violations.length} issue(s)`,
  );
  console.log();
  reportViolations(result.violations);
}

function reportViolations(violations: Violation[]): void {
  if (violations.length === 0) {
    console.log(chalk.green.bold("No issues found!"));
    return;
  }

  const errors = violations.filter((v) => v.severity === "error").length;
  const warnings = violations.length - errors;

  console.log(
    `Found ${violations.length} issue(s): ${errors} error(s), ${warnings} warning(s)`,
  );
  console.log();

  for (const v of violations) {
    if (v.severity === "error") {
      process.stdout.write(chalk.red.bold("ERROR: "));
    } else {
      process.stdout.write(chalk.yellow.bold("WARNING: "));
    }

    console.log(violationTitle(v.type));
    console.log(`  Function: ${v.resource}`);
    console.log(`  ${v.message}`);

    if (v.filePath) {
      console.log(`  Location: ${v.filePath}:${v.lineNumber}`);
    }
    if (v.suggestion) {
      console.log(`  Fix: ${v.suggestion}`);
    }
    console.log();
  }
}

function violationTitle(type: string): string {
  switch (type) {
    case "missing-permission":
      return "Missing IAM Permission";
    case "unlinked-resource":
      return "Unlinked Resource Usage";
    case "missing-role":
      return "Missing IAM Role";
    default:
      return type;
  }
}
