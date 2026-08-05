import { isAbsolute } from "node:path";

export type GateLeaf = {
  readonly workspace: string;
  readonly files: readonly string[];
  readonly env?: Readonly<Record<string, string>>;
};

export function reportedTestIdentity(leaf: GateLeaf, sourceName: unknown): string {
  if (typeof sourceName !== "string" || !isAbsolute(sourceName)) {
    throw new Error(`B2 gate leaf emitted an unrecognized test path for ${leaf.workspace}`);
  }
  const matches = leaf.files.filter((file) => sourceName.endsWith(`/${file}`));
  if (matches.length !== 1) {
    throw new Error(`B2 gate leaf emitted an unrecognized test path for ${leaf.workspace}`);
  }
  return `${leaf.workspace}:${normalizedConfiguredIdentity(matches[0]!)}`;
}

export function normalizedConfiguredIdentity(file: string): string {
  return file.replace(/^src\//, "");
}
