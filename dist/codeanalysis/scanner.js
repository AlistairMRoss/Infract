import ts from "typescript";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { lookupCommand } from "./patterns.js";
/** Scan a compute resource's source code for AWS SDK calls and Resource.X references. */
export function scanFunction(projectRoot, resource) {
    const filePath = resolveHandlerPath(projectRoot, resource.handler);
    if (!filePath)
        return { sdkCalls: [], resourceRefs: [] };
    return scanFile(filePath);
}
/** Resolve a Lambda handler reference to an actual file path. */
function resolveHandlerPath(root, handler) {
    if (!handler)
        return null;
    // Strip the export name after the last dot: "src/email.handler" -> "src/email"
    const lastDot = handler.lastIndexOf(".");
    const modulePath = lastDot !== -1 ? handler.slice(0, lastDot) : handler;
    const extensions = [".ts", ".tsx", ".js", ".jsx", ".mts", ".mjs"];
    for (const ext of extensions) {
        const candidate = resolve(root, modulePath + ext);
        if (existsSync(candidate))
            return candidate;
    }
    // Try as directory with index file
    for (const ext of extensions) {
        const candidate = resolve(root, modulePath, "index" + ext);
        if (existsSync(candidate))
            return candidate;
    }
    return null;
}
/** Scan a single file using the TypeScript compiler API. */
function scanFile(filePath) {
    const program = ts.createProgram([filePath], {
        target: ts.ScriptTarget.ESNext,
        module: ts.ModuleKind.ESNext,
        moduleResolution: ts.ModuleResolutionKind.Bundler,
        allowJs: true,
        noEmit: true,
        skipLibCheck: true,
    });
    const sourceFile = program.getSourceFile(filePath);
    if (!sourceFile)
        return { sdkCalls: [], resourceRefs: [] };
    const sdkCalls = [];
    const resourceRefs = [];
    // Track which command names are imported from AWS SDK packages
    const importedCommands = new Set();
    // First pass: collect AWS SDK imports
    ts.forEachChild(sourceFile, (node) => {
        if (ts.isImportDeclaration(node)) {
            const moduleSpecifier = node.moduleSpecifier;
            if (ts.isStringLiteral(moduleSpecifier)) {
                const pkg = moduleSpecifier.text;
                if (pkg.startsWith("@aws-sdk/")) {
                    const clause = node.importClause;
                    if (clause?.namedBindings && ts.isNamedImports(clause.namedBindings)) {
                        for (const specifier of clause.namedBindings.elements) {
                            const name = specifier.name.text;
                            if (lookupCommand(name)) {
                                importedCommands.add(name);
                            }
                        }
                    }
                }
            }
        }
    });
    // Second pass: find SDK calls and Resource.X references
    function visit(node) {
        // Detect: new XxxCommand(...)
        if (ts.isNewExpression(node) && ts.isIdentifier(node.expression)) {
            const commandName = node.expression.text;
            if (importedCommands.has(commandName)) {
                const pattern = lookupCommand(commandName);
                if (pattern) {
                    const { line } = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
                    for (const action of pattern.requiredActions) {
                        sdkCalls.push({
                            service: pattern.service,
                            method: commandName,
                            action,
                            filePath,
                            lineNumber: line + 1,
                        });
                    }
                }
            }
        }
        // Detect: Resource.MyTable.name, Resource.MyBucket.url, etc.
        if (ts.isPropertyAccessExpression(node) &&
            ts.isPropertyAccessExpression(node.expression) &&
            ts.isIdentifier(node.expression.expression) &&
            node.expression.expression.text === "Resource") {
            const resourceName = node.expression.name.text;
            const property = node.name.text;
            const { line } = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
            resourceRefs.push({
                resourceName,
                property,
                filePath,
                lineNumber: line + 1,
            });
        }
        ts.forEachChild(node, visit);
    }
    ts.forEachChild(sourceFile, visit);
    return {
        sdkCalls: deduplicateCalls(sdkCalls),
        resourceRefs: deduplicateRefs(resourceRefs),
    };
}
function deduplicateCalls(calls) {
    const seen = new Set();
    return calls.filter((call) => {
        const key = `${call.action}|${call.filePath}|${call.lineNumber}`;
        if (seen.has(key))
            return false;
        seen.add(key);
        return true;
    });
}
function deduplicateRefs(refs) {
    const seen = new Set();
    return refs.filter((ref) => {
        const key = `${ref.resourceName}|${ref.filePath}|${ref.lineNumber}`;
        if (seen.has(key))
            return false;
        seen.add(key);
        return true;
    });
}
export { resolveHandlerPath as _resolveHandlerPath };
//# sourceMappingURL=scanner.js.map