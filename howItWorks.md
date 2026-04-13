# Infract — How Your SST Parser Works

**What it does:** Takes an SST project directory, parses `sst.config.ts`, and reports IAM permission gaps / missing resource links before you deploy. Outputs human text or JSON.

## Pipeline (4 stages)

**1. Infrastructure graph parsing** — `src/graph/parser.ts:18`
Starts at `sst.config.ts`, follows imports via the TypeScript compiler API to find all infra files. AST-walks each file to extract `new sst.aws.Function/Dynamo/...` definitions plus their `permissions`, `link`, and spread configs. Runs multiple passes to resolve spreads (`...allTables`) and variable-to-resource mappings in dependency order.

**2. Handler code analysis** — `src/codeanalysis/scanner.ts:14`
For every compute resource (Functions, API routes, queue subscribers), opens the handler file and recursively walks relative imports into service/lib code. Two-pass AST scan: (a) collect imported AWS SDK v3 commands, (b) find `new XxxCommand(...)` instantiations and `Resource.X.name/url` accesses. Uses `src/codeanalysis/patterns.ts` as a lookup of ~50 SDK commands → IAM actions (e.g. `PutItemCommand` → `dynamodb:PutItem`).

**3. Violation detection** — `src/analyzer/analyzer.ts:22`
Builds *effective permissions* = explicit `permissions` + auto-grants from `link` (linking a `Dynamo` auto-grants `dynamodb:*`). Compares detected SDK calls against that set. Supports `service:*` / `*` wildcard matching (`analyzer.ts:160`). Downgrades to warnings when a function assumes a cross-account role. Flags `Resource.X` usage where `X` isn't linked.

**4. Reporting** — `src/reporter/console.ts`, `src/reporter/json.ts`
Formats by severity with file locations and fix suggestions.

## Notable techniques

- TypeScript compiler AST (no full typecheck) for both infra configs and handlers
- Multi-pass variable/spread resolution (`parser.ts:45`)
- BFS import traversal for file discovery
- Factory pattern recognition like `createTableLinkable('Name', ...)` (`parser.ts:233`)

Short version: **discover infra → scan handlers → diff required-vs-granted IAM → report.**
