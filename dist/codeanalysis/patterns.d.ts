/** Maps an SDK command or method to required IAM actions. */
export interface SDKPattern {
    service: string;
    commandName: string;
    requiredActions: string[];
    resourceType: string;
}
/** All known AWS SDK v3 command -> IAM action mappings. */
export declare const AWS_SDK_PATTERNS: SDKPattern[];
/** Look up an SDK pattern by command class name. */
export declare function lookupCommand(commandName: string): SDKPattern | undefined;
