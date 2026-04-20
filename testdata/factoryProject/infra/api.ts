import {
  createLambdaRest,
  createLambdaNamed,
  createLambdaWithOverrides,
  createTableDecl,
} from "./helpers";

const AdminTable = new sst.aws.Dynamo("AdminTable", {
  fields: { id: "string" },
  primaryIndex: { hashKey: "id" },
});

createLambdaRest("AdminApi", {
  handler: "apis/admin/src/api.handler",
  link: [AdminTable],
});

createLambdaNamed("UserApi", {
  handler: "apis/user/src/api.handler",
  link: [AdminTable],
});

createLambdaWithOverrides("BillingApi", {
  handler: "apis/billing/src/api.handler",
  link: [AdminTable],
});

createTableDecl("UsageTable", {
  fields: { id: "string" },
  primaryIndex: { hashKey: "id" },
});

new sst.aws.Function("DirectFunction", {
  handler: "apis/direct/src/api.handler",
  link: [AdminTable],
});
