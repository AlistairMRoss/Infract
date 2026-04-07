/**
 * Check if an IAM action pattern matches a specific action.
 * Supports wildcards: "s3:*" matches "s3:GetObject".
 */
export declare function matchAction(pattern: string, action: string): boolean;
