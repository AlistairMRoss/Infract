import ts from "typescript";
import { readFileSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import type { SSTResource, SSTResourceType, Permission, SSTProject } from "./types.js";

/** SST resource constructor names -> our resource types */
const SST_RESOURCE_TYPES: Record<string, SSTResourceType> = {
  "sst.aws.Function": "Function",
  "sst.aws.ApiGatewayV2": "ApiGatewayV2",
  "sst.aws.Dynamo": "Dynamo",
  "sst.aws.Bucket": "Bucket",
  "sst.aws.Queue": "Queue",
  "sst.Secret": "Secret",
  "sst.Linkable": "Linkable",
};

/** Parse an SST project by reading sst.config.ts and following imports. */
export function parseSSTProject(projectRoot: string): SSTProject {
  const configPath = findSSTConfig(projectRoot);
  if (!configPath) {
    throw new Error(
      `No sst.config.ts or sst.config.js found in ${projectRoot}`,
    );
  }

  const project: SSTProject = {
    resources: new Map(),
    projectRoot,
  };

  // Collect all TS files reachable from the config
  const filesToParse = collectInfraFiles(configPath, projectRoot);

  // Parse each file for SST resource definitions
  for (const file of filesToParse) {
    parseFile(file, project);
  }

  return project;
}

function findSSTConfig(root: string): string | null {
  for (const name of ["sst.config.ts", "sst.config.js"]) {
    const candidate = resolve(root, name);
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

/** Follow imports from sst.config.ts to find all infra files. */
function collectInfraFiles(configPath: string, projectRoot: string): string[] {
  const visited = new Set<string>();
  const queue = [configPath];

  while (queue.length > 0) {
    const file = queue.pop()!;
    if (visited.has(file)) continue;
    visited.add(file);

    const source = safeReadFile(file);
    if (!source) continue;

    const sf = ts.createSourceFile(file, source, ts.ScriptTarget.ESNext, true);

    ts.forEachChild(sf, (node) => {
      // Static imports: import { x } from './infra/foo'
      if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
        const resolved = resolveImportPath(node.moduleSpecifier.text, file, projectRoot);
        if (resolved) queue.push(resolved);
      }

      // Dynamic imports: await import('./infra/foo')
      if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
        const arg = node.arguments[0];
        if (arg && ts.isStringLiteral(arg)) {
          const resolved = resolveImportPath(arg.text, file, projectRoot);
          if (resolved) queue.push(resolved);
        }
      }

      // Walk deeper for dynamic imports inside functions
      walkForDynamicImports(node, file, projectRoot, queue);
    });
  }

  return [...visited];
}

function walkForDynamicImports(
  node: ts.Node,
  currentFile: string,
  projectRoot: string,
  queue: string[],
): void {
  ts.forEachChild(node, (child) => {
    if (
      ts.isCallExpression(child) &&
      child.expression.kind === ts.SyntaxKind.ImportKeyword &&
      child.arguments[0] &&
      ts.isStringLiteral(child.arguments[0])
    ) {
      const resolved = resolveImportPath(child.arguments[0].text, currentFile, projectRoot);
      if (resolved) queue.push(resolved);
    }
    walkForDynamicImports(child, currentFile, projectRoot, queue);
  });
}

function resolveImportPath(
  specifier: string,
  fromFile: string,
  projectRoot: string,
): string | null {
  // Only follow relative imports (not npm packages)
  if (!specifier.startsWith(".") && !specifier.startsWith("/")) return null;

  const base = specifier.startsWith("/")
    ? resolve(projectRoot, specifier)
    : resolve(dirname(fromFile), specifier);

  const extensions = [".ts", ".tsx", ".js", ".jsx"];

  // Try direct path
  for (const ext of extensions) {
    const candidate = base + ext;
    if (existsSync(candidate)) return candidate;
  }

  // Try as directory with index
  for (const ext of extensions) {
    const candidate = resolve(base, "index" + ext);
    if (existsSync(candidate)) return candidate;
  }

  // Try exact path (if it already has extension)
  if (existsSync(base)) return base;

  return null;
}

/** Parse a single file for SST resource definitions. */
function parseFile(filePath: string, project: SSTProject): void {
  const source = safeReadFile(filePath);
  if (!source) return;

  const sf = ts.createSourceFile(filePath, source, ts.ScriptTarget.ESNext, true);

  // Track variable names -> resource names for link resolution
  const varToResource = new Map<string, string>();

  function visit(node: ts.Node): void {
    // Detect: new sst.aws.X("Name", { ... })
    if (ts.isNewExpression(node) && isSST(node.expression)) {
      const sstType = getSST(node.expression);
      const resourceType = sstType ? SST_RESOURCE_TYPES[sstType] : undefined;
      if (!resourceType) {
        ts.forEachChild(node, visit);
        return;
      }

      const args = node.arguments;
      if (!args || args.length === 0) {
        ts.forEachChild(node, visit);
        return;
      }

      // First arg is always the logical name
      const nameArg = args[0];
      const name = ts.isStringLiteral(nameArg) ? nameArg.text : null;
      if (!name) {
        ts.forEachChild(node, visit);
        return;
      }

      const { line } = sf.getLineAndCharacterOfPosition(node.getStart(sf));

      const resource: SSTResource = {
        name,
        type: resourceType,
        handler: null,
        links: [],
        permissions: [],
        parentApi: null,
        definedAt: { file: filePath, line: line + 1 },
      };

      // Parse config object (second argument)
      const configArg = args[1];
      if (configArg && ts.isObjectLiteralExpression(configArg)) {
        parseResourceConfig(configArg, resource, sf);
      }

      project.resources.set(name, resource);

      // Track variable assignment: const myTable = new sst.aws.Dynamo("MyTable", ...)
      if (ts.isVariableDeclaration(node.parent) && ts.isIdentifier(node.parent.name)) {
        varToResource.set(node.parent.name.text, name);
      }
    }

    // Detect: api.route("GET /path", "handler.handler", { ... })
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      node.expression.name.text === "route"
    ) {
      parseRouteCall(node, sf, filePath, project, varToResource);
    }

    // Detect: queue.subscribe({ handler: "...", link: [...] })
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      node.expression.name.text === "subscribe"
    ) {
      parseSubscribeCall(node, sf, filePath, project, varToResource);
    }

    // Detect: addAuthRoute(api, { path: "...", handler: "..." }, ...)
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === "addAuthRoute"
    ) {
      parseAddAuthRouteCall(node, sf, filePath, project, varToResource);
    }

    ts.forEachChild(node, visit);
  }

  ts.forEachChild(sf, visit);
}

