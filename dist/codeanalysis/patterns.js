/** All known AWS SDK v3 command -> IAM action mappings. */
export const AWS_SDK_PATTERNS = [
    // SES
    { service: "ses", commandName: "SendEmailCommand", requiredActions: ["ses:SendEmail"], resourceType: "SES" },
    { service: "ses", commandName: "SendRawEmailCommand", requiredActions: ["ses:SendRawEmail"], resourceType: "SES" },
    { service: "ses", commandName: "SendBulkEmailCommand", requiredActions: ["ses:SendBulkEmail"], resourceType: "SES" },
    { service: "ses", commandName: "SendTemplatedEmailCommand", requiredActions: ["ses:SendTemplatedEmail"], resourceType: "SES" },
    // S3
    { service: "s3", commandName: "GetObjectCommand", requiredActions: ["s3:GetObject"], resourceType: "S3" },
    { service: "s3", commandName: "PutObjectCommand", requiredActions: ["s3:PutObject"], resourceType: "S3" },
    { service: "s3", commandName: "DeleteObjectCommand", requiredActions: ["s3:DeleteObject"], resourceType: "S3" },
    { service: "s3", commandName: "ListObjectsV2Command", requiredActions: ["s3:ListBucket"], resourceType: "S3" },
    { service: "s3", commandName: "ListObjectsCommand", requiredActions: ["s3:ListBucket"], resourceType: "S3" },
    { service: "s3", commandName: "HeadObjectCommand", requiredActions: ["s3:GetObject"], resourceType: "S3" },
    { service: "s3", commandName: "CopyObjectCommand", requiredActions: ["s3:GetObject", "s3:PutObject"], resourceType: "S3" },
    { service: "s3", commandName: "DeleteObjectsCommand", requiredActions: ["s3:DeleteObject"], resourceType: "S3" },
    { service: "s3", commandName: "CreateMultipartUploadCommand", requiredActions: ["s3:PutObject"], resourceType: "S3" },
    // DynamoDB (standard client)
    { service: "dynamodb", commandName: "GetItemCommand", requiredActions: ["dynamodb:GetItem"], resourceType: "DynamoDB" },
    { service: "dynamodb", commandName: "PutItemCommand", requiredActions: ["dynamodb:PutItem"], resourceType: "DynamoDB" },
    { service: "dynamodb", commandName: "UpdateItemCommand", requiredActions: ["dynamodb:UpdateItem"], resourceType: "DynamoDB" },
    { service: "dynamodb", commandName: "DeleteItemCommand", requiredActions: ["dynamodb:DeleteItem"], resourceType: "DynamoDB" },
    { service: "dynamodb", commandName: "QueryCommand", requiredActions: ["dynamodb:Query"], resourceType: "DynamoDB" },
    { service: "dynamodb", commandName: "ScanCommand", requiredActions: ["dynamodb:Scan"], resourceType: "DynamoDB" },
    { service: "dynamodb", commandName: "BatchGetItemCommand", requiredActions: ["dynamodb:BatchGetItem"], resourceType: "DynamoDB" },
    { service: "dynamodb", commandName: "BatchWriteItemCommand", requiredActions: ["dynamodb:BatchWriteItem"], resourceType: "DynamoDB" },
    { service: "dynamodb", commandName: "TransactGetItemsCommand", requiredActions: ["dynamodb:GetItem"], resourceType: "DynamoDB" },
    { service: "dynamodb", commandName: "TransactWriteItemsCommand", requiredActions: ["dynamodb:PutItem", "dynamodb:UpdateItem", "dynamodb:DeleteItem"], resourceType: "DynamoDB" },
    // DynamoDB (lib-dynamodb simplified commands)
    { service: "dynamodb", commandName: "GetCommand", requiredActions: ["dynamodb:GetItem"], resourceType: "DynamoDB" },
    { service: "dynamodb", commandName: "PutCommand", requiredActions: ["dynamodb:PutItem"], resourceType: "DynamoDB" },
    { service: "dynamodb", commandName: "UpdateCommand", requiredActions: ["dynamodb:UpdateItem"], resourceType: "DynamoDB" },
    { service: "dynamodb", commandName: "DeleteCommand", requiredActions: ["dynamodb:DeleteItem"], resourceType: "DynamoDB" },
    { service: "dynamodb", commandName: "BatchGetCommand", requiredActions: ["dynamodb:BatchGetItem"], resourceType: "DynamoDB" },
    { service: "dynamodb", commandName: "BatchWriteCommand", requiredActions: ["dynamodb:BatchWriteItem"], resourceType: "DynamoDB" },
    { service: "dynamodb", commandName: "TransactGetCommand", requiredActions: ["dynamodb:GetItem"], resourceType: "DynamoDB" },
    { service: "dynamodb", commandName: "TransactWriteCommand", requiredActions: ["dynamodb:PutItem", "dynamodb:UpdateItem", "dynamodb:DeleteItem"], resourceType: "DynamoDB" },
    // SQS
    { service: "sqs", commandName: "SendMessageCommand", requiredActions: ["sqs:SendMessage"], resourceType: "SQS" },
    { service: "sqs", commandName: "ReceiveMessageCommand", requiredActions: ["sqs:ReceiveMessage"], resourceType: "SQS" },
    { service: "sqs", commandName: "DeleteMessageCommand", requiredActions: ["sqs:DeleteMessage"], resourceType: "SQS" },
    { service: "sqs", commandName: "SendMessageBatchCommand", requiredActions: ["sqs:SendMessage"], resourceType: "SQS" },
    // SNS
    { service: "sns", commandName: "PublishCommand", requiredActions: ["sns:Publish"], resourceType: "SNS" },
    { service: "sns", commandName: "SubscribeCommand", requiredActions: ["sns:Subscribe"], resourceType: "SNS" },
    // EventBridge
    { service: "eventbridge", commandName: "PutEventsCommand", requiredActions: ["events:PutEvents"], resourceType: "EventBridge" },
    // Secrets Manager
    { service: "secretsmanager", commandName: "GetSecretValueCommand", requiredActions: ["secretsmanager:GetSecretValue"], resourceType: "SecretsManager" },
    { service: "secretsmanager", commandName: "PutSecretValueCommand", requiredActions: ["secretsmanager:PutSecretValue"], resourceType: "SecretsManager" },
    // SSM Parameter Store
    { service: "ssm", commandName: "GetParameterCommand", requiredActions: ["ssm:GetParameter"], resourceType: "SSM" },
    { service: "ssm", commandName: "PutParameterCommand", requiredActions: ["ssm:PutParameter"], resourceType: "SSM" },
    { service: "ssm", commandName: "GetParametersByPathCommand", requiredActions: ["ssm:GetParametersByPath"], resourceType: "SSM" },
];
/** Build a lookup map from command name to pattern. */
const commandMap = new Map();
for (const p of AWS_SDK_PATTERNS) {
    commandMap.set(p.commandName, p);
}
/** Look up an SDK pattern by command class name. */
export function lookupCommand(commandName) {
    return commandMap.get(commandName);
}
//# sourceMappingURL=patterns.js.map