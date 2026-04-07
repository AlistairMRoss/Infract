/**
 * Check if an IAM action pattern matches a specific action.
 * Supports wildcards: "s3:*" matches "s3:GetObject".
 */
export function matchAction(pattern, action) {
    if (pattern === "*" || pattern === action)
        return true;
    const [patternService, patternAction] = pattern.split(":", 2);
    const [actionService, actionAction] = action.split(":", 2);
    if (!patternAction || !actionAction)
        return false;
    if (patternService !== actionService)
        return false;
    if (patternAction === "*")
        return true;
    if (patternAction.endsWith("*")) {
        return actionAction.startsWith(patternAction.slice(0, -1));
    }
    return patternAction.toLowerCase() === actionAction.toLowerCase();
}
//# sourceMappingURL=policy.js.map