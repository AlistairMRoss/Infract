import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";

const s3 = new S3Client({});

export async function handler(event: any) {
  const body = JSON.parse(event.body);

  await s3.send(
    new PutObjectCommand({
      Bucket: process.env.BUCKET_NAME,
      Key: `uploads/${Date.now()}.json`,
      Body: JSON.stringify(body),
    })
  );

  return { statusCode: 200, body: "Uploaded" };
}
