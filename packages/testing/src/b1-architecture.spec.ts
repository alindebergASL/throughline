import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const root = fileURLToPath(new URL("../../..", import.meta.url));

describe("Wave B1 architecture boundaries", () => {
  it("keeps migrations 0001-0003 byte-identical and adds only 0004-0006", async () => {
    const expected = {
      "0001_wave_a2_identity_access_rls.sql":
        "22b84fbeb36cfcfdd1f8270e6ffa03d819d5307c0aace86e69aa647d643b1ff7",
      "0002_foundation_closure_async_isolation.sql":
        "4264f0f760a74026bc0e0a6a38b98760e6061c76c9885848cf4236f13cda3ee2",
      "0003_b1_0_canonical_product_outbox.sql":
        "094303adaafbdc744c3c29fb1643ee3342d1e50bd7493491e96f84bd428fcc63"
    } as const;
    const files = (await readdir(join(root, "packages/db/migrations"))).sort();
    expect(files).toEqual([
      ...Object.keys(expected),
      "0004_b1_work_graph.sql",
      "0005_b1_content_sources.sql",
      "0006_b1_command_integrity.sql"
    ]);
    for (const [file, digest] of Object.entries(expected)) {
      const bytes = await readFile(join(root, "packages/db/migrations", file));
      expect(createHash("sha256").update(bytes).digest("hex"), file).toBe(digest);
    }
  });

  it("uses the canonical outbox and contains no duplicate ledger or out-of-scope domain", async () => {
    const sources = await combined([
      "packages/account-operations/src",
      "packages/work-graph/src",
      "packages/content/src",
      "apps/api/src/b1-account-operations",
      "packages/db/migrations/0004_b1_work_graph.sql",
      "packages/db/migrations/0005_b1_content_sources.sql",
      "packages/db/migrations/0006_b1_command_integrity.sql"
    ]);
    expect(sources).toContain("ops.product_outbox_events");
    expect(sources).not.toMatch(/CREATE TABLE\s+ops\.domain_events/i);
    expect(sources).not.toMatch(/\b(?:Claim|AcceptedFact|DerivedView|ChangeSet|AgentRun)\b/);
    expect(sources).not.toMatch(/@throughline\/(?:integrations|agent-runtime|truth-ledger|search)/);
    expect(sources).not.toMatch(/OpenAI|model\.generate|MCP|Kanban|event-source mapping/i);
    const productionCommandSurfaces = await combined([
      "packages/db/migrations/0006_b1_command_integrity.sql",
      "packages/account-operations/src/domain-command-bus.ts",
      "packages/authorization/src/authorization-service.ts",
      "packages/db/src/product-domain-repositories.ts"
    ]);
    expect(productionCommandSurfaces).not.toContain("b1_0.fixture.v1");
  });

  it("keeps routes SQL-free and every mutation behind the typed command facade", async () => {
    const controller = await source(
      "apps/api/src/b1-account-operations/b1-account-operations.controller.ts"
    );
    const runtime = await source(
      "apps/api/src/b1-account-operations/b1-account-operations.runtime.ts"
    );
    expect(controller).not.toMatch(/\b(?:SELECT|INSERT|UPDATE|DELETE)\b/);
    expect(controller.match(/this\.runtime\.execute/g)).toHaveLength(4);
    expect(runtime).not.toMatch(/INSERT INTO|UPDATE\s+(?:work|content|ops)\./);
    for (const route of [
      'Post("organizations")',
      'Get("organizations")',
      'Get("organizations/:organizationId")',
      'Post("initiatives")',
      'Get("initiatives/:initiativeId")',
      'Post("activities")',
      'Get("activities/:activityId")',
      'Post("activities/:activityId/sources")',
      'Get("activities/:activityId/sources")',
      'Get("sources/:sourceArtifactId")'
    ])
      expect(controller).toContain(route);
  });

  it("keeps Engagement as an Activity subtype and exposes no engagement aggregate", async () => {
    const workMigration = await source("packages/db/migrations/0004_b1_work_graph.sql");
    const workTypes = await source("packages/work-graph/src/work-graph.ts");
    expect(workMigration).toContain("CHECK (subtype = profile_template_key)");
    expect(workMigration).not.toMatch(/CREATE TABLE work\.engagements/i);
    expect(workTypes).not.toMatch(/interface Engagement\b/);
  });

  it("uses only the fixed Activity source lock seam in capture and correction order", async () => {
    const repository = await source("packages/work-graph/src/repository.ts");
    const commandBus = await source("packages/account-operations/src/domain-command-bus.ts");
    const getActivity = repository.slice(
      repository.indexOf("async getActivity("),
      repository.indexOf("async lockActivityForSourceCapture(")
    );
    expect(getActivity).not.toMatch(/lock\s*[=:]|FOR (?:UPDATE|SHARE)|\$\{.*lock/);
    const fixedLock = repository.slice(
      repository.indexOf("async lockActivityForSourceCapture("),
      repository.indexOf("private async projectActivity(")
    );
    expect(fixedLock).toContain("governingSpaceId: string");
    expect(fixedLock).toContain("activityId: string");
    expect(fixedLock).toContain("FOR SHARE OF activity");
    expect(fixedLock).not.toMatch(/options|lock\s*[=:]|\$\{/);
    expect(commandBus.match(/graph\.lockActivityForSourceCapture\(/g)).toHaveLength(2);

    const capture = commandBus.slice(
      commandBus.indexOf('case "source.capture": {'),
      commandBus.indexOf('case "source.correct": {')
    );
    const captureLock = capture.indexOf("lockActivityForSourceCapture");
    const captureAuthorization = capture.indexOf('"source.capture",', captureLock);
    expect(captureLock).toBeLessThan(captureAuthorization);
    expect(captureAuthorization).toBeGreaterThan(-1);
    expect(capture).toContain("requestedAccessClass: command.payload.requestedAccessClass");

    const correction = commandBus.slice(
      commandBus.indexOf('case "source.correct": {'),
      commandBus.indexOf('case "source.tombstone": {')
    );
    expect(correction.indexOf('this.authorize(tx, context, "source.read"')).toBeLessThan(
      correction.indexOf("resolveSourceActivityLinkForCorrection")
    );
    expect(correction.indexOf('this.authorize(tx, context, "source.correct"')).toBeLessThan(
      correction.indexOf("resolveSourceActivityLinkForCorrection")
    );
    expect(correction.indexOf("resolveSourceActivityLinkForCorrection")).toBeLessThan(
      correction.indexOf("lockActivityForSourceCapture")
    );
    expect(correction.indexOf("lockActivityForSourceCapture")).toBeLessThan(
      correction.indexOf("lockCurrentSourceForCorrection")
    );
    expect(correction.indexOf("lockCurrentSourceForCorrection")).toBeLessThan(
      correction.indexOf("revalidateSourceActivityLinkForCorrection")
    );
    expect(correction.match(/this\.authorize\(tx, context, "source\.read"/g)).toHaveLength(2);
    expect(correction.match(/this\.authorize\(tx, context, "source\.correct"/g)).toHaveLength(2);
    expect(correction.indexOf("revalidateSourceActivityLinkForCorrection")).toBeLessThan(
      correction.lastIndexOf('this.authorize(tx, context, "source.read"')
    );
    expect(correction.lastIndexOf('this.authorize(tx, context, "source.read"')).toBeLessThan(
      correction.lastIndexOf('this.authorize(tx, context, "source.correct"')
    );

    const tombstone = commandBus.slice(
      commandBus.indexOf('case "source.tombstone": {'),
      commandBus.indexOf("private async authorize(")
    );
    expect(tombstone.match(/this\.authorize\(tx, context, "source\.read"/g)).toHaveLength(2);
    expect(tombstone.match(/this\.authorize\(tx, context, "source\.tombstone"/g)).toHaveLength(2);
    expect(tombstone.indexOf('this.authorize(tx, context, "source.read"')).toBeLessThan(
      tombstone.indexOf("content.lockSource(")
    );
    expect(tombstone.indexOf('this.authorize(tx, context, "source.tombstone"')).toBeLessThan(
      tombstone.indexOf("content.lockSource(")
    );
    expect(tombstone.indexOf("content.lockSource(")).toBeLessThan(
      tombstone.lastIndexOf('this.authorize(tx, context, "source.read"')
    );
    expect(tombstone.lastIndexOf('this.authorize(tx, context, "source.read"')).toBeLessThan(
      tombstone.lastIndexOf('this.authorize(tx, context, "source.tombstone"')
    );
  });

  it("routes Source reservations through the minimal Source scope query only", async () => {
    const repository = await source("packages/content/src/repository.ts");
    const commandBus = await source("packages/account-operations/src/domain-command-bus.ts");
    const reservation = commandBus.slice(
      commandBus.indexOf("private async resolveReservationSpace("),
      commandBus.indexOf("private async executeInTransaction(")
    );
    expect(reservation.match(/getSourceScope\(/g)).toHaveLength(2);
    expect(reservation).not.toMatch(/getSource\(/);

    const sourceScope = repository.slice(
      repository.indexOf("async getSourceScope("),
      repository.indexOf("async getContentItemScope(")
    );
    expect(sourceScope).toContain("SELECT id, space_id");
    expect(sourceScope).not.toMatch(
      /JOIN|source_chunks|activity_sources|immutable_text|title|content_hash|access_class|deleted_at|deletion_reason|hash_disposition|supersedes_source_id|\bversion\b/i
    );
  });

  it("routes Relationship end by minimal scope and batches authority locks after protected materialization", async () => {
    const repository = await source("packages/work-graph/src/repository.ts");
    const commandBus = await source("packages/account-operations/src/domain-command-bus.ts");
    const reservation = commandBus.slice(
      commandBus.indexOf("private async resolveReservationSpace("),
      commandBus.indexOf("private async executeInTransaction(")
    );
    const relationshipReservation = reservation.slice(
      reservation.indexOf('case "relationship.end"'),
      reservation.indexOf('case "content.create"')
    );
    expect(relationshipReservation).toContain("getRelationshipScope(");
    expect(relationshipReservation).not.toContain("getRelationship(");

    const relationshipScope = repository.slice(
      repository.indexOf("async getRelationshipScope("),
      repository.indexOf("async getRelationship(")
    );
    expect(relationshipScope).toContain("SELECT id, space_id");
    expect(relationshipScope).not.toMatch(
      /subject_type|subject_id|predicate|object_type|object_id|context_type|context_id|valid_from|valid_to|\bversion\b/i
    );

    const ending = commandBus.slice(
      commandBus.indexOf('case "relationship.end": {'),
      commandBus.indexOf('case "content.create": {')
    );
    const initialAuthorization = ending.indexOf("preauthorizeRelationshipEndInTransaction(");
    const commandReservation = ending.indexOf("reserveCommand(");
    const relationshipLock = ending.indexOf("graph.getRelationship(");
    const globalAuthorityLock = ending.indexOf(
      "lockAndReauthorizeRelationshipAuthorityInTransaction("
    );
    expect(initialAuthorization).toBeGreaterThan(-1);
    expect(commandReservation).toBeGreaterThan(initialAuthorization);
    expect(initialAuthorization).toBeLessThan(relationshipLock);
    expect(ending.slice(0, relationshipLock)).not.toContain("lockAuthority: true");
    expect(globalAuthorityLock).toBeGreaterThan(relationshipLock);
    expect(globalAuthorityLock).toBeLessThan(ending.indexOf("graph.endRelationship("));
    expect(ending).not.toContain("authorizeRelationshipEndpoints(");
  });

  it("limits raw scope switching to the fixed transaction helper", async () => {
    const production = await combined(["packages", "apps"]);
    const matches = [...production.matchAll(/set_config\('app\.space_id'/g)];
    expect(matches.length).toBeGreaterThanOrEqual(2);
    const accountOperations = await combined([
      "packages/account-operations/src",
      "apps/api/src/b1-account-operations"
    ]);
    expect(accountOperations).not.toMatch(/set_config|app\.space_id/);
    const transaction = await source("packages/db/src/transaction.ts");
    expect(transaction).toContain("withCreatedChildSpaceScope");
    expect(transaction).toContain("ChildCreationDbTransaction");
  });
});

async function source(relative: string): Promise<string> {
  return readFile(join(root, relative), "utf8");
}

async function combined(paths: string[]): Promise<string> {
  const files = (await Promise.all(paths.map((path) => collect(join(root, path))))).flat();
  return (await Promise.all(files.map((file) => readFile(file, "utf8")))).join("\n");
}

async function collect(path: string): Promise<string[]> {
  const stat = await import("node:fs/promises").then(({ stat }) => stat(path));
  if (stat.isFile()) return [path];
  const entries = await readdir(path, { withFileTypes: true });
  return (
    await Promise.all(
      entries.map((entry) => {
        const child = join(path, entry.name);
        if (entry.isDirectory()) return collect(child);
        return /\.(?:ts|tsx|sql)$/.test(entry.name) ? [child] : [];
      })
    )
  ).flat();
}
