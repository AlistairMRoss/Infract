export const SharedSecret = new sst.Secret("SharedSecret");

export const createLambdaRest = (
  ...args: ConstructorParameters<typeof sst.aws.Function>
) => {
  new sst.aws.Function(args[0], {
    ...args[1],
  });
};

export const createLambdaNamed = (
  name: string,
  config: Parameters<typeof sst.aws.Function>[1],
) => {
  new sst.aws.Function(name, config);
};

export const createLambdaWithOverrides = (
  name: string,
  config: Parameters<typeof sst.aws.Function>[1],
) => {
  new sst.aws.Function(name, {
    ...config,
    link: [SharedSecret],
    permissions: [{ actions: ["s3:PutObject"], resources: ["*"] }],
  });
};

export function createTableDecl(name: string, config: any) {
  new sst.aws.Dynamo(name, config);
}
