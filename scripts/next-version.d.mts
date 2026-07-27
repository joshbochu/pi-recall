export function parseSemver(version: string): { major: number; minor: number; patch: number };
export function compareSemver(left: string, right: string): number;
export function bumpPatch(version: string): string;
export function chooseNextVersion(localVersion: string, publishedVersion: string | null): string;
export function readPublishedVersion(name: string): string | null;
