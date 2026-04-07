# can-it-deploy-iac

Static analysis tool for [SST](https://sst.dev) projects that detects permission and resource linking gaps **before deployment**.

Catches issues like:
- A Lambda handler references `Resource.MyTable.name` but `MyTable` isn't in the function's `link` array
- A function makes AWS SDK calls (e.g., `dynamodb:Query`) but lacks the required IAM permissions
- A queue subscriber calls `ses:SendEmail` but no SES permission is granted

No AWS credentials or deployment required. Runs entirely against your source code.

## Install

```bash
npm install can-it-deploy-iac
# or
yarn add can-it-deploy-iac
```

## Usage

Run from your SST project root:

```bash
npx can-it-deploy
```

### Options

| Flag | Description |
|------|-------------|
| `--explain` | Verbose step-by-step narration of the analysis |
| `--no-warnings` | Suppress warnings, only show errors |
| `--strict` | Treat warnings as errors (exit code 1) |
| `--filter <pattern>` | Filter functions by name (supports `*` wildcard) |
| `--format json` | Output results as JSON (for CI/CD pipelines) |
| `--dir <path>` | Path to SST project root (default: current directory) |

### Examples

```bash
# Quick check — errors only
npx can-it-deploy --no-warnings

# Detailed analysis of everything
npx can-it-deploy --explain

# Only check billing routes
npx can-it-deploy --filter "BillingApi:*"

# JSON output for CI
npx can-it-deploy --format json --strict

# Point to a different project
npx can-it-deploy --dir /path/to/my-sst-project
```

## What it detects

### Unlinked Resources (ERROR)

When your handler code references `Resource.X.name` but `X` isn't linked to that function:

```
ERROR: Unlinked Resource Usage
  Function: Api:GET /v1/devices
  references Resource.ExternalDevice.name but "ExternalDevice" is not linked to this function
  Location: packages/core/services/device/getDevices.ts:15
  Fix: Add the ExternalDevice resource to this function's link array
```

### Missing Permissions (ERROR/WARNING)

When your handler makes AWS SDK calls that require permissions not granted to the function:

```
ERROR: Missing IAM Permission
  Function: BillingErrorQueue:subscriber
  calls SendEmailCommand but lacks ses:SendEmail permission
  Location: packages/handlers/billing/emailHandler.ts:32
  Fix: Add { actions: ["ses:SendEmail"], resources: ["*"] } to this function's permissions
```

If the function has `sts:AssumeRole` (cross-account access), missing permissions are downgraded to warnings since the assumed role may provide them.

## How it works

1. **Parses `sst.config.ts`** — follows all imports and re-exports to discover your full infrastructure definition
2. **Extracts resources** — identifies Functions, API routes (`api.route()`), queue subscribers (`.subscribe()`), DynamoDB tables, S3 buckets, queues, secrets, and linkables
3. **Resolves links** — maps variable names to SST resource names (e.g., `billingAccountTable` -> `ExternalBillingAccount`), expands array variables (`allLinkables`), and resolves spread configs (`...crossAccountTransform`)
4. **Resolves permissions** — collects explicit permissions from `permissions: [...]`, `transform.route.handler.permissions`, and spread objects, plus auto-grants from linked resources (linking a `Dynamo` auto-grants `dynamodb:*`, `Bucket` grants `s3:*`, `Queue` grants `sqs:*`)
5. **Scans handler source code** — uses the TypeScript compiler API to walk the AST, following local imports recursively into service/lib modules. Detects:
   - AWS SDK v3 command usage (`new GetItemCommand(...)`, `new SendEmailCommand(...)`, etc.)
   - `@aws-sdk/lib-dynamodb` simplified commands (`GetCommand`, `PutCommand`, etc.)
   - `Resource.X.name` / `Resource.X.url` references
6. **Compares** what the code needs vs what the infrastructure provides, and reports the gaps

## Supported SST patterns

- `new sst.aws.Function()`
- `new sst.aws.ApiGatewayV2()` with `api.route()` calls
- `new sst.aws.Queue()` with `.subscribe()` calls
- `new sst.aws.Dynamo()`, `new sst.aws.Bucket()`
- `new sst.Secret()`, `new sst.Linkable()`
- `addAuthRoute()` helper functions
- `link: [table, bucket, ...allLinkables]` — variable refs, spreads, and array variables
- `permissions: [{ actions: [...], resources: [...] }]`
- `transform: { route: { handler: { permissions: [...] } } }`
- Spread config objects (`...crossAccountTransform`, `...envAndPermissions`)
- Factory functions (`const myTable = createTableLinkable('ExternalTable', ...)`)

## Supported AWS SDK commands

50+ commands across these services:

| Service | Commands |
|---------|----------|
| **DynamoDB** | GetItem, PutItem, UpdateItem, DeleteItem, Query, Scan, BatchGetItem, BatchWriteItem, TransactGetItems, TransactWriteItems + lib-dynamodb equivalents |
| **S3** | GetObject, PutObject, DeleteObject, ListObjects, HeadObject, CopyObject, DeleteObjects, CreateMultipartUpload |
| **SES** | SendEmail, SendRawEmail, SendBulkEmail, SendTemplatedEmail |
| **SQS** | SendMessage, ReceiveMessage, DeleteMessage, SendMessageBatch |
| **SNS** | Publish, Subscribe |
| **EventBridge** | PutEvents |
| **Secrets Manager** | GetSecretValue, PutSecretValue |
| **SSM** | GetParameter, PutParameter, GetParametersByPath |

## JSON output

Use `--format json` for programmatic consumption:

```json
{
  "summary": {
    "totalResources": 23,
    "totalFunctions": 16,
    "totalErrors": 2,
    "totalWarnings": 0
  },
  "functions": [...],
  "violations": [
    {
      "severity": "error",
      "type": "unlinked-resource",
      "resource": "Api:GET /v1/devices",
      "message": "references Resource.ExternalDevice.name but \"ExternalDevice\" is not linked",
      "suggestion": "Add the ExternalDevice resource to this function's link array",
      "filePath": "packages/core/services/device/getDevices.ts",
      "lineNumber": 15
    }
  ]
}
```

## CI/CD integration

```bash
# Fail the build if any errors are found
npx can-it-deploy --no-warnings

# Fail on warnings too
npx can-it-deploy --strict

# JSON for parsing in scripts
npx can-it-deploy --format json --no-warnings | jq '.summary.totalErrors'
```

## License

MIT
