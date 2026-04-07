import { SESClient, SendEmailCommand } from "@aws-sdk/client-ses";
import { S3Client, GetObjectCommand } from "@aws-sdk/client-s3";

const ses = new SESClient({});
const s3 = new S3Client({});

export async function handler(event: any) {
  // Get email template from S3
  const template = await s3.send(
    new GetObjectCommand({
      Bucket: "templates",
      Key: "welcome.html",
    })
  );

  // Send the email
  await ses.send(
    new SendEmailCommand({
      Source: "noreply@example.com",
      Destination: { ToAddresses: [event.email] },
      Message: {
        Subject: { Data: "Welcome!" },
        Body: { Html: { Data: "Hello" } },
      },
    })
  );

  return { statusCode: 200 };
}
