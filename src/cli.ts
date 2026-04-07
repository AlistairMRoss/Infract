#!/usr/bin/env node

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { Command } from "commander";
import { parsePreviewJSON } from "./graph/parser.js";
import { analyze } from "./analyzer/analyzer.js";
import { reportConsole } from "./reporter/console.js";
import { reportJSON } from "./reporter/json.js";

const program = new Command();

program
  .name("iac-analyzer")
  .description(
    "Detect permission and linking gaps in SST/Pulumi projects before deployment",
  )
  .option("--explain", "Verbose narration of each analysis step")
  .option("--format <format>", "Output format: console or json", "console")
  .option("--filter <pattern>", "Filter functions by name (supports * wildcard)")
  .option("--strict", "Treat warnings as errors")
  .option("--input <path>", "Path to pulumi preview JSON file (default: stdin)")
  .action(async (options) => {
    try {
      await run(options);
    } catch (err) {
      console.error(
        `Error: ${err instanceof Error ? err.message : String(err)}`,
      );
      process.exit(1);
    }
  });

program.parse();

async function run(options: {
  explain?: boolean;
  format: string;
  filter?: string;
  strict?: boolean;
  input?: string;
}): Promise<void> {
  // Read input
  const data = readInput(options.input);

  // Parse resource graph
  const graph = parsePreviewJSON(data);

  // Find project root
  const projectRoot = findProjectRoot();

  // Run analysis
  const result = analyze(graph, {
    projectRoot,
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

function readInput(path?: string): string {
  if (path) {
    return readFileSync(resolve(path), "utf-8");
  }

  // Read from stdin if piped
  if (!process.stdin.isTTY) {
    return readFileSync(0, "utf-8");
  }

  throw new Error(
    "No input provided. Pipe pulumi preview JSON via stdin or use --input flag.\n\n" +
      "Usage:\n" +
      "  pulumi preview --json | npx iac-analyzer\n" +
      "  npx iac-analyzer --input preview.json",
  );
}

function findProjectRoot(): string {
  const markers = ["sst.config.ts", "sst.config.js", "Pulumi.yaml", "Pulumi.yml"];
  let dir = process.cwd();

  while (true) {
    for (const marker of markers) {
      try {
        readFileSync(resolve(dir, marker));
        return dir;
      } catch {
        // not found, continue
      }
    }
    const parent = resolve(dir, "..");
    if (parent === dir) break;
    dir = parent;
  }

  return process.cwd();
}
