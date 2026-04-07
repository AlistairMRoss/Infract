/** Human-friendly category for an SST resource type. */
export function resourceCategory(type) {
    switch (type) {
        case "Function": return "Lambda function";
        case "ApiGatewayV2": return "API Gateway";
        case "ApiRoute": return "API route";
        case "Dynamo": return "DynamoDB table";
        case "Bucket": return "S3 bucket";
        case "Queue": return "SQS queue";
        case "QueueSubscriber": return "Queue subscriber";
        case "Secret": return "Secret";
        case "Linkable": return "Linkable";
        default: return type;
    }
}
/** Get all compute resources (functions, route handlers, queue subscribers). */
export function getComputeResources(project) {
    return [...project.resources.values()].filter((r) => r.type === "Function" || r.type === "ApiRoute" || r.type === "QueueSubscriber");
}
/** Map SST resource type to a service category for matching against SDK calls. */
export function resourceTypeToServiceCategory(type) {
    switch (type) {
        case "Dynamo": return "DynamoDB";
        case "Bucket": return "S3";
        case "Queue": return "SQS";
        default: return null;
    }
}
//# sourceMappingURL=types.js.map