#!/usr/bin/env node

import { resolve } from "node:path";
import { Command } from "commander";
import { parseSSTProject } from "./graph/parser.js";
import { analyze } from "./analyzer/analyzer.js";
import { reportConsole } from "./reporter/console.js";
import { reportJSON } from "./reporter/json.js";

const program = new Command();

program
  .name("can-it-deploy")
  .description(
    "Detect permission and linking gaps in SST projects before deployment",
  )
  .option("--explain", "Verbose narration of each analysis step")
  .option("--format <format>", "Output format: console or json", "console")
  .option("--filter <pattern>", "Filter functions by name (supports * wildcard)")
  .option("--strict", "Treat warnings as errors")
  .option("--dir <path>", "Path to SST project root (default: current directory)")
  .action((options) => {
    try {
      run(options);
    } catch (err) {
      console.error(
        `Error: ${err instanceof Error ? err.message : String(err)}`,
      );
      process.exit(1);
    }
  });

program.parse();

function run(options: {
  explain?: boolean;
  format: string;
  filter?: string;
  strict?: boolean;
  dir?: string;
}): void {
  const projectRoot = resolve(options.dir ?? process.cwd());

  // Parse SST config
  const project = parseSSTProject(projectRoot);

  // Run analysis
  const result = analyze(project, {
    filter: options.filter,
  });

  // Report
  if (options.format === "json") {
    reportJSON(result);
  } else {
    reportConsole(result, options.explain ?? false);
  }

  // Exit code
  const hasErrors = result.violations.some(
    (v) =>
      v.severity === "error" ||
      (options.strict && v.severity === "warning"),
  );

  if (hasErrors) process.exit(1);
}
