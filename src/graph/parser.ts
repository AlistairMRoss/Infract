import ts from "typescript";
import { readFileSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import type { SSTResource, SSTResourceType, Permission, SSTProject } from "./types.js";

const SST_RESOURCE_TYPES: Record<string, SSTResourceType> = {
  "sst.aws.Function": "Function",
  "sst.aws.ApiGatewayV2": "ApiGatewayV2",
  "sst.aws.Dynamo": "Dynamo",
  "sst.aws.Bucket": "Bucket",
  "sst.aws.Queue": "Queue",
  "sst.Secret": "Secret",
  "sst.Linkable": "Linkable",
};

interface FactoryDef {
  resourceType: SSTResourceType;
  nameArgIndex: number;
  configArgIndex: number | null;
  staticLinks: string[];
  staticPermissions: Permission[];
  staticHandler: string | null;
  staticSpreadRefs: string[];
}

export function parseSSTProject(projectRoot: string): SSTProject {
  const configPath = findSSTConfig(projectRoot);
  if (!configPath) {
    throw new Error(
      `No sst.config.ts or sst.config.js found in ${projectRoot}`,
    );
  }

  const project: SSTProject = {
    resources: new Map(),
    varToResource: new Map(),
    projectRoot,
  };

  const configVars = new Map<string, { permissions: Permission[]; links: string[] }>();
  const arrayVars = new Map<string, string[]>();
  const factories = new Map<string, FactoryDef>();

  const filesToParse = collectInfraFiles(configPath, projectRoot);

  for (const file of filesToParse) {
    collectFactories(file, factories);
  }

  for (const file of filesToParse) {
    parseFile(file, project, configVars, arrayVars, factories);
  }

  resolveArrayVars(arrayVars);

  resolveSpreadRefs(project, configVars);

  resolveAllLinkSpreads(project, arrayVars);

  resolveAllLinks(project);

  return project;
}

function findSSTConfig(root: string): string | null {
  for (const name of ["sst.config.ts", "sst.config.js"]) {
    const candidate = resolve(root, name);
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

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
      if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
        const resolved = resolveImportPath(node.moduleSpecifier.text, file, projectRoot);
        if (resolved) queue.push(resolved);
      }

      if (ts.isExportDeclaration(node) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
        const resolved = resolveImportPath(node.moduleSpecifier.text, file, projectRoot);
        if (resolved) queue.push(resolved);
      }

      if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
        const arg = node.arguments[0];
        if (arg && ts.isStringLiteral(arg)) {
          const resolved = resolveImportPath(arg.text, file, projectRoot);
          if (resolved) queue.push(resolved);
        }
      }

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
  if (specifier.startsWith(".") || specifier.startsWith("/")) {
    const base = specifier.startsWith("/")
      ? resolve(projectRoot, specifier)
      : resolve(dirname(fromFile), specifier);

    if (base.includes(".sst/platform")) return null;

    return resolveFileOrIndex(base);
  }

  return resolveBareSpecifier(specifier, fromFile);
}

