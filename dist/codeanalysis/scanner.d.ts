import type { SDKCall, SSTResource, ResourceRef } from "../graph/types.js";
export interface ScanResult {
    sdkCalls: SDKCall[];
    resourceRefs: ResourceRef[];
}
/** Scan a compute resource's source code for AWS SDK calls and Resource.X references.
 *  Follows local imports recursively to find SDK calls in service/lib modules. */
export declare function scanFunction(projectRoot: string, resource: SSTResource): ScanResult;
/** Resolve a Lambda handler reference to an actual file path. */
declare function resolveHandlerPath(root: string, handler: string | null): string | null;
export { resolveHandlerPath as _resolveHandlerPath };