function parseResourceConfig(
  obj: ts.ObjectLiteralExpression,
  resource: SSTResource,
  sf: ts.SourceFile,
): void {
  for (const prop of obj.properties) {
    if (!ts.isPropertyAssignment(prop) || !ts.isIdentifier(prop.name)) continue;
    const key = prop.name.text;

    switch (key) {
      case "handler":
        if (ts.isStringLiteral(prop.initializer)) {
          resource.handler = prop.initializer.text;
        }
        break;

      case "link":
        resource.links.push(...extractLinkNames(prop.initializer));
        break;

      case "permissions":
        resource.permissions.push(...extractPermissions(prop.initializer));
        break;

      case "transform":
        // Extract permissions and links from transform.route.handler
        extractTransformConfig(prop.initializer, resource);
        break;
    }
  }
}

/** Extract resource variable names from a link array: link: [table, bucket] */
function extractLinkNames(node: ts.Node): string[] {
  const names: string[] = [];

  if (ts.isArrayLiteralExpression(node)) {
    for (const el of node.elements) {
      if (ts.isIdentifier(el)) {
        names.push(el.text);
      } else if (ts.isSpreadElement(el) && ts.isIdentifier(el.expression)) {
        // link: [...allTables] — we capture the spread variable name
        names.push(`...${el.expression.text}`);
      }
    }
  }

  return names;
}

/** Extract Permission objects from: permissions: [{ actions: [...], resources: [...] }] */
function extractPermissions(node: ts.Node): Permission[] {
  const perms: Permission[] = [];

  if (!ts.isArrayLiteralExpression(node)) return perms;

  for (const el of node.elements) {
    if (!ts.isObjectLiteralExpression(el)) continue;

    const perm: Permission = { actions: [], resources: [] };

    for (const prop of el.properties) {
      if (!ts.isPropertyAssignment(prop) || !ts.isIdentifier(prop.name)) continue;

      if (prop.name.text === "actions" && ts.isArrayLiteralExpression(prop.initializer)) {
        for (const actionEl of prop.initializer.elements) {
          if (ts.isStringLiteral(actionEl)) perm.actions.push(actionEl.text);
        }
      }
      if (prop.name.text === "resources" && ts.isArrayLiteralExpression(prop.initializer)) {
        for (const resEl of prop.initializer.elements) {
          if (ts.isStringLiteral(resEl)) perm.resources.push(resEl.text);
        }
      }
    }

    if (perm.actions.length > 0) perms.push(perm);
  }

  return perms;
}

/** Extract config from transform: { route: { handler: { permissions, link } } } */
function extractTransformConfig(node: ts.Node, resource: SSTResource): void {
  if (!ts.isObjectLiteralExpression(node)) return;

  for (const prop of node.properties) {
    if (!ts.isPropertyAssignment(prop) || !ts.isIdentifier(prop.name)) continue;

    if (prop.name.text === "route" && ts.isObjectLiteralExpression(prop.initializer)) {
      for (const routeProp of prop.initializer.properties) {
        if (
          ts.isPropertyAssignment(routeProp) &&
          ts.isIdentifier(routeProp.name) &&
          routeProp.name.text === "handler" &&
          ts.isObjectLiteralExpression(routeProp.initializer)
        ) {
          for (const handlerProp of routeProp.initializer.properties) {
            if (!ts.isPropertyAssignment(handlerProp) || !ts.isIdentifier(handlerProp.name)) continue;

            if (handlerProp.name.text === "permissions") {
              resource.permissions.push(...extractPermissions(handlerProp.initializer));
            }
            if (handlerProp.name.text === "link") {
              resource.links.push(...extractLinkNames(handlerProp.initializer));
            }
          }
        }
      }
    }
  }
}

/** Parse api.route("GET /path", "handler.ts", { link: [...] }) */
function parseRouteCall(
  node: ts.CallExpression,
  sf: ts.SourceFile,
  filePath: string,
  project: SSTProject,
  varToResource: Map<string, string>,
): void {
  const args = node.arguments;
  if (args.length < 2) return;

  const pathArg = args[0];
  const handlerArg = args[1];

  const routePath = ts.isStringLiteral(pathArg) ? pathArg.text : null;
  const handler = ts.isStringLiteral(handlerArg) ? handlerArg.text : null;
  if (!routePath || !handler) return;

  // Determine parent API name
  let parentApiName: string | null = null;
  if (ts.isPropertyAccessExpression(node.expression) && ts.isIdentifier(node.expression.expression)) {
    const apiVarName = node.expression.expression.text;
    parentApiName = varToResource.get(apiVarName) ?? apiVarName;
  }

  const { line } = sf.getLineAndCharacterOfPosition(node.getStart(sf));
  const routeName = `${parentApiName ?? "api"}:${routePath}`;

  const resource: SSTResource = {
    name: routeName,
    type: "ApiRoute",
    handler,
    links: [],
    permissions: [],
    parentApi: parentApiName,
    definedAt: { file: filePath, line: line + 1 },
  };

  // Parse route options (third argument)
  const optionsArg = args[2];
  if (optionsArg && ts.isObjectLiteralExpression(optionsArg)) {
    parseResourceConfig(optionsArg, resource, sf);
  }

  // Inherit links and permissions from parent API
  if (parentApiName) {
    const parentApi = project.resources.get(parentApiName);
    if (parentApi) {
      resource.links = [...parentApi.links, ...resource.links];
      resource.permissions = [...parentApi.permissions, ...resource.permissions];
    }
  }

  project.resources.set(routeName, resource);
}

/** Parse queue.subscribe({ handler: "...", link: [...], permissions: [...] }) */
function parseSubscribeCall(
  node: ts.CallExpression,
  sf: ts.SourceFile,
  filePath: string,
  project: SSTProject,
  varToResource: Map<string, string>,
): void {
  const args = node.arguments;
  if (args.length === 0) return;

  const configArg = args[0];
  if (!ts.isObjectLiteralExpression(configArg)) return;

  // Determine parent queue name
  let parentQueueName: string | null = null;
  if (ts.isPropertyAccessExpression(node.expression) && ts.isIdentifier(node.expression.expression)) {
    const queueVarName = node.expression.expression.text;
    parentQueueName = varToResource.get(queueVarName) ?? queueVarName;
  }

  const { line } = sf.getLineAndCharacterOfPosition(node.getStart(sf));

  const resource: SSTResource = {
    name: `${parentQueueName ?? "queue"}:subscriber`,
    type: "QueueSubscriber",
    handler: null,
    links: [],
    permissions: [],
    parentApi: null,
    definedAt: { file: filePath, line: line + 1 },
  };

  parseResourceConfig(configArg, resource, sf);
  project.resources.set(resource.name, resource);
}

/** Parse addAuthRoute(api, { path: "...", handler: "..." }, authItem) */
function parseAddAuthRouteCall(
  node: ts.CallExpression,
  sf: ts.SourceFile,
  filePath: string,
  project: SSTProject,
  varToResource: Map<string, string>,
): void {
  const args = node.arguments;
  if (args.length < 2) return;

  // First arg is the API variable
  let parentApiName: string | null = null;
  if (ts.isIdentifier(args[0])) {
    parentApiName = varToResource.get(args[0].text) ?? args[0].text;
  }

  // Second arg is { path: "...", handler: "..." }
  const configArg = args[1];
  if (!ts.isObjectLiteralExpression(configArg)) return;

  let routePath: string | null = null;
  let handler: string | null = null;

  for (const prop of configArg.properties) {
    if (!ts.isPropertyAssignment(prop) || !ts.isIdentifier(prop.name)) continue;
    if (prop.name.text === "path" && ts.isStringLiteral(prop.initializer)) {
      routePath = prop.initializer.text;
    }
    if (prop.name.text === "handler" && ts.isStringLiteral(prop.initializer)) {
      handler = prop.initializer.text;
    }
  }

  if (!routePath || !handler) return;

  const { line } = sf.getLineAndCharacterOfPosition(node.getStart(sf));
  const routeName = `${parentApiName ?? "api"}:${routePath}`;

  const resource: SSTResource = {
    name: routeName,
    type: "ApiRoute",
    handler,
    links: [],
    permissions: [],
    parentApi: parentApiName,
    definedAt: { file: filePath, line: line + 1 },
  };

  // Inherit from parent API
  if (parentApiName) {
    const parentApi = project.resources.get(parentApiName);
    if (parentApi) {
      resource.links = [...parentApi.links];
      resource.permissions = [...parentApi.permissions];
    }
  }

  project.resources.set(routeName, resource);
}

/** Check if an expression is sst.aws.X or sst.X */
function isSST(expr: ts.Expression): boolean {
  return getSST(expr) !== null;
}

function getSST(expr: ts.Expression): string | null {
  // sst.aws.Function -> PropertyAccessExpression
  if (ts.isPropertyAccessExpression(expr)) {
    const inner = expr.expression;
    // sst.aws.X
    if (
      ts.isPropertyAccessExpression(inner) &&
      ts.isIdentifier(inner.expression) &&
      inner.expression.text === "sst" &&
      ts.isIdentifier(inner.name) &&
      inner.name.text === "aws"
    ) {
      return `sst.aws.${expr.name.text}`;
    }
    // sst.X (e.g., sst.Secret, sst.Linkable)
    if (ts.isIdentifier(inner) && inner.text === "sst") {
      return `sst.${expr.name.text}`;
    }
  }
  return null;
}

function safeReadFile(filePath: string): string | null {
  try {
    return readFileSync(filePath, "utf-8");
  } catch {
    return null;
  }
}