function resolveFileOrIndex(base: string): string | null {
  const extensions = [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"];

  for (const ext of extensions) {
    const candidate = base + ext;
    if (existsSync(candidate)) return candidate;
  }

  for (const ext of extensions) {
    const candidate = resolve(base, "index" + ext);
    if (existsSync(candidate)) return candidate;
  }

  if (existsSync(base)) return base;

  return null;
}

function resolveBareSpecifier(specifier: string, fromFile: string): string | null {
  const { pkgName, subpath } = parseBareSpecifier(specifier);

  const pkgRoot = findPackageRoot(pkgName, fromFile);
  if (!pkgRoot) return null;

  const pkgJsonPath = resolve(pkgRoot, "package.json");
  let pkgJson: Record<string, unknown> | null = null;
  try {
    pkgJson = JSON.parse(readFileSync(pkgJsonPath, "utf-8")) as Record<string, unknown>;
  } catch {
    pkgJson = null;
  }

  if (pkgJson) {
    const viaExports = resolveExports(pkgJson.exports, subpath, pkgRoot);
    if (viaExports) return viaExports;

    if (subpath === null) {
      for (const field of ["main", "module"]) {
        const value = pkgJson[field];
        if (typeof value === "string") {
          const resolved = resolveFileOrIndex(resolve(pkgRoot, value));
          if (resolved) return resolved;
        }
      }
    }
  }

  const directTarget = subpath === null ? pkgRoot : resolve(pkgRoot, subpath);
  const direct = resolveFileOrIndex(directTarget);
  if (direct) return direct;

  if (subpath !== null) {
    for (const distPrefix of ["dist/src", "dist", "build", "lib"]) {
      const candidate = resolve(pkgRoot, distPrefix, subpath);
      const resolved = resolveFileOrIndex(candidate);
      if (resolved) return resolved;
    }
  }

  return null;
}

function parseBareSpecifier(specifier: string): { pkgName: string; subpath: string | null } {
  if (specifier.startsWith("@")) {
    const parts = specifier.split("/");
    if (parts.length < 2) return { pkgName: specifier, subpath: null };
    const pkgName = `${parts[0]}/${parts[1]}`;
    const subpath = parts.length > 2 ? parts.slice(2).join("/") : null;
    return { pkgName, subpath };
  }
  const slash = specifier.indexOf("/");
  if (slash === -1) return { pkgName: specifier, subpath: null };
  return { pkgName: specifier.slice(0, slash), subpath: specifier.slice(slash + 1) };
}

function findPackageRoot(pkgName: string, fromFile: string): string | null {
  let dir = dirname(fromFile);
  while (true) {
    const candidate = resolve(dir, "node_modules", pkgName);
    if (existsSync(resolve(candidate, "package.json"))) return candidate;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

function resolveExports(
  exports: unknown,
  subpath: string | null,
  pkgRoot: string,
): string | null {
  if (!exports || typeof exports !== "object") return null;

  const key = subpath === null ? "." : `./${subpath}`;
  const entry = (exports as Record<string, unknown>)[key];
  if (entry === undefined) return null;

  const target = pickExportCondition(entry);
  if (!target) return null;

  return resolveFileOrIndex(resolve(pkgRoot, target));
}

function pickExportCondition(entry: unknown): string | null {
  if (typeof entry === "string") return entry;
  if (entry && typeof entry === "object") {
    const obj = entry as Record<string, unknown>;
    for (const key of ["import", "node", "default", "require", "types"]) {
      const value = obj[key];
      if (typeof value === "string") return value;
      if (value && typeof value === "object") {
        const nested = pickExportCondition(value);
        if (nested) return nested;
      }
    }
  }
  return null;
}

function collectFactories(
  filePath: string,
  factories: Map<string, FactoryDef>,
): void {
  const source = safeReadFile(filePath);
  if (!source) return;

  const sf = ts.createSourceFile(filePath, source, ts.ScriptTarget.ESNext, true);

  function visit(node: ts.Node): void {
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.initializer &&
      (ts.isArrowFunction(node.initializer) || ts.isFunctionExpression(node.initializer))
    ) {
      const def = extractFactoryDef(node.initializer);
      if (def) factories.set(node.name.text, def);
    }

    if (ts.isFunctionDeclaration(node) && node.name && node.body) {
      const def = extractFactoryDef(node);
      if (def) factories.set(node.name.text, def);
    }

    ts.forEachChild(node, visit);
  }

  ts.forEachChild(sf, visit);
}

function extractFactoryDef(
  fn: ts.ArrowFunction | ts.FunctionExpression | ts.FunctionDeclaration,
): FactoryDef | null {
  const paramNames: string[] = [];
  let restParamName: string | null = null;
  fn.parameters.forEach((p, i) => {
    if (!ts.isIdentifier(p.name)) {
      paramNames.push(`__param${i}__`);
      return;
    }
    if (p.dotDotDotToken) restParamName = p.name.text;
    paramNames.push(p.name.text);
  });

  let newExpr: ts.NewExpression | null = null;
  const search = (node: ts.Node): void => {
    if (newExpr) return;
    if (ts.isNewExpression(node) && isSST(node.expression)) {
      newExpr = node;
      return;
    }
    ts.forEachChild(node, search);
  };
  if (fn.body) search(fn.body);
  if (!newExpr) return null;

  const newExpression: ts.NewExpression = newExpr;
  const sstType = getSST(newExpression.expression);
  const resourceType = sstType ? SST_RESOURCE_TYPES[sstType] : undefined;
  if (!resourceType) return null;

  const args = newExpression.arguments ?? ts.factory.createNodeArray();
  if (args.length === 0) return null;

  const nameArgIndex = resolveArgIndex(args[0], paramNames, restParamName);
  if (nameArgIndex === null) return null;

  let configArgIndex: number | null = null;
  const staticLinks: string[] = [];
  const staticPermissions: Permission[] = [];
  let staticHandler: string | null = null;
  const staticSpreadRefs: string[] = [];

  const configArg = args[1];
  if (configArg) {
    const directIdx = resolveArgIndex(configArg, paramNames, restParamName);
    if (directIdx !== null) {
      configArgIndex = directIdx;
    } else if (ts.isObjectLiteralExpression(configArg)) {
      for (const prop of configArg.properties) {
        if (ts.isSpreadAssignment(prop)) {
          const spreadIdx = resolveArgIndex(prop.expression, paramNames, restParamName);
          if (spreadIdx !== null) {
            configArgIndex = spreadIdx;
          } else if (ts.isIdentifier(prop.expression)) {
            staticSpreadRefs.push(prop.expression.text);
          }
          continue;
        }
        if (!ts.isPropertyAssignment(prop) || !ts.isIdentifier(prop.name)) continue;

        switch (prop.name.text) {
          case "handler":
            if (ts.isStringLiteral(prop.initializer)) {
              staticHandler = prop.initializer.text;
            }
            break;
          case "link":
            staticLinks.push(...extractLinkNames(prop.initializer));
            break;
          case "permissions":
            staticPermissions.push(...extractPermissions(prop.initializer));
            break;
        }
      }
    }
  }

  return {
    resourceType,
    nameArgIndex,
    configArgIndex,
    staticLinks,
    staticPermissions,
    staticHandler,
    staticSpreadRefs,
  };
}

function resolveArgIndex(
  expr: ts.Expression,
  paramNames: string[],
  restParamName: string | null,
): number | null {
  if (ts.isIdentifier(expr)) {
    const idx = paramNames.indexOf(expr.text);
    return idx >= 0 ? idx : null;
  }
  if (
    ts.isElementAccessExpression(expr) &&
    ts.isIdentifier(expr.expression) &&
    restParamName !== null &&
    expr.expression.text === restParamName &&
    expr.argumentExpression &&
    ts.isNumericLiteral(expr.argumentExpression)
  ) {
    return Number(expr.argumentExpression.text);
  }
  return null;
}

function parseFile(
  filePath: string,
  project: SSTProject,
  configVars: Map<string, { permissions: Permission[]; links: string[] }>,
  arrayVars: Map<string, string[]>,
  factories: Map<string, FactoryDef>,
): void {
  const source = safeReadFile(filePath);
  if (!source) return;

  const sf = ts.createSourceFile(filePath, source, ts.ScriptTarget.ESNext, true);

  const varToResource = project.varToResource;

  function visit(node: ts.Node): void {
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

    // Detect: const varName = someFactory('ResourceName', ...)
    // Handles patterns like: const billingAccountTable = createTableLinkable('ExternalBillingAccount', ...)
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.arguments.length > 0 &&
      ts.isStringLiteral(node.arguments[0]) &&
      ts.isVariableDeclaration(node.parent) &&
      ts.isIdentifier(node.parent.name)
    ) {
      const varName = node.parent.name.text;
      const firstArg = node.arguments[0] as ts.StringLiteral;
      varToResource.set(varName, firstArg.text);
    }

    // Factory call site: createLambda('AdminApi', { handler: '...' })
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      factories.has(node.expression.text)
    ) {
      const def = factories.get(node.expression.text)!;
      const nameArg = node.arguments[def.nameArgIndex];
      if (nameArg && ts.isStringLiteral(nameArg)) {
        const name = nameArg.text;
        const { line } = sf.getLineAndCharacterOfPosition(node.getStart(sf));

        const resource: SSTResource = {
          name,
          type: def.resourceType,
          handler: def.staticHandler,
          links: [...def.staticLinks],
          permissions: def.staticPermissions.map((p) => ({
            actions: [...p.actions],
            resources: [...p.resources],
          })),
          parentApi: null,
          definedAt: { file: filePath, line: line + 1 },
        };

        if (def.staticSpreadRefs.length > 0) {
          resource._spreadRefs = [...def.staticSpreadRefs];
        }

        if (def.configArgIndex !== null) {
          const configArg = node.arguments[def.configArgIndex];
          if (configArg && ts.isObjectLiteralExpression(configArg)) {
            parseResourceConfig(configArg, resource, sf);
          }
        }

        project.resources.set(name, resource);

        if (ts.isVariableDeclaration(node.parent) && ts.isIdentifier(node.parent.name)) {
          varToResource.set(node.parent.name.text, name);
        }
      }
    }

    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      node.expression.name.text === "route"
    ) {
      parseRouteCall(node, sf, filePath, project, varToResource);
    }

    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      node.expression.name.text === "subscribe"
    ) {
      parseSubscribeCall(node, sf, filePath, project, varToResource);
    }

    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === "addAuthRoute"
    ) {
      parseAddAuthRouteCall(node, sf, filePath, project, varToResource);
    }

    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.initializer &&
      ts.isObjectLiteralExpression(node.initializer)
    ) {
      const varName = node.name.text;
      const config = extractConfigFromObject(node.initializer);
      if (config.permissions.length > 0 || config.links.length > 0 || config.spreadRefs.length > 0) {
        configVars.set(varName, config);
      }
    }

    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.initializer &&
      ts.isArrayLiteralExpression(node.initializer)
    ) {
      const varName = node.name.text;
      const elements: string[] = [];
      for (const el of node.initializer.elements) {
        if (ts.isIdentifier(el)) {
          elements.push(el.text);
        } else if (ts.isSpreadElement(el) && ts.isIdentifier(el.expression)) {
          elements.push(`...${el.expression.text}`);
        }
      }
      if (elements.length > 0) {
        arrayVars.set(varName, elements);
      }
    }

    ts.forEachChild(node, visit);
  }

  ts.forEachChild(sf, visit);
}

function extractConfigFromObject(
  obj: ts.ObjectLiteralExpression,
): { permissions: Permission[]; links: string[]; spreadRefs: string[] } {
  const result: { permissions: Permission[]; links: string[]; spreadRefs: string[] } = {
    permissions: [],
    links: [],
    spreadRefs: [],
  };

  for (const prop of obj.properties) {
    if (ts.isSpreadAssignment(prop) && ts.isIdentifier(prop.expression)) {
      result.spreadRefs.push(prop.expression.text);
      continue;
    }
    if (!ts.isPropertyAssignment(prop) || !ts.isIdentifier(prop.name)) continue;

    if (prop.name.text === "permissions") {
      result.permissions.push(...extractPermissions(prop.initializer));
    }
    if (prop.name.text === "link") {
      result.links.push(...extractLinkNames(prop.initializer));
    }
    if (prop.name.text === "transform" || prop.name.text === "route" || prop.name.text === "handler") {
      if (ts.isObjectLiteralExpression(prop.initializer)) {
        const nested = extractConfigFromObject(prop.initializer);
        result.permissions.push(...nested.permissions);
        result.links.push(...nested.links);
        result.spreadRefs.push(...nested.spreadRefs);
      }
    }
  }

  return result;
}

function resolveSpreadRefs(
  project: SSTProject,
  configVars: Map<string, { permissions: Permission[]; links: string[] }>,
): void {
  for (const [name, config] of configVars) {
    if ('spreadRefs' in config) {
      const refs = (config as any).spreadRefs as string[];
      for (const ref of refs) {
        const refConfig = configVars.get(ref);
        if (refConfig) {
          config.permissions.push(...refConfig.permissions);
          config.links.push(...refConfig.links);
        }
      }
    }
  }

  for (const resource of project.resources.values()) {
    if (!resource._spreadRefs) continue;
    for (const ref of resource._spreadRefs) {
      const config = configVars.get(ref);
      if (config) {
        resource.permissions.push(...config.permissions);
        resource.links.push(...config.links);
      }
    }
    delete resource._spreadRefs;
  }

  for (const resource of project.resources.values()) {
    if (resource.parentApi) {
      const parentApi = project.resources.get(resource.parentApi);
      if (parentApi) {
        for (const perm of parentApi.permissions) {
          const already = resource.permissions.some(
            (p) => JSON.stringify(p) === JSON.stringify(perm),
          );
          if (!already) resource.permissions.push(perm);
        }
        for (const link of parentApi.links) {
          if (!resource.links.includes(link)) resource.links.push(link);
        }
      }
    }
  }
}

