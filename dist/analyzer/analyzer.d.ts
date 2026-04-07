import type { SSTProject, FunctionAnalysis, Violation } from "../graph/types.js";
export interface AnalysisResult {
    functions: FunctionAnalysis[];
    violations: Violation[];
    project: SSTProject;
}
export interface AnalyzerOptions {
    filter?: string;
}
/** Run the full analysis pipeline on an SST project. */
export declare function analyze(project: SSTProject, options?: AnalyzerOptions): AnalysisResult;
