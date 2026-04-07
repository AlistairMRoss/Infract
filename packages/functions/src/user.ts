import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { GetCommand, QueryCommand } from "@aws-sdk/lib-dynamodb";
import { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";

const client = DynamoDBDocumentClient.from(new DynamoDBClient({}));

export async function handler(event: any) {
  const userId = event.pathParameters.id;

  const result = await client.send(
    new GetCommand({
      TableName: "users",
      Key: { id: userId },
    })
  );

  return {
    statusCode: 200,
    body: JSON.stringify(result.Item),
  };
}