function resolveArrayVars(arrayVars: Map<string, string[]>): void {
  for (let i = 0; i < 3; i++) {
    for (const [name, elements] of arrayVars) {
      const expanded: string[] = [];
      for (const el of elements) {
        if (el.startsWith("...")) {
          const refName = el.slice(3);
          const refElements = arrayVars.get(refName);
          if (refElements) {
            expanded.push(...refElements);
          } else {
            expanded.push(el);
          }
        } else {
          expanded.push(el);
        }
      }
      arrayVars.set(name, expanded);
    }
  }
}

function resolveAllLinkSpreads(
  project: SSTProject,
  arrayVars: Map<string, string[]>,
): void {
  for (const resource of project.resources.values()) {
    const expanded: string[] = [];
    for (const link of resource.links) {
      if (link.startsWith("...")) {
        const arrayName = link.slice(3);
        const elements = arrayVars.get(arrayName);
        if (elements) {
          expanded.push(...elements);
        } else {
          expanded.push(link);
        }
      } else {
        expanded.push(link);
      }
    }
    resource.links = expanded;
  }
}

function resolveAllLinks(project: SSTProject): void {
  for (const resource of project.resources.values()) {
    resource.links = resource.links.map((varName) => {
      if (varName.startsWith("...")) return varName;

      const resourceName = project.varToResource.get(varName);
      if (resourceName) return resourceName;

      return varName;
    });
  }
}

function parseResourceConfig(
  obj: ts.ObjectLiteralExpression,
  resource: SSTResource,
  sf: ts.SourceFile,
): void {
  for (const prop of obj.properties) {
    if (ts.isSpreadAssignment(prop)) {
      if (ts.isIdentifier(prop.expression)) {
        resource._spreadRefs = resource._spreadRefs ?? [];
        resource._spreadRefs.push(prop.expression.text);
      }
      continue;
    }

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
        extractTransformConfig(prop.initializer, resource);
        break;
    }
  }
}

function extractLinkNames(node: ts.Node): string[] {
  const names: string[] = [];

  if (ts.isArrayLiteralExpression(node)) {
    for (const el of node.elements) {
      if (ts.isIdentifier(el)) {
        names.push(el.text);
      } else if (ts.isSpreadElement(el) && ts.isIdentifier(el.expression)) {
        names.push(`...${el.expression.text}`);
      }
    }
  } else if (ts.isIdentifier(node)) {
    names.push(`...${node.text}`);
  }

  return names;
}

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

  if (parentApiName) {
    const parentApi = project.resources.get(parentApiName);
    if (parentApi) {
      resource.links = [...parentApi.links];
      resource.permissions = [...parentApi.permissions];
    }
  }

  project.resources.set(routeName, resource);
}

function isSST(expr: ts.Expression): boolean {
  return getSST(expr) !== null;
}

function getSST(expr: ts.Expression): string | null {
  if (ts.isPropertyAccessExpression(expr)) {
    const inner = expr.expression;
    if (
      ts.isPropertyAccessExpression(inner) &&
      ts.isIdentifier(inner.expression) &&
      inner.expression.text === "sst" &&
      ts.isIdentifier(inner.name) &&
      inner.name.text === "aws"
    ) {
      return `sst.aws.${expr.name.text}`;
    }
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
