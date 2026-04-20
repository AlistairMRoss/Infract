/// <reference path="./.sst/platform/config.d.ts" />

export default {
  app() {
    return { name: "factory-test", home: "aws" };
  },
  async run() {
    await import("./infra/api");
  },
};
