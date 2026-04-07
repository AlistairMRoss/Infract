import type { SSTProject } from "./types.js";
/** Parse an SST project by reading sst.config.ts and following imports. */
export declare function parseSSTProject(projectRoot: string): SSTProject;
