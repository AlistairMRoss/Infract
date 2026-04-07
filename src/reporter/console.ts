import chalk from "chalk";
import type { AnalysisResult } from "../analyzer/analyzer.js";
import type { Violation } from "../graph/types.js";
import { resourceCategory } from "../graph/types.js";

/** Output analysis results to the console. */
export function reportConsole(result: AnalysisResult, explain: boolean): void {
  if (explain) {
    reportExplain(result);
  } else {
    reportSummary(result);
  }
}

function reportExplain(result: AnalysisResult): void {
  // Resource summary
  console.log();
  console.log(chalk.bold("SST Project Resources"));
  console.log(`Found ${result.project.resources.size} resources:`);

  const counts = new Map<string, number>();
  for (const res of result.project.resources.values()) {
    const cat = resourceCategory(res.type);
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
      const linkDisplay = fn.linkedResources
        .map((l) => l.startsWith("...") ? chalk.dim(l) : l)
        .join(", ");
      console.log(`  ${fn.resource.name} -> [${linkDisplay}]`);
    } else {
      console.log(chalk.yellow(`  ${fn.resource.name} -> [] (no links)`));
    }
  }

  // Permissions
  console.log();
  console.log(chalk.bold("Permissions"));
  for (const fn of result.functions) {
    if (fn.effectivePermissions.length > 0) {
      const actions = fn.effectivePermissions.flatMap((p) => p.actions);
      console.log(`  ${fn.resource.name}: [${actions.join(", ")}]`);
    } else {
      console.log(chalk.dim(`  ${fn.resource.name}: (none defined — relying on link auto-grants)`));
    }
  }

  // Code analysis
  console.log();
  console.log(chalk.bold("SDK Usage Detection"));
  for (const fn of result.functions) {
    const handler = fn.resource.handler ?? "(unknown handler)";

    if (fn.detectedSDKCalls.length === 0 && fn.referencedResources.length === 0) {
      console.log(chalk.dim(`  ${fn.resource.name}: no AWS SDK calls or Resource refs detected`));
      continue;
    }

    console.log(`  ${fn.resource.name} (${handler})`);

    for (const call of fn.detectedSDKCalls) {
      const hasPerm =
        fn.effectivePermissions.length === 0 ||
        fn.effectivePermissions.some((p) =>
          p.actions.some((a) => matchActionSimple(a, call.action)),
        );
      if (hasPerm) {
        console.log(chalk.green(`    Line ${call.lineNumber}: ${call.method} -> ${call.action} OK`));
      } else {
        console.log(chalk.red(`    Line ${call.lineNumber}: ${call.method} -> ${call.action} MISSING`));
      }
    }

    for (const ref of fn.referencedResources) {
      // Skip SST built-in globals (always available)
      if (SST_BUILTINS.has(ref.resourceName)) continue;

      const isLinked = fn.linkedResources.some(
        (l) => l === ref.resourceName || l.toLowerCase() === ref.resourceName.toLowerCase(),
      );
      if (isLinked) {
        console.log(chalk.green(`    Line ${ref.lineNumber}: Resource.${ref.resourceName}.${ref.property} LINKED`));
      } else {
        console.log(chalk.red(`    Line ${ref.lineNumber}: Resource.${ref.resourceName}.${ref.property} NOT LINKED`));
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
    case "missing-permission": return "Missing IAM Permission";
    case "unlinked-resource": return "Unlinked Resource Usage";
    case "missing-role": return "Missing IAM Role";
    case "unused-link": return "Unused Link";
    default: return type;
  }
}

/** SST built-in Resource properties always available without linking. */
const SST_BUILTINS = new Set(["App"]);

function matchActionSimple(pattern: string, action: string): boolean {
  if (pattern === "*" || pattern === action) return true;
  const [ps, pa] = pattern.split(":", 2);
  const [as, aa] = action.split(":", 2);
  if (ps !== as) return false;
  if (pa === "*") return true;
  if (pa?.endsWith("*")) return aa?.startsWith(pa.slice(0, -1)) ?? false;
  return false;
}
