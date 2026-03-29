export function buildDirectoryReviewIndices(paths: string[]): Map<string, number>;
export function buildReviewTreePath(path: string, index: number, totalFiles: number, directoryReviewIndices: Map<string, number>): string;
export function compareReviewTreePaths(a: string, b: string): number;
export function createReviewTreePaths(paths: string[]): string[];
