import ts from "typescript";
import { readFileSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
/** SST resource constructor names -> our resource types */
const SST_RESOURCE_TYPES = {
    "sst.aws.Function": "Function",
    "sst.aws.ApiGatewayV2": "ApiGatewayV2",
    "sst.aws.Dynamo": "Dynamo",
    "sst.aws.Bucket": "Bucket",
    "sst.aws.Queue": "Queue",
    "sst.Secret": "Secret",
    "sst.Linkable": "Linkable",
};
/** Parse an SST project by reading sst.config.ts and following imports. */
export function parseSSTProject(projectRoot) {
    const configPath = findSSTConfig(projectRoot);
    if (!configPath) {
        throw new Error(`No sst.config.ts or sst.config.js found in ${projectRoot}`);
    }
    const project = {
        resources: new Map(),
        varToResource: new Map(),
        projectRoot,
    };
    // Track config variable objects (e.g., const envAndPermissions = { permissions: [...] })
    const configVars = new Map();
    // Track array variables (e.g., const allLinkables = [...allTables, ...allQueues])
    const arrayVars = new Map();
    // Collect all TS files reachable from the config
    const filesToParse = collectInfraFiles(configPath, projectRoot);
    // First pass: parse all files to discover resources, variable mappings, and config vars
    for (const file of filesToParse) {
        parseFile(file, project, configVars, arrayVars);
    }
    // Resolve array variable spreads (allLinkables = [...allTables, ...allQueues])
    resolveArrayVars(arrayVars);
    // Second pass: resolve spread references using collected config vars
    resolveSpreadRefs(project, configVars);
    // Third pass: resolve link spread references (e.g., ...allLinkables) to actual resource names
    resolveAllLinkSpreads(project, arrayVars);
    // Fourth pass: resolve link variable names to SST resource names
    resolveAllLinks(project);
    return project;
}
function findSSTConfig(root) {
    for (const name of ["sst.config.ts", "sst.config.js"]) {
        const candidate = resolve(root, name);
        if (existsSync(candidate))
            return candidate;
    }
    return null;
}
/** Follow imports from sst.config.ts to find all infra files. */
function collectInfraFiles(configPath, projectRoot) {
    const visited = new Set();
    const queue = [configPath];
    while (queue.length > 0) {
        const file = queue.pop();
        if (visited.has(file))
            continue;
        visited.add(file);
        const source = safeReadFile(file);
        if (!source)
            continue;
        const sf = ts.createSourceFile(file, source, ts.ScriptTarget.ESNext, true);
        ts.forEachChild(sf, (node) => {
            // Static imports: import { x } from './infra/foo'
            if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
                const resolved = resolveImportPath(node.moduleSpecifier.text, file, projectRoot);
                if (resolved)
                    queue.push(resolved);
            }
            // Re-exports: export * from './foo', export { x } from './foo'
            if (ts.isExportDeclaration(node) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
                const resolved = resolveImportPath(node.moduleSpecifier.text, file, projectRoot);
                if (resolved)
                    queue.push(resolved);
            }
            // Dynamic imports: await import('./infra/foo')
            if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
                const arg = node.arguments[0];
                if (arg && ts.isStringLiteral(arg)) {
                    const resolved = resolveImportPath(arg.text, file, projectRoot);
                    if (resolved)
                        queue.push(resolved);
                }
            }
            // Walk deeper for dynamic imports inside functions
            walkForDynamicImports(node, file, projectRoot, queue);
        });
    }
    return [...visited];
}
function walkForDynamicImports(node, currentFile, projectRoot, queue) {
    ts.forEachChild(node, (child) => {
        if (ts.isCallExpression(child) &&
            child.expression.kind === ts.SyntaxKind.ImportKeyword &&
            child.arguments[0] &&
            ts.isStringLiteral(child.arguments[0])) {
            const resolved = resolveImportPath(child.arguments[0].text, currentFile, projectRoot);
            if (resolved)
                queue.push(resolved);
        }
        walkForDynamicImports(child, currentFile, projectRoot, queue);
    });
}
function resolveImportPath(specifier, fromFile, projectRoot) {
    // Only follow relative imports (not npm packages, not node_modules)
    if (!specifier.startsWith(".") && !specifier.startsWith("/"))
        return null;
    const base = specifier.startsWith("/")
        ? resolve(projectRoot, specifier)
        : resolve(dirname(fromFile), specifier);
    // Skip SST platform internals and node_modules
    if (base.includes("node_modules") || base.includes(".sst/platform"))
        return null;
    const extensions = [".ts", ".tsx", ".js", ".jsx"];
    // Try direct path
    for (const ext of extensions) {
        const candidate = base + ext;
        if (existsSync(candidate))
            return candidate;
    }
    // Try as directory with index
    for (const ext of extensions) {
        const candidate = resolve(base, "index" + ext);
        if (existsSync(candidate))
            return candidate;
    }
    // Try exact path (if it already has extension)
    if (existsSync(base))
        return base;
    return null;
}
/** Parse a single file for SST resource definitions. */
function parseFile(filePath, project, configVars, arrayVars) {
    const source = safeReadFile(filePath);
    if (!source)
        return;
    const sf = ts.createSourceFile(filePath, source, ts.ScriptTarget.ESNext, true);
    // Use project-wide variable-to-resource mapping
    const varToResource = project.varToResource;
    function visit(node) {
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
            const resource = {
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
        if (ts.isCallExpression(node) &&
            ts.isIdentifier(node.expression) &&
            node.arguments.length > 0 &&
            ts.isStringLiteral(node.arguments[0]) &&
            ts.isVariableDeclaration(node.parent) &&
            ts.isIdentifier(node.parent.name)) {
            const varName = node.parent.name.text;
            const firstArg = node.arguments[0];
            varToResource.set(varName, firstArg.text);
        }
        // Detect: api.route("GET /path", "handler.handler", { ... })
        if (ts.isCallExpression(node) &&
            ts.isPropertyAccessExpression(node.expression) &&
            node.expression.name.text === "route") {
            parseRouteCall(node, sf, filePath, project, varToResource);
        }
        // Detect: queue.subscribe({ handler: "...", link: [...] })
        if (ts.isCallExpression(node) &&
            ts.isPropertyAccessExpression(node.expression) &&
            node.expression.name.text === "subscribe") {
            parseSubscribeCall(node, sf, filePath, project, varToResource);
        }
        // Detect: addAuthRoute(api, { path: "...", handler: "..." }, ...)
        if (ts.isCallExpression(node) &&
            ts.isIdentifier(node.expression) &&
            node.expression.text === "addAuthRoute") {
            parseAddAuthRouteCall(node, sf, filePath, project, varToResource);
        }
        // Detect: const varName = { permissions: [...], link: [...], transform: {...} }
        // Captures config objects like envAndPermissions, crossAccountTransform
        if (ts.isVariableDeclaration(node) &&
            ts.isIdentifier(node.name) &&
            node.initializer &&
            ts.isObjectLiteralExpression(node.initializer)) {
            const varName = node.name.text;
            const config = extractConfigFromObject(node.initializer);
            if (config.permissions.length > 0 || config.links.length > 0 || config.spreadRefs.length > 0) {
                configVars.set(varName, config);
            }
        }
        // Detect: const allTables = [table1, table2, ...otherArray]
        // Captures array variables used in link: allLinkables
        if (ts.isVariableDeclaration(node) &&
            ts.isIdentifier(node.name) &&
            node.initializer &&
            ts.isArrayLiteralExpression(node.initializer)) {
            const varName = node.name.text;
            const elements = [];
            for (const el of node.initializer.elements) {
                if (ts.isIdentifier(el)) {
                    elements.push(el.text);
                }
                else if (ts.isSpreadElement(el) && ts.isIdentifier(el.expression)) {
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
/** Extract permissions, links, and spread refs from a plain object literal. */
function extractConfigFromObject(obj) {
    const result = {
        permissions: [],
        links: [],
        spreadRefs: [],
    };
    for (const prop of obj.properties) {
        if (ts.isSpreadAssignment(prop) && ts.isIdentifier(prop.expression)) {
            result.spreadRefs.push(prop.expression.text);
            continue;
        }
        if (!ts.isPropertyAssignment(prop) || !ts.isIdentifier(prop.name))
            continue;
        if (prop.name.text === "permissions") {
            result.permissions.push(...extractPermissions(prop.initializer));
        }
        if (prop.name.text === "link") {
            result.links.push(...extractLinkNames(prop.initializer));
        }
        // Recurse into nested objects like transform: { route: { handler: { ...envAndPermissions } } }
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
/**
 * Resolve spread references on resources using collected config variables.
 * e.g., ...crossAccountTransform -> extracts permissions from that variable.
 */
function resolveSpreadRefs(project, configVars) {
    // First resolve config vars that reference other config vars (one level deep)
    for (const [name, config] of configVars) {
        if ('spreadRefs' in config) {
            const refs = config.spreadRefs;
            for (const ref of refs) {
                const refConfig = configVars.get(ref);
                if (refConfig) {
                    config.permissions.push(...refConfig.permissions);
                    config.links.push(...refConfig.links);
                }
            }
        }
    }
    // Now resolve spreads on resources
    for (const resource of project.resources.values()) {
        if (!resource._spreadRefs)
            continue;
        for (const ref of resource._spreadRefs) {
            const config = configVars.get(ref);
            if (config) {
                resource.permissions.push(...config.permissions);
                resource.links.push(...config.links);
            }
        }
        delete resource._spreadRefs;
    }
    // Re-inherit: routes/subscribers created before spread resolution need updated parent data
    for (const resource of project.resources.values()) {
        if (resource.parentApi) {
            const parentApi = project.resources.get(resource.parentApi);
            if (parentApi) {
                // Add any parent permissions not already present
                for (const perm of parentApi.permissions) {
                    const already = resource.permissions.some((p) => JSON.stringify(p) === JSON.stringify(perm));
                    if (!already)
                        resource.permissions.push(perm);
                }
                // Add any parent links not already present
                for (const link of parentApi.links) {
                    if (!resource.links.includes(link))
                        resource.links.push(link);
                }
            }
        }
    }
}
/**
 * After all files are parsed, resolve link variable names to SST resource logical names.
 * e.g., link: [billingAccountTable] where billingAccountTable maps to SST name "ExternalBillingAccount"
 */
/**
 * Resolve array variable spreads: allLinkables = [...allTables, ...allQueues]
 * Expands spread references within array vars so each contains flat element lists.
 */
function resolveArrayVars(arrayVars) {
    // Multiple passes to handle nested spreads (allLinkables -> allTables -> individual vars)
    for (let i = 0; i < 3; i++) {
        for (const [name, elements] of arrayVars) {
            const expanded = [];
            for (const el of elements) {
                if (el.startsWith("...")) {
                    const refName = el.slice(3);
                    const refElements = arrayVars.get(refName);
                    if (refElements) {
                        expanded.push(...refElements);
                    }
                    else {
                        expanded.push(el); // Keep unresolved
                    }
                }
                else {
                    expanded.push(el);
                }
            }
            arrayVars.set(name, expanded);
        }
    }
}
/**
 * Expand link spread references (e.g., ...allLinkables) to individual resource variable names.
 */
function resolveAllLinkSpreads(project, arrayVars) {
    for (const resource of project.resources.values()) {
        const expanded = [];
        for (const link of resource.links) {
            if (link.startsWith("...")) {
                const arrayName = link.slice(3);
                const elements = arrayVars.get(arrayName);
                if (elements) {
                    expanded.push(...elements);
                }
                else {
                    expanded.push(link); // Keep unresolved
                }
            }
            else {
                expanded.push(link);
            }
        }
        resource.links = expanded;
    }
}
function resolveAllLinks(project) {
    for (const resource of project.resources.values()) {
        resource.links = resource.links.map((varName) => {
            // Skip spread references
            if (varName.startsWith("..."))
                return varName;
            // Try to resolve variable name to SST resource name
            const resourceName = project.varToResource.get(varName);
            if (resourceName)
                return resourceName;
            // Already a resource name
            return varName;
        });
    }
}
function parseResourceConfig(obj, resource, sf) {
    for (const prop of obj.properties) {
        // Handle spread properties: ...crossAccountTransform, ...envAndPermissions
        if (ts.isSpreadAssignment(prop)) {
            // We can't resolve the spread value statically, but we track it
            // so resolveAllSpreads can handle it later
            if (ts.isIdentifier(prop.expression)) {
                resource._spreadRefs = resource._spreadRefs ?? [];
                resource._spreadRefs.push(prop.expression.text);
            }
            continue;
        }
        if (!ts.isPropertyAssignment(prop) || !ts.isIdentifier(prop.name))
            continue;
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
/** Extract resource variable names from a link array: link: [table, bucket] */
function extractLinkNames(node) {
    const names = [];
    if (ts.isArrayLiteralExpression(node)) {
        for (const el of node.elements) {
            if (ts.isIdentifier(el)) {
                names.push(el.text);
            }
            else if (ts.isSpreadElement(el) && ts.isIdentifier(el.expression)) {
                // link: [...allTables] — we capture the spread variable name
                names.push(`...${el.expression.text}`);
            }
        }
    }
    else if (ts.isIdentifier(node)) {
        // link: allLinkables — single variable reference to an array
        names.push(`...${node.text}`);
    }
    return names;
}
/** Extract Permission objects from: permissions: [{ actions: [...], resources: [...] }] */
function extractPermissions(node) {
    const perms = [];
    if (!ts.isArrayLiteralExpression(node))
        return perms;
    for (const el of node.elements) {
        if (!ts.isObjectLiteralExpression(el))
            continue;
        const perm = { actions: [], resources: [] };
        for (const prop of el.properties) {
            if (!ts.isPropertyAssignment(prop) || !ts.isIdentifier(prop.name))
                continue;
            if (prop.name.text === "actions" && ts.isArrayLiteralExpression(prop.initializer)) {
                for (const actionEl of prop.initializer.elements) {
                    if (ts.isStringLiteral(actionEl))
                        perm.actions.push(actionEl.text);
                }
            }
            if (prop.name.text === "resources" && ts.isArrayLiteralExpression(prop.initializer)) {
                for (const resEl of prop.initializer.elements) {
                    if (ts.isStringLiteral(resEl))
                        perm.resources.push(resEl.text);
                }
            }
        }
        if (perm.actions.length > 0)
            perms.push(perm);
    }
    return perms;
}
/** Extract config from transform: { route: { handler: { permissions, link } } } */
function extractTransformConfig(node, resource) {
    if (!ts.isObjectLiteralExpression(node))
        return;
    for (const prop of node.properties) {
        if (!ts.isPropertyAssignment(prop) || !ts.isIdentifier(prop.name))
            continue;
        if (prop.name.text === "route" && ts.isObjectLiteralExpression(prop.initializer)) {
            for (const routeProp of prop.initializer.properties) {
                if (ts.isPropertyAssignment(routeProp) &&
                    ts.isIdentifier(routeProp.name) &&
                    routeProp.name.text === "handler" &&
                    ts.isObjectLiteralExpression(routeProp.initializer)) {
                    for (const handlerProp of routeProp.initializer.properties) {
                        if (!ts.isPropertyAssignment(handlerProp) || !ts.isIdentifier(handlerProp.name))
                            continue;
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
function parseRouteCall(node, sf, filePath, project, varToResource) {
    const args = node.arguments;
    if (args.length < 2)
        return;
    const pathArg = args[0];
    const handlerArg = args[1];
    const routePath = ts.isStringLiteral(pathArg) ? pathArg.text : null;
    const handler = ts.isStringLiteral(handlerArg) ? handlerArg.text : null;
    if (!routePath || !handler)
        return;
    // Determine parent API name
    let parentApiName = null;
    if (ts.isPropertyAccessExpression(node.expression) && ts.isIdentifier(node.expression.expression)) {
        const apiVarName = node.expression.expression.text;
        parentApiName = varToResource.get(apiVarName) ?? apiVarName;
    }
    const { line } = sf.getLineAndCharacterOfPosition(node.getStart(sf));
    const routeName = `${parentApiName ?? "api"}:${routePath}`;
    const resource = {
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
function parseSubscribeCall(node, sf, filePath, project, varToResource) {
    const args = node.arguments;
    if (args.length === 0)
        return;
    const configArg = args[0];
    if (!ts.isObjectLiteralExpression(configArg))
        return;
    // Determine parent queue name
    let parentQueueName = null;
    if (ts.isPropertyAccessExpression(node.expression) && ts.isIdentifier(node.expression.expression)) {
        const queueVarName = node.expression.expression.text;
        parentQueueName = varToResource.get(queueVarName) ?? queueVarName;
    }
    const { line } = sf.getLineAndCharacterOfPosition(node.getStart(sf));
    const resource = {
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
function parseAddAuthRouteCall(node, sf, filePath, project, varToResource) {
    const args = node.arguments;
    if (args.length < 2)
        return;
    // First arg is the API variable
    let parentApiName = null;
    if (ts.isIdentifier(args[0])) {
        parentApiName = varToResource.get(args[0].text) ?? args[0].text;
    }
    // Second arg is { path: "...", handler: "..." }
    const configArg = args[1];
    if (!ts.isObjectLiteralExpression(configArg))
        return;
    let routePath = null;
    let handler = null;
    for (const prop of configArg.properties) {
        if (!ts.isPropertyAssignment(prop) || !ts.isIdentifier(prop.name))
            continue;
        if (prop.name.text === "path" && ts.isStringLiteral(prop.initializer)) {
            routePath = prop.initializer.text;
        }
        if (prop.name.text === "handler" && ts.isStringLiteral(prop.initializer)) {
            handler = prop.initializer.text;
        }
    }
    if (!routePath || !handler)
        return;
    const { line } = sf.getLineAndCharacterOfPosition(node.getStart(sf));
    const routeName = `${parentApiName ?? "api"}:${routePath}`;
    const resource = {
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
function isSST(expr) {
    return getSST(expr) !== null;
}
function getSST(expr) {
    // sst.aws.Function -> PropertyAccessExpression
    if (ts.isPropertyAccessExpression(expr)) {
        const inner = expr.expression;
        // sst.aws.X
        if (ts.isPropertyAccessExpression(inner) &&
            ts.isIdentifier(inner.expression) &&
            inner.expression.text === "sst" &&
            ts.isIdentifier(inner.name) &&
            inner.name.text === "aws") {
            return `sst.aws.${expr.name.text}`;
        }
        // sst.X (e.g., sst.Secret, sst.Linkable)
        if (ts.isIdentifier(inner) && inner.text === "sst") {
            return `sst.${expr.name.text}`;
        }
    }
    return null;
}
function safeReadFile(filePath) {
    try {
        return readFileSync(filePath, "utf-8");
    }
    catch {
        return null;
    }
}
//# sourceMappingURL=parser.js.map