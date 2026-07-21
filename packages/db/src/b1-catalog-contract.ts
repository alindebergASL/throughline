import { randomUUID } from "node:crypto";
import type { PgPoolClient } from "./client.js";

export const B1_MIGRATION_IDS = [
  "0004_b1_work_graph.sql",
  "0005_b1_content_sources.sql",
  "0006_b1_command_integrity.sql"
] as const;

type B1MigrationId = (typeof B1_MIGRATION_IDS)[number];
type MigrationSources = ReadonlyMap<string, string>;

const B1_PREDECESSOR_IDS = [
  "0001_wave_a2_identity_access_rls.sql",
  "0002_foundation_closure_async_isolation.sql",
  "0003_b1_0_canonical_product_outbox.sql"
] as const;

export async function validateMigrationJournal(
  client: PgPoolClient,
  checksums: ReadonlyMap<string, string>
): Promise<Map<string, string>> {
  const rows = await client.query<{ id: string; checksum: string; applied_at: Date }>(
    "SELECT id, checksum, applied_at FROM throughline_migrations.journal ORDER BY id"
  );
  const migrationIds = [...checksums.keys()].sort();
  for (const row of rows.rows) {
    const expected = checksums.get(row.id);
    if (!expected) throw new Error(`Unexpected migration journal id ${row.id}`);
    if (row.checksum !== expected) throw new Error(`Migration checksum mismatch for ${row.id}`);
  }

  const expectedJournalPrefix = migrationIds.slice(0, rows.rows.length);
  if (rows.rows.some((row, index) => row.id !== expectedJournalPrefix[index])) {
    throw new Error(
      "Migration journal is not an exact contiguous prefix of the known migration catalog"
    );
  }
  const chronologicalJournalIds = [...rows.rows]
    .sort(
      (left, right) =>
        left.applied_at.getTime() - right.applied_at.getTime() || left.id.localeCompare(right.id)
    )
    .map((row) => row.id);
  if (chronologicalJournalIds.some((id, index) => id !== expectedJournalPrefix[index])) {
    throw new Error("Migration journal order does not match the fixed migration order");
  }

  const b1Rows = rows.rows.filter((row) => B1_MIGRATION_IDS.includes(row.id as B1MigrationId));
  const expectedB1Prefix = B1_MIGRATION_IDS.slice(0, b1Rows.length);
  if (b1Rows.some((row, index) => row.id !== expectedB1Prefix[index])) {
    throw new Error("B1 migration journal is not an exact contiguous prefix");
  }
  const chronologicalB1Ids = [...b1Rows]
    .sort(
      (left, right) =>
        left.applied_at.getTime() - right.applied_at.getTime() || left.id.localeCompare(right.id)
    )
    .map((row) => row.id);
  if (chronologicalB1Ids.some((id, index) => id !== expectedB1Prefix[index])) {
    throw new Error("B1 migration journal order does not match the fixed migration order");
  }

  const structure = await client.query<Record<string, unknown>>(
    `SELECT relation_record.relkind::text AS kind,
            relation_record.relpersistence::text AS persistence,
            relation_record.relrowsecurity AS rls,
            relation_record.relforcerowsecurity AS forced_rls,
            pg_get_userbyid(relation_record.relowner) = current_user AS owned_by_migrator,
            ARRAY(
              SELECT format('%s:%s:%s',
                CASE WHEN acl_record.grantee = 0 THEN 'PUBLIC'
                     ELSE pg_get_userbyid(acl_record.grantee) END,
                acl_record.privilege_type, acl_record.is_grantable)
              FROM aclexplode(COALESCE(
                relation_record.relacl, acldefault('r', relation_record.relowner)
              )) acl_record
              WHERE acl_record.grantee <> relation_record.relowner ORDER BY 1
            ) AS privileges
     FROM pg_class relation_record
     WHERE relation_record.oid = 'throughline_migrations.journal'::regclass`
  );
  assertCatalogEqual("migration journal table security", structure.rows, [
    {
      kind: "r",
      persistence: "p",
      rls: false,
      forced_rls: false,
      owned_by_migrator: true,
      privileges: []
    }
  ]);

  const columns = await client.query<Record<string, unknown>>(
    `SELECT attribute_record.attnum AS ordinal, attribute_record.attname AS name,
            format_type(attribute_record.atttypid, attribute_record.atttypmod) AS type,
            attribute_record.attnotnull AS not_null,
            attribute_record.attidentity::text AS identity,
            attribute_record.attgenerated::text AS generated,
            pg_get_expr(default_record.adbin, default_record.adrelid) AS default_expression
     FROM pg_attribute attribute_record
     LEFT JOIN pg_attrdef default_record ON default_record.adrelid = attribute_record.attrelid
       AND default_record.adnum = attribute_record.attnum
     WHERE attribute_record.attrelid = 'throughline_migrations.journal'::regclass
       AND attribute_record.attnum > 0 AND NOT attribute_record.attisdropped
     ORDER BY attribute_record.attnum`
  );
  assertCatalogEqual("migration journal columns", columns.rows, [
    {
      ordinal: 1,
      name: "id",
      type: "text",
      not_null: true,
      identity: "",
      generated: "",
      default_expression: null
    },
    {
      ordinal: 2,
      name: "checksum",
      type: "text",
      not_null: true,
      identity: "",
      generated: "",
      default_expression: null
    },
    {
      ordinal: 3,
      name: "applied_at",
      type: "timestamp with time zone",
      not_null: true,
      identity: "",
      generated: "",
      default_expression: "clock_timestamp()"
    }
  ]);
  const constraints = await client.query<Record<string, unknown>>(
    `SELECT constraint_record.contype::text AS type,
            pg_get_constraintdef(constraint_record.oid, false) AS definition,
            constraint_record.condeferrable AS deferrable,
            constraint_record.condeferred AS initially_deferred,
            constraint_record.convalidated AS validated
     FROM pg_constraint constraint_record
     WHERE constraint_record.conrelid = 'throughline_migrations.journal'::regclass
     ORDER BY 1, 2`
  );
  assertCatalogEqual("migration journal constraints", constraints.rows, [
    {
      type: "c",
      definition: "CHECK ((length(checksum) = 64))",
      deferrable: false,
      initially_deferred: false,
      validated: true
    },
    {
      type: "p",
      definition: "PRIMARY KEY (id)",
      deferrable: false,
      initially_deferred: false,
      validated: true
    }
  ]);
  const schema = await client.query<Record<string, unknown>>(
    `SELECT pg_get_userbyid(namespace_record.nspowner) = current_user AS owned_by_migrator,
            ARRAY(
              SELECT format('%s:%s:%s',
                CASE WHEN acl_record.grantee = 0 THEN 'PUBLIC'
                     ELSE pg_get_userbyid(acl_record.grantee) END,
                acl_record.privilege_type, acl_record.is_grantable)
              FROM aclexplode(COALESCE(
                namespace_record.nspacl, acldefault('n', namespace_record.nspowner)
              )) acl_record
              WHERE acl_record.grantee <> namespace_record.nspowner ORDER BY 1
            ) AS privileges
     FROM pg_namespace namespace_record
     WHERE namespace_record.nspname = 'throughline_migrations'`
  );
  assertCatalogEqual("migration journal schema security", schema.rows, [
    {
      owned_by_migrator: true,
      privileges: []
    }
  ]);
  const indexes = await client.query<Record<string, unknown>>(
    `SELECT index_state.indisprimary AS primary, index_state.indisunique AS unique,
            index_state.indisvalid AS valid, index_state.indisready AS ready,
            pg_get_indexdef(index_state.indexrelid, 1, false) AS first_attribute
     FROM pg_index index_state
     WHERE index_state.indrelid = 'throughline_migrations.journal'::regclass`
  );
  assertCatalogEqual("migration journal indexes", indexes.rows, [
    {
      primary: true,
      unique: true,
      valid: true,
      ready: true,
      first_attribute: "id"
    }
  ]);
  const extras = await client.query(
    `SELECT 1 FROM pg_class relation_record
       JOIN pg_namespace namespace_record ON namespace_record.oid = relation_record.relnamespace
       WHERE namespace_record.nspname = 'throughline_migrations'
         AND relation_record.relname <> 'journal'
         AND relation_record.relkind <> 'i'
     UNION ALL SELECT 1 FROM pg_trigger
       WHERE tgrelid = 'throughline_migrations.journal'::regclass AND NOT tgisinternal
     UNION ALL SELECT 1 FROM pg_policy
       WHERE polrelid = 'throughline_migrations.journal'::regclass
     UNION ALL SELECT 1 FROM pg_rewrite
       WHERE ev_class = 'throughline_migrations.journal'::regclass AND rulename <> '_RETURN'`
  );
  if (extras.rowCount !== 0) throw new Error("Unexpected migration journal catalog object");
  return new Map(rows.rows.map((row) => [row.id, row.checksum]));
}

function deriveB1CatalogPhase(journal: ReadonlyMap<string, string>): number {
  if (B1_PREDECESSOR_IDS.some((id) => !journal.has(id))) {
    throw new Error("B1 migration journal is missing a fixed predecessor");
  }
  const journaledB1Ids = B1_MIGRATION_IDS.filter((id) => journal.has(id));
  const expectedPrefix = B1_MIGRATION_IDS.slice(0, journaledB1Ids.length);
  if (journaledB1Ids.some((id, index) => id !== expectedPrefix[index])) {
    throw new Error("B1 migration journal is not an exact contiguous prefix");
  }
  return journaledB1Ids.length;
}

interface ExpectedTable {
  actualName: string;
  scratchName: string;
  migrationId: B1MigrationId;
}

interface ExpectedIndex {
  actualName: string;
  scratchName: string;
  tableName: string;
}

interface ExpectedTrigger {
  name: string;
  tableName: string;
  scratchTableName: string;
  statement: string;
}

interface ScratchCatalog {
  schemaName: string;
}

const workTables = [
  "work.organizations",
  "work.organization_domains",
  "work.initiatives",
  "work.initiative_organizations",
  "work.initiative_people",
  "work.activities",
  "work.activity_organizations",
  "work.activity_initiatives",
  "work.activity_attendees",
  "work.relationships"
] as const;

const contentTables = [
  "content.content_items",
  "content.content_revisions",
  "content.source_artifacts",
  "content.source_chunks",
  "work.activity_sources"
] as const;

const integrityReadTables = new Set([
  "work.organizations",
  "work.initiatives",
  "work.activities",
  "work.relationships",
  "work.activity_sources",
  "content.content_items",
  "content.source_artifacts",
  "content.source_chunks"
]);

const protectedRoles = [
  "throughline_app",
  "throughline_relay",
  "throughline_worker",
  "throughline_product_relay",
  "throughline_b1_0_integrity"
] as const;

const functionContracts = [
  ["work", "canonical_domain", "text", "boolean", "sql", "i", true, false],
  ["work", "require_one_primary_organization", "", "trigger", "plpgsql", "v", false, false],
  ["work", "require_activity_governing_association", "", "trigger", "plpgsql", "v", false, false],
  [
    "work",
    "resolve_relationship_endpoint",
    "text, uuid, uuid, uuid",
    "record",
    "plpgsql",
    "s",
    false,
    false
  ],
  ["work", "validate_relationship_scope", "", "trigger", "plpgsql", "v", false, false],
  ["work", "reject_append_only_mutation", "", "trigger", "plpgsql", "v", false, false],
  ["work", "enforce_historical_association_end", "", "trigger", "plpgsql", "v", false, false],
  ["content", "reject_immutable_row_mutation", "", "trigger", "plpgsql", "v", false, false],
  ["content", "validate_content_revision_insert", "", "trigger", "plpgsql", "v", false, false],
  ["content", "access_class_rank", "text", "integer", "sql", "i", false, false],
  ["content", "validate_content_item_access_class", "", "trigger", "plpgsql", "v", false, false],
  ["content", "validate_content_item_revision_update", "", "trigger", "plpgsql", "v", false, false],
  ["content", "require_current_revision", "", "trigger", "plpgsql", "v", false, false],
  ["content", "validate_source_insert_or_correction", "", "trigger", "plpgsql", "v", false, false],
  ["content", "enforce_source_tombstone_transition", "", "trigger", "plpgsql", "v", false, false],
  ["content", "validate_source_chunk", "", "trigger", "plpgsql", "v", false, false],
  ["content", "allow_chunk_delete_after_tombstone", "", "trigger", "plpgsql", "v", false, false],
  ["content", "require_source_chunk_reconstruction", "", "trigger", "plpgsql", "v", false, false],
  ["ops", "enforce_domain_command_transition", "", "trigger", "plpgsql", "v", false, false],
  ["ops", "reject_committed_reserved_command", "", "trigger", "plpgsql", "v", false, true],
  [
    "ops",
    "b1_command_record_valid",
    "text, integer, text, text, uuid, jsonb",
    "boolean",
    "plpgsql",
    "i",
    false,
    false
  ],
  ["ops", "require_b1_command_atomicity", "", "trigger", "plpgsql", "v", false, true]
] as const;

export async function assertB1MigrationStateAbsent(
  client: PgPoolClient,
  migrationId: B1MigrationId
): Promise<void> {
  const result = await client.query<{ installed: boolean }>(
    migrationId === B1_MIGRATION_IDS[0]
      ? `SELECT to_regnamespace('work') IS NOT NULL AS installed`
      : migrationId === B1_MIGRATION_IDS[1]
        ? `SELECT to_regnamespace('content') IS NOT NULL
             OR to_regclass('work.activity_sources') IS NOT NULL AS installed`
        : `SELECT to_regprocedure(
               'ops.b1_command_record_valid(text,integer,text,text,uuid,jsonb)'
             ) IS NOT NULL
             OR to_regprocedure('ops.require_b1_command_atomicity()') IS NOT NULL
             OR EXISTS (
               SELECT 1 FROM pg_constraint
               WHERE conrelid = to_regclass('ops.domain_command_records')
                 AND conname = 'domain_command_records_b1_shape_check'
             )
             OR EXISTS (
               SELECT 1 FROM pg_trigger
               WHERE tgrelid = to_regclass('ops.domain_command_records')
                 AND tgname = 'domain_command_records_b1_atomicity_deferred'
             )
             OR EXISTS (
               SELECT 1 FROM pg_policy
               WHERE polname LIKE '%\\_b1\\_integrity\\_select' ESCAPE '\\'
             )
             OR EXISTS (
               SELECT 1 FROM pg_namespace namespace_record
               CROSS JOIN LATERAL aclexplode(COALESCE(
                 namespace_record.nspacl, acldefault('n', namespace_record.nspowner)
               )) acl_record
               WHERE acl_record.grantee = 'throughline_b1_0_integrity'::regrole
                 AND namespace_record.nspname <> 'ops'
             )
             OR EXISTS (
               SELECT 1 FROM pg_class relation_record
               CROSS JOIN LATERAL aclexplode(COALESCE(
                 relation_record.relacl, acldefault('r', relation_record.relowner)
               )) acl_record
               WHERE acl_record.grantee = 'throughline_b1_0_integrity'::regrole
             ) AS installed`
  );
  if (result.rows[0]?.installed) {
    throw new Error(`Unjournaled existing state for ${migrationId}`);
  }
}

export async function validateB1CatalogContract(
  client: PgPoolClient,
  journal: ReadonlyMap<string, string>,
  sources: MigrationSources
): Promise<void> {
  const phase = deriveB1CatalogPhase(journal);
  const installed = B1_MIGRATION_IDS.slice(0, phase);
  if (installed.length === 0) {
    try {
      for (const migrationId of B1_MIGRATION_IDS) {
        await assertB1MigrationStateAbsent(client, migrationId);
      }
    } catch (error) {
      throw new Error("Installed B1 catalog does not match pre-0004 B1 state absence", {
        cause: error
      });
    }
    return;
  }
  const integrityInstalled = phase === B1_MIGRATION_IDS.length;
  const expectedTables = expectedTableContracts(installed, sources);
  const expectedIndexes = expectedIndexContracts(installed, sources, expectedTables);
  const expectedTriggers = expectedTriggerContracts(installed, sources, expectedTables);

  await validateProtectedRoles(client);
  await withScratchCatalog(client, async (scratch) => {
    await createScratchTables(client, scratch, expectedTables, sources);
    await createScratchIndexes(client, scratch, expectedIndexes, sources, expectedTables);
    await createScratchTriggers(client, scratch, expectedTriggers);
    await createScratchPolicies(client, scratch, expectedTables, integrityInstalled);

    for (const table of expectedTables) {
      await validateTable(client, scratch, expectedTables, table);
      await validateIndexes(
        client,
        scratch,
        expectedTables,
        table,
        expectedIndexes.filter((index) => index.tableName === table.actualName)
      );
      await validateTriggers(
        client,
        scratch,
        expectedTables,
        table,
        expectedTriggers.filter((trigger) => trigger.tableName === table.actualName)
      );
      await validatePolicies(client, scratch, expectedTables, table);
      await validateTablePrivileges(client, table.actualName, integrityInstalled);
    }

    await validateSchemaSecurity(
      client,
      scratch,
      expectedTables,
      expectedIndexes,
      integrityInstalled
    );
    await validateFunctions(client, installed, sources);
    if (integrityInstalled) {
      await validateCommandIntegrityObjects(
        client,
        scratch,
        sources.get(B1_PREDECESSOR_IDS[2])!,
        sources.get(B1_MIGRATION_IDS[2])!
      );
    }
  });
  await validateIntegrityPredecessorAccess(client, integrityInstalled);
}

function expectedTableContracts(
  installed: readonly B1MigrationId[],
  sources: MigrationSources
): ExpectedTable[] {
  const tables: ExpectedTable[] = [];
  for (const migrationId of installed.filter((id) => id !== B1_MIGRATION_IDS[2])) {
    const source = requireSource(sources, migrationId);
    for (const { tableName } of extractCreateTableStatements(source)) {
      tables.push({
        actualName: tableName,
        scratchName: scratchTableName(tableName),
        migrationId
      });
    }
  }
  const expectedNames = [
    ...(installed.includes(B1_MIGRATION_IDS[0]) ? workTables : []),
    ...(installed.includes(B1_MIGRATION_IDS[1]) ? contentTables : [])
  ].sort();
  if (
    tables
      .map(({ actualName }) => actualName)
      .sort()
      .join("|") !== expectedNames.join("|")
  ) {
    throw new Error("B1 migration table contract parser did not cover the fixed table inventory");
  }
  return tables.sort((left, right) => left.actualName.localeCompare(right.actualName));
}

function expectedIndexContracts(
  installed: readonly B1MigrationId[],
  sources: MigrationSources,
  tables: readonly ExpectedTable[]
): ExpectedIndex[] {
  const tableNames = new Set(tables.map(({ actualName }) => actualName));
  return installed
    .filter((id) => id !== B1_MIGRATION_IDS[2])
    .flatMap((id) => extractIndexStatements(requireSource(sources, id)))
    .filter(({ tableName }) => tableNames.has(tableName))
    .map(({ indexName, tableName }, index) => ({
      actualName: indexName,
      scratchName: `b1_contract_index_${index}`,
      tableName
    }));
}

function expectedTriggerContracts(
  installed: readonly B1MigrationId[],
  sources: MigrationSources,
  tables: readonly ExpectedTable[]
): ExpectedTrigger[] {
  const tableMap = new Map(tables.map((table) => [table.actualName, table.scratchName]));
  return installed
    .filter((id) => id !== B1_MIGRATION_IDS[2])
    .flatMap((id) => extractTriggerStatements(requireSource(sources, id)))
    .filter(({ tableName }) => tableMap.has(tableName))
    .map(({ name, tableName, statement }) => ({
      name,
      tableName,
      scratchTableName: tableMap.get(tableName)!,
      statement
    }));
}

function requireSource(sources: MigrationSources, migrationId: string): string {
  const source = sources.get(migrationId);
  if (!source) throw new Error(`Missing fixed catalog source for ${migrationId}`);
  return source;
}

function scratchTableName(tableName: string): string {
  return `b1_contract_${tableName.replace(".", "_")}`;
}

function quoteIdentifier(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}

function scratchRelation(scratch: ScratchCatalog, name: string): string {
  return `${quoteIdentifier(scratch.schemaName)}.${quoteIdentifier(name)}`;
}

async function withScratchCatalog(
  client: PgPoolClient,
  validate: (scratch: ScratchCatalog) => Promise<void>
): Promise<void> {
  const suffix = randomUUID().replaceAll("-", "");
  const scratch = { schemaName: `b1_contract_${suffix}` };
  const savepointName = `b1_contract_savepoint_${suffix}`;
  const quotedSavepoint = quoteIdentifier(savepointName);

  await client.query(`SAVEPOINT ${quotedSavepoint}`);
  try {
    // Ordinary tables may reference both permanent predecessors and each other; temporary tables
    // cannot legally preserve that foreign-key graph in PostgreSQL.
    await client.query(`CREATE SCHEMA ${quoteIdentifier(scratch.schemaName)}`);
    await validate(scratch);
    await client.query(`DROP SCHEMA ${quoteIdentifier(scratch.schemaName)} CASCADE`);
    await client.query(`RELEASE SAVEPOINT ${quotedSavepoint}`);
  } catch (error) {
    await client.query(`ROLLBACK TO SAVEPOINT ${quotedSavepoint}`);
    await client.query(`RELEASE SAVEPOINT ${quotedSavepoint}`);
    throw error;
  }
}

function extractCreateTableStatements(
  source: string
): Array<{ tableName: string; statement: string }> {
  const contracts: Array<{ tableName: string; statement: string }> = [];
  const matcher = /CREATE TABLE ((?:work|content)\.[a-z_]+)\s*\(/g;
  for (let match = matcher.exec(source); match; match = matcher.exec(source)) {
    let depth = 0;
    let quoted = false;
    let end = -1;
    for (let index = source.indexOf("(", match.index); index < source.length; index += 1) {
      const character = source[index]!;
      if (character === "'" && source[index - 1] !== "\\") quoted = !quoted;
      if (quoted) continue;
      if (character === "(") depth += 1;
      if (character === ")") {
        depth -= 1;
        if (depth === 0) {
          end = source.indexOf(";", index);
          break;
        }
      }
    }
    if (end < 0) throw new Error(`Unterminated CREATE TABLE contract for ${match[1]}`);
    contracts.push({ tableName: match[1]!, statement: source.slice(match.index, end + 1) });
    matcher.lastIndex = end + 1;
  }
  return contracts;
}

function extractIndexStatements(source: string): Array<{
  indexName: string;
  tableName: string;
  statement: string;
}> {
  return [
    ...source.matchAll(
      /CREATE (?:UNIQUE )?INDEX ([a-z_]+)\s+ON ((?:work|content)\.[a-z_]+)[\s\S]*?;/g
    )
  ].map((match) => ({ indexName: match[1]!, tableName: match[2]!, statement: match[0] }));
}

function extractTriggerStatements(source: string): Array<{
  name: string;
  tableName: string;
  statement: string;
}> {
  return [
    ...source.matchAll(
      /CREATE (?:CONSTRAINT )?TRIGGER ([a-z_]+)[\s\S]*?\bON ((?:work|content)\.[a-z_]+)[\s\S]*?;/g
    )
  ].map((match) => ({ name: match[1]!, tableName: match[2]!, statement: match[0] }));
}

function rewriteB1TableRelations(
  statement: string,
  scratch: ScratchCatalog,
  tables: readonly ExpectedTable[]
): string {
  let rewritten = statement;
  for (const table of [...tables].sort(
    (left, right) => right.actualName.length - left.actualName.length
  )) {
    rewritten = rewritten.replaceAll(table.actualName, scratchRelation(scratch, table.scratchName));
  }
  return rewritten;
}

async function createScratchTables(
  client: PgPoolClient,
  scratch: ScratchCatalog,
  tables: readonly ExpectedTable[],
  sources: MigrationSources
): Promise<void> {
  const tableMigrationIds = B1_MIGRATION_IDS.slice(0, 2).filter((migrationId) =>
    tables.some((table) => table.migrationId === migrationId)
  );
  const sourceTables = new Map(
    tableMigrationIds.flatMap((id) =>
      extractCreateTableStatements(requireSource(sources, id)).map(
        (table) => [table.tableName, table.statement] as const
      )
    )
  );
  const tableMap = new Map(tables.map((table) => [table.actualName, table]));
  let constructedTableCount = 0;
  for (const [actualName, statement] of sourceTables) {
    const table = tableMap.get(actualName);
    if (!table) continue;
    await client.query(rewriteB1TableRelations(statement, scratch, tables));
    constructedTableCount += 1;
    await client.query(
      `ALTER TABLE ${scratchRelation(scratch, table.scratchName)} ENABLE ROW LEVEL SECURITY`
    );
    await client.query(
      `ALTER TABLE ${scratchRelation(scratch, table.scratchName)} FORCE ROW LEVEL SECURITY`
    );
  }
  if (constructedTableCount !== tables.length) {
    throw new Error("B1 scratch catalog did not construct the fixed table inventory");
  }
}

async function createScratchIndexes(
  client: PgPoolClient,
  scratch: ScratchCatalog,
  indexes: readonly ExpectedIndex[],
  sources: MigrationSources,
  tables: readonly ExpectedTable[]
): Promise<void> {
  const tableMigrationIds = B1_MIGRATION_IDS.slice(0, 2).filter((migrationId) =>
    tables.some((table) => table.migrationId === migrationId)
  );
  const statements = new Map(
    tableMigrationIds.flatMap((id) =>
      extractIndexStatements(requireSource(sources, id)).map(
        (index) => [index.indexName, index.statement] as const
      )
    )
  );
  const tableMap = new Map(tables.map((table) => [table.actualName, table.scratchName]));
  for (const index of indexes) {
    const statement = statements.get(index.actualName);
    const scratchTable = tableMap.get(index.tableName);
    if (!statement || !scratchTable)
      throw new Error(`Missing index statement for ${index.actualName}`);
    await client.query(
      statement
        .replace(`INDEX ${index.actualName}`, `INDEX ${quoteIdentifier(index.scratchName)}`)
        .replace(`ON ${index.tableName}`, `ON ${scratchRelation(scratch, scratchTable)}`)
    );
  }
}

async function createScratchTriggers(
  client: PgPoolClient,
  scratch: ScratchCatalog,
  triggers: readonly ExpectedTrigger[]
): Promise<void> {
  for (const trigger of triggers) {
    await client.query(
      trigger.statement.replace(
        `ON ${trigger.tableName}`,
        `ON ${scratchRelation(scratch, trigger.scratchTableName)}`
      )
    );
  }
}

async function createScratchPolicies(
  client: PgPoolClient,
  scratch: ScratchCatalog,
  tables: readonly ExpectedTable[],
  integrityInstalled: boolean
): Promise<void> {
  for (const table of tables) {
    const relation = scratchRelation(scratch, table.scratchName);
    const baseName = table.actualName.split(".")[1]!;
    await client.query(`CREATE POLICY ${quoteIdentifier(`${baseName}_app_select`)} ON ${relation}
      FOR SELECT TO throughline_app USING (
        tenant_id = ops.current_tenant_id() AND workspace_id = ops.current_workspace_id()
      )`);
    await client.query(`CREATE POLICY ${quoteIdentifier(`${baseName}_app_insert`)} ON ${relation}
      FOR INSERT TO throughline_app WITH CHECK (
        tenant_id = ops.current_tenant_id() AND workspace_id = ops.current_workspace_id()
        AND space_id = ops.current_space_id()
      )`);
    if (integrityInstalled && integrityReadTables.has(table.actualName)) {
      await client.query(`CREATE POLICY ${quoteIdentifier(`${baseName}_b1_integrity_select`)}
        ON ${relation} FOR SELECT TO throughline_b1_0_integrity USING (true)`);
    }
    if (table.actualName === "work.relationships") {
      await client.query(`CREATE POLICY relationships_app_update ON ${relation}
        FOR UPDATE TO throughline_app
        USING (tenant_id = ops.current_tenant_id() AND workspace_id = ops.current_workspace_id()
          AND space_id = ops.current_space_id())
        WITH CHECK (tenant_id = ops.current_tenant_id() AND workspace_id = ops.current_workspace_id()
          AND space_id = ops.current_space_id())`);
    }
    if (table.actualName === "work.activities") {
      await client.query(`CREATE POLICY activities_app_source_capture_lock ON ${relation}
        AS PERMISSIVE FOR UPDATE TO throughline_app
        USING (tenant_id = ops.current_tenant_id() AND workspace_id = ops.current_workspace_id()
          AND space_id = ops.current_space_id()
          AND status IN ('planned', 'in_progress', 'captured', 'review_pending', 'completed')
          AND EXISTS (SELECT 1 FROM access.spaces governing_space
            WHERE governing_space.tenant_id = ${quoteIdentifier(table.scratchName)}.tenant_id
              AND governing_space.workspace_id = ${quoteIdentifier(table.scratchName)}.workspace_id
              AND governing_space.id = ${quoteIdentifier(table.scratchName)}.space_id
              AND governing_space.archived_at IS NULL)) WITH CHECK (false)`);
      await client.query(`CREATE POLICY activities_app_permanent_no_write ON ${relation}
        AS RESTRICTIVE FOR UPDATE TO throughline_app USING (true) WITH CHECK (false)`);
    }
    if (table.actualName === "content.content_items") {
      await client.query(`CREATE POLICY content_items_app_update ON ${relation}
        FOR UPDATE TO throughline_app
        USING (tenant_id = ops.current_tenant_id() AND workspace_id = ops.current_workspace_id()
          AND space_id = ops.current_space_id())
        WITH CHECK (tenant_id = ops.current_tenant_id() AND workspace_id = ops.current_workspace_id()
          AND space_id = ops.current_space_id())`);
    }
    if (table.actualName === "content.source_artifacts") {
      await client.query(`CREATE POLICY source_artifacts_app_tombstone ON ${relation}
        FOR UPDATE TO throughline_app
        USING (tenant_id = ops.current_tenant_id() AND workspace_id = ops.current_workspace_id()
          AND space_id = ops.current_space_id())
        WITH CHECK (tenant_id = ops.current_tenant_id() AND workspace_id = ops.current_workspace_id()
          AND space_id = ops.current_space_id())`);
    }
    if (table.actualName === "content.source_chunks") {
      await client.query(`CREATE POLICY source_chunks_app_tombstone_delete ON ${relation}
        FOR DELETE TO throughline_app
        USING (tenant_id = ops.current_tenant_id() AND workspace_id = ops.current_workspace_id()
          AND space_id = ops.current_space_id())`);
    }
  }
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(value);
}

function assertCatalogEqual(label: string, actual: unknown, expected: unknown): void {
  if (canonicalJson(actual) !== canonicalJson(expected)) {
    throw new Error(`Installed B1 catalog does not match ${label}`);
  }
}

function compareRelationInventoryRows(
  left: { name: string; kind: string },
  right: { name: string; kind: string }
): number {
  if (left.name !== right.name) return left.name < right.name ? -1 : 1;
  if (left.kind !== right.kind) return left.kind < right.kind ? -1 : 1;
  return 0;
}

function relationTokens(tableName: string): string[] {
  const names = tableName.split(".");
  const baseName = names[names.length - 1]!;
  return [tableName, `"${tableName.replace(".", '"."')}"`, baseName, `"${baseName}"`];
}

interface RelationAlias {
  canonicalName: string;
  names: string[];
}

function b1RelationAliases(
  scratch: ScratchCatalog,
  tables: readonly ExpectedTable[]
): RelationAlias[] {
  // Normalize object spelling only. Each relation keeps a distinct token so an FK rewritten to a
  // different B1 table, schema, or predecessor still fails the structural comparison.
  return tables.map((table, index) => ({
    canonicalName: `__B1_RELATION_${index}__`,
    names: [
      ...relationTokens(table.actualName),
      ...relationTokens(`${scratch.schemaName}.${table.scratchName}`)
    ]
  }));
}

function normalizeRelationText(
  value: unknown,
  tableName: string,
  aliases: readonly RelationAlias[] = []
): unknown {
  if (typeof value !== "string") return value;
  let normalized = value;
  const replacements =
    aliases.length === 0
      ? relationTokens(tableName).map((name) => ({ name, canonicalName: "$TABLE" }))
      : aliases.flatMap((alias) =>
          alias.names.map((name) => ({ name, canonicalName: alias.canonicalName }))
        );
  for (const replacement of replacements.sort(
    (left, right) => right.name.length - left.name.length
  )) {
    normalized = normalized.replaceAll(replacement.name, replacement.canonicalName);
  }
  return normalized.replaceAll(/\s+/g, " ").trim();
}

function normalizeRows(
  rows: Array<Record<string, unknown>>,
  tableName: string,
  aliases: readonly RelationAlias[] = []
): Array<Record<string, unknown>> {
  const expressionKeys = new Set([
    "definition",
    "default_expression",
    "expressions",
    "predicate",
    "condition",
    "referenced_relation",
    "using_expression",
    "check_expression"
  ]);
  return rows.map((row) =>
    Object.fromEntries(
      Object.entries(row).map(([key, value]) => [
        key,
        expressionKeys.has(key) ? normalizeRelationText(value, tableName, aliases) : value
      ])
    )
  );
}

async function validateTable(
  client: PgPoolClient,
  scratch: ScratchCatalog,
  tables: readonly ExpectedTable[],
  table: ExpectedTable
): Promise<void> {
  const metadata = async (relation: string) =>
    (
      await client.query<Record<string, unknown>>(
        `SELECT relation_record.relkind::text AS kind,
                relation_record.relpersistence::text AS persistence,
                relation_record.relrowsecurity AS rls,
                relation_record.relforcerowsecurity AS forced_rls,
                relation_record.relreplident::text AS replica_identity,
                relation_record.relispartition AS is_partition,
                relation_record.reloptions AS options,
                access_method.amname AS access_method,
                CASE WHEN relation_record.reltablespace = 0 THEN NULL
                  ELSE relation_record.reltablespace::regclass::text END AS tablespace,
                pg_get_userbyid(relation_record.relowner) AS owner
         FROM pg_class relation_record
         LEFT JOIN pg_am access_method ON access_method.oid = relation_record.relam
         WHERE relation_record.oid = $1::regclass`,
        [relation]
      )
    ).rows;
  const columns = async (relation: string) =>
    (
      await client.query<Record<string, unknown>>(
        `SELECT attribute_record.attnum AS ordinal,
                attribute_record.attname AS name,
                format_type(attribute_record.atttypid, attribute_record.atttypmod) AS type,
                attribute_record.attnotnull AS not_null,
                attribute_record.attidentity::text AS identity,
                attribute_record.attgenerated::text AS generated,
                attribute_record.attstorage::text AS storage,
                attribute_record.attcompression::text AS compression,
                CASE WHEN attribute_record.attcollation = 0 THEN NULL
                  ELSE attribute_record.attcollation::regcollation::text END AS collation,
                pg_get_expr(default_record.adbin, default_record.adrelid) AS default_expression
         FROM pg_attribute attribute_record
         LEFT JOIN pg_attrdef default_record
           ON default_record.adrelid = attribute_record.attrelid
          AND default_record.adnum = attribute_record.attnum
         WHERE attribute_record.attrelid = $1::regclass
           AND attribute_record.attnum > 0 AND NOT attribute_record.attisdropped
         ORDER BY attribute_record.attnum`,
        [relation]
      )
    ).rows;
  const constraints = async (relation: string) =>
    (
      await client.query<Record<string, unknown>>(
        `SELECT constraint_record.contype::text AS type,
                pg_get_constraintdef(constraint_record.oid, false) AS definition,
                CASE WHEN constraint_record.contype = 'f'
                  THEN referenced_namespace.nspname || '.' || referenced_relation.relname
                  ELSE NULL END AS referenced_relation,
                constraint_record.conkey::smallint[] AS constrained_columns,
                constraint_record.confkey::smallint[] AS referenced_columns,
                constraint_record.confupdtype::text AS update_action,
                constraint_record.confdeltype::text AS delete_action,
                constraint_record.confmatchtype::text AS match_type,
                constraint_record.condeferrable AS deferrable,
                constraint_record.condeferred AS initially_deferred,
                constraint_record.convalidated AS validated,
                constraint_record.connoinherit AS no_inherit
         FROM pg_constraint constraint_record
         LEFT JOIN pg_class referenced_relation
           ON referenced_relation.oid = constraint_record.confrelid
         LEFT JOIN pg_namespace referenced_namespace
           ON referenced_namespace.oid = referenced_relation.relnamespace
         WHERE constraint_record.conrelid = $1::regclass
         ORDER BY 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12`,
        [relation]
      )
    ).rows;

  const scratchTable = scratchRelation(scratch, table.scratchName);
  const aliases = b1RelationAliases(scratch, tables);
  const actualMetadata = await metadata(table.actualName);
  const expectedMetadata = await metadata(scratchTable);
  if (actualMetadata.length !== 1 || expectedMetadata.length !== 1) {
    throw new Error(`Missing B1 table ${table.actualName}`);
  }
  assertCatalogEqual(
    `${table.actualName} table security and ownership`,
    actualMetadata,
    expectedMetadata
  );
  assertCatalogEqual(
    `${table.actualName} columns`,
    normalizeRows(await columns(table.actualName), table.actualName, aliases),
    normalizeRows(await columns(scratchTable), table.scratchName, aliases)
  );
  assertCatalogEqual(
    `${table.actualName} constraints`,
    normalizeRows(await constraints(table.actualName), table.actualName, aliases),
    normalizeRows(await constraints(scratchTable), table.scratchName, aliases)
  );

  const rules = await client.query(
    `SELECT 1 FROM pg_rewrite WHERE ev_class = $1::regclass AND rulename <> '_RETURN'`,
    [table.actualName]
  );
  if (rules.rowCount !== 0) throw new Error(`Unexpected rewrite rule on ${table.actualName}`);
}

async function indexCatalog(
  client: PgPoolClient,
  relation: string
): Promise<Array<Record<string, unknown>>> {
  return (
    await client.query<Record<string, unknown>>(
      `SELECT index_record.relname AS name,
              index_state.indisunique AS is_unique,
              index_state.indisprimary AS is_primary,
              index_state.indisexclusion AS is_exclusion,
              index_state.indisvalid AS is_valid,
              index_state.indisready AS is_ready,
              index_state.indislive AS is_live,
              access_method.amname AS access_method,
              index_state.indnkeyatts AS key_attribute_count,
              index_state.indnatts AS attribute_count,
              pg_get_expr(index_state.indexprs, index_state.indrelid) AS expressions,
              pg_get_expr(index_state.indpred, index_state.indrelid) AS predicate,
              ARRAY(SELECT pg_get_indexdef(index_state.indexrelid, position, false)
                    FROM generate_series(1, index_state.indnatts) position) AS attributes,
              ARRAY(SELECT operator_class.oid::regclass::text
                    FROM unnest(index_state.indclass::oid[]) operator_class(oid)) AS operator_classes,
              index_state.indoption::smallint[] AS options
       FROM pg_index index_state
       JOIN pg_class index_record ON index_record.oid = index_state.indexrelid
       JOIN pg_am access_method ON access_method.oid = index_record.relam
       LEFT JOIN pg_constraint constraint_record ON constraint_record.conindid = index_state.indexrelid
       WHERE index_state.indrelid = $1::regclass AND constraint_record.oid IS NULL
       ORDER BY index_record.relname`,
      [relation]
    )
  ).rows;
}

async function validateIndexes(
  client: PgPoolClient,
  scratch: ScratchCatalog,
  tables: readonly ExpectedTable[],
  table: ExpectedTable,
  expectedIndexes: readonly ExpectedIndex[]
): Promise<void> {
  const actual = await indexCatalog(client, table.actualName);
  const expected = await indexCatalog(client, scratchRelation(scratch, table.scratchName));
  const aliases = b1RelationAliases(scratch, tables);
  const expectedNames = expectedIndexes.map((index) => index.actualName).sort();
  assertCatalogEqual(
    `${table.actualName} index names`,
    actual.map((row) => row.name),
    expectedNames
  );
  const actualWithoutNames = actual.map(omitCatalogName);
  const expectedByName = new Map(
    expectedIndexes.map((index) => [index.scratchName, index.actualName])
  );
  const expectedWithoutNames = expected
    .sort((left, right) =>
      expectedByName.get(String(left.name))!.localeCompare(expectedByName.get(String(right.name))!)
    )
    .map(omitCatalogName);
  assertCatalogEqual(
    `${table.actualName} indexes`,
    normalizeRows(actualWithoutNames, table.actualName, aliases),
    normalizeRows(expectedWithoutNames, table.scratchName, aliases)
  );
}

function omitCatalogName(row: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(row).filter(([key]) => key !== "name"));
}

async function triggerCatalog(
  client: PgPoolClient,
  relation: string
): Promise<Array<Record<string, unknown>>> {
  return (
    await client.query<Record<string, unknown>>(
      `SELECT trigger_record.tgname AS name,
              trigger_record.tgtype AS type,
              trigger_record.tgenabled::text AS enabled,
              trigger_record.tgdeferrable AS deferrable,
              trigger_record.tginitdeferred AS initially_deferred,
              trigger_record.tgconstraint <> 0 AS is_constraint,
              trigger_record.tgattr::smallint[] AS columns,
              pg_get_expr(trigger_record.tgqual, trigger_record.tgrelid) AS condition,
              procedure_record.oid::regprocedure::text AS function
       FROM pg_trigger trigger_record
       JOIN pg_proc procedure_record ON procedure_record.oid = trigger_record.tgfoid
       WHERE trigger_record.tgrelid = $1::regclass AND NOT trigger_record.tgisinternal
       ORDER BY trigger_record.tgname`,
      [relation]
    )
  ).rows;
}

async function validateTriggers(
  client: PgPoolClient,
  scratch: ScratchCatalog,
  tables: readonly ExpectedTable[],
  table: ExpectedTable,
  expectedTriggers: readonly ExpectedTrigger[]
): Promise<void> {
  const actual = await triggerCatalog(client, table.actualName);
  const expected = await triggerCatalog(client, scratchRelation(scratch, table.scratchName));
  const aliases = b1RelationAliases(scratch, tables);
  assertCatalogEqual(
    `${table.actualName} trigger names`,
    actual.map((row) => row.name),
    expectedTriggers.map((trigger) => trigger.name).sort()
  );
  assertCatalogEqual(
    `${table.actualName} triggers`,
    normalizeRows(actual, table.actualName, aliases),
    normalizeRows(expected, table.scratchName, aliases)
  );
}

async function policyCatalog(
  client: PgPoolClient,
  relation: string
): Promise<Array<Record<string, unknown>>> {
  return (
    await client.query<Record<string, unknown>>(
      `SELECT policy_record.polname AS name,
              policy_record.polcmd::text AS command,
              policy_record.polpermissive AS permissive,
              ARRAY(SELECT CASE WHEN role_oid = 0 THEN 'PUBLIC' ELSE role_oid::regrole::text END
                    FROM unnest(policy_record.polroles) role_oid ORDER BY 1) AS roles,
              pg_get_expr(policy_record.polqual, policy_record.polrelid) AS using_expression,
              pg_get_expr(policy_record.polwithcheck, policy_record.polrelid) AS check_expression
       FROM pg_policy policy_record
       WHERE policy_record.polrelid = $1::regclass
       ORDER BY policy_record.polname`,
      [relation]
    )
  ).rows;
}

async function validatePolicies(
  client: PgPoolClient,
  scratch: ScratchCatalog,
  tables: readonly ExpectedTable[],
  table: ExpectedTable
): Promise<void> {
  const aliases = b1RelationAliases(scratch, tables);
  assertCatalogEqual(
    `${table.actualName} policies`,
    normalizeRows(await policyCatalog(client, table.actualName), table.actualName, aliases),
    normalizeRows(
      await policyCatalog(client, scratchRelation(scratch, table.scratchName)),
      table.scratchName,
      aliases
    )
  );
}

interface PrivilegeContract {
  schema_name: string;
  relation_name: string;
  scope: "table" | "column";
  column_name: string | null;
  grantee: string;
  privilege: string;
  grantable: boolean;
}

interface PrivilegeDiagnostic extends PrivilegeContract {
  direction: "missing" | "unexpected";
  grantor: string;
}

interface SchemaOwnershipContract {
  schema: string;
  owner: string;
  current_owner: string;
}

interface SchemaPrivilegeContract {
  schema: string;
  grantee: string;
  privilege: string;
  grantable: boolean;
}

interface FunctionPrivilegeContract {
  grantee: string;
  grantable: boolean;
}

function tablePrivilege(
  tableName: string,
  grantee: string,
  privilege: string,
  columnName: string | null = null
): PrivilegeContract {
  const [schemaName, relationName] = tableName.split(".") as [string, string];
  return {
    schema_name: schemaName,
    relation_name: relationName,
    scope: columnName === null ? "table" : "column",
    column_name: columnName,
    grantee,
    privilege,
    grantable: false
  };
}

function expectedTablePrivileges(
  tableName: string,
  integrityInstalled: boolean
): PrivilegeContract[] {
  const privileges: PrivilegeContract[] = [
    tablePrivilege(tableName, "throughline_app", "INSERT"),
    tablePrivilege(tableName, "throughline_app", "SELECT")
  ];
  const addColumns = (privilege: string, columns: readonly string[]) => {
    for (const column of columns) {
      privileges.push(tablePrivilege(tableName, "throughline_app", privilege, column));
    }
  };
  if (tableName === "work.activities") addColumns("UPDATE", ["id"]);
  if (tableName === "work.relationships") {
    addColumns("UPDATE", ["updated_at", "valid_to", "version"]);
  }
  if (tableName === "content.content_items") {
    addColumns("UPDATE", ["current_revision", "metadata", "title", "updated_at", "version"]);
  }
  if (tableName === "content.source_artifacts") {
    addColumns("UPDATE", [
      "content_hash",
      "deleted_at",
      "deletion_policy_ref",
      "deletion_reason",
      "hash_disposition",
      "immutable_text",
      "normalized_content_hash",
      "object_key",
      "updated_at",
      "version"
    ]);
  }
  if (tableName === "content.source_chunks") {
    privileges.push(tablePrivilege(tableName, "throughline_app", "DELETE"));
  }
  if (integrityInstalled && integrityReadTables.has(tableName)) {
    privileges.push(tablePrivilege(tableName, "throughline_b1_0_integrity", "SELECT"));
  }
  return privileges;
}

async function validateTablePrivileges(
  client: PgPoolClient,
  tableName: string,
  integrityInstalled: boolean
): Promise<void> {
  const diagnostics = await client.query<PrivilegeDiagnostic>(
    `WITH relation AS (
       SELECT relation_record.oid, relation_record.relowner, relation_record.relacl,
              namespace_record.nspname::text AS schema_name,
              relation_record.relname::text AS relation_name
       FROM pg_class relation_record
       JOIN pg_namespace namespace_record ON namespace_record.oid = relation_record.relnamespace
       WHERE relation_record.oid = $1::regclass
     ), actual_acl AS (
       SELECT relation.schema_name, relation.relation_name,
              'table'::text AS scope, NULL::text AS column_name,
              CASE WHEN acl_record.grantee = 0 THEN 'PUBLIC'
                   ELSE pg_get_userbyid(acl_record.grantee) END::text AS grantee,
              acl_record.privilege_type::text AS privilege,
              acl_record.is_grantable AS grantable,
              pg_get_userbyid(acl_record.grantor)::text AS grantor
       FROM relation
       CROSS JOIN LATERAL aclexplode(relation.relacl) acl_record
       WHERE acl_record.grantee <> relation.relowner
       UNION ALL
       SELECT relation.schema_name, relation.relation_name,
              'column'::text AS scope, attribute_record.attname::text AS column_name,
              CASE WHEN acl_record.grantee = 0 THEN 'PUBLIC'
                   ELSE pg_get_userbyid(acl_record.grantee) END::text AS grantee,
              acl_record.privilege_type::text AS privilege,
              acl_record.is_grantable AS grantable,
              pg_get_userbyid(acl_record.grantor)::text AS grantor
       FROM relation
       JOIN pg_attribute attribute_record ON attribute_record.attrelid = relation.oid
       CROSS JOIN LATERAL aclexplode(
         CASE WHEN cardinality(attribute_record.attacl) = 0 THEN NULL::aclitem[]
              ELSE attribute_record.attacl END
       ) acl_record
       WHERE attribute_record.attnum > 0 AND NOT attribute_record.attisdropped
         AND acl_record.grantee <> relation.relowner
     ), expected_acl AS (
       SELECT expected.schema_name, expected.relation_name, expected.scope,
              expected.column_name, expected.grantee, expected.privilege,
              expected.grantable, current_user::text AS grantor
       FROM jsonb_to_recordset($2::jsonb) AS expected(
         schema_name text, relation_name text, scope text, column_name text,
         grantee text, privilege text, grantable boolean
       )
     ), missing_acl AS (
       SELECT * FROM expected_acl
       EXCEPT
       SELECT * FROM actual_acl
     ), unexpected_acl AS (
       SELECT * FROM actual_acl
       EXCEPT
       SELECT * FROM expected_acl
     ), missing_diagnostic AS (
       SELECT 'missing'::text AS direction, missing_acl.* FROM missing_acl
       ORDER BY schema_name, relation_name, scope, column_name NULLS FIRST,
                grantee, privilege, grantable, grantor
       LIMIT 1
     ), unexpected_diagnostic AS (
       SELECT 'unexpected'::text AS direction, unexpected_acl.* FROM unexpected_acl
       ORDER BY schema_name, relation_name, scope, column_name NULLS FIRST,
                grantee, privilege, grantable, grantor
       LIMIT 1
     )
     SELECT * FROM missing_diagnostic
     UNION ALL
     SELECT * FROM unexpected_diagnostic
     ORDER BY direction`,
    [tableName, JSON.stringify(expectedTablePrivileges(tableName, integrityInstalled))]
  );
  if (diagnostics.rowCount !== 0) {
    throw new Error(
      `Installed B1 catalog does not match ${tableName} direct, PUBLIC, column, and grant-option privileges: ${JSON.stringify(diagnostics.rows)}`
    );
  }
}

async function validateProtectedRoles(client: PgPoolClient): Promise<void> {
  const result = await client.query<Record<string, unknown>>(
    `SELECT rolname AS role, rolcanlogin AS login, rolsuper AS superuser,
            rolcreatedb AS create_db, rolcreaterole AS create_role,
            rolinherit AS inherit, rolreplication AS replication,
            rolbypassrls AS bypass_rls, rolconnlimit AS connection_limit,
            rolvaliduntil AS valid_until
     FROM pg_roles WHERE rolname = ANY($1::text[]) ORDER BY rolname`,
    [protectedRoles]
  );
  const expected = protectedRoles
    .map((role) => ({
      role,
      login: false,
      superuser: false,
      create_db: false,
      create_role: false,
      inherit: role === "throughline_app",
      replication: false,
      bypass_rls: false,
      connection_limit: -1,
      valid_until: null
    }))
    .sort((left, right) => left.role.localeCompare(right.role));
  assertCatalogEqual("protected B1 role attributes", result.rows, expected);

  const memberships = await client.query(
    `SELECT 1 FROM pg_auth_members membership
     JOIN pg_roles granted ON granted.oid = membership.roleid
     JOIN pg_roles member_role ON member_role.oid = membership.member
     WHERE granted.rolname = ANY($1::text[]) OR member_role.rolname = ANY($1::text[])`,
    [protectedRoles]
  );
  if (memberships.rowCount !== 0) {
    throw new Error("Protected B1 roles have an inherited capability path");
  }
}

async function validateSchemaSecurity(
  client: PgPoolClient,
  scratch: ScratchCatalog,
  tables: readonly ExpectedTable[],
  indexes: readonly ExpectedIndex[],
  integrityInstalled: boolean
): Promise<void> {
  const expectedTables = tables.map((table) => table.actualName).sort();
  const expectedSchemaNames = [
    ...new Set(expectedTables.map((table) => table.split(".")[0]!))
  ].sort();
  const installedObjects = await client.query<{ name: string; kind: string }>(
    `SELECT CASE
              WHEN relation_record.relkind IN ('i', 'I') THEN
                table_namespace.nspname || '.' || table_record.relname || '.<index>'
              ELSE namespace_record.nspname || '.' || relation_record.relname
            END AS name,
            relation_record.relkind::text AS kind
     FROM pg_class relation_record
     JOIN pg_namespace namespace_record ON namespace_record.oid = relation_record.relnamespace
     LEFT JOIN pg_index index_record ON index_record.indexrelid = relation_record.oid
     LEFT JOIN pg_class table_record ON table_record.oid = index_record.indrelid
     LEFT JOIN pg_namespace table_namespace ON table_namespace.oid = table_record.relnamespace
     WHERE namespace_record.nspname IN ('work', 'content')
     ORDER BY 1, 2`
  );
  const scratchObjects = await client.query<{
    name: string;
    kind: string;
    table_name: string | null;
  }>(
    `SELECT relation_record.relname AS name, relation_record.relkind::text AS kind,
            table_record.relname AS table_name
     FROM pg_class relation_record
     JOIN pg_namespace namespace_record ON namespace_record.oid = relation_record.relnamespace
     LEFT JOIN pg_index index_record ON index_record.indexrelid = relation_record.oid
     LEFT JOIN pg_class table_record ON table_record.oid = index_record.indrelid
     WHERE namespace_record.nspname = $1
     ORDER BY 1, 2, 3`,
    [scratch.schemaName]
  );
  const expectedTableNames = new Map(
    tables.map((table) => [table.scratchName, table.actualName] as const)
  );
  // Exact index names and definitions are checked separately by validateIndexes. Normalize every
  // index here by its owning relation so this inventory additionally closes the pg_class kind and
  // cardinality without depending on PostgreSQL-generated names for implicit constraint indexes.
  void indexes;
  const expectedObjects = scratchObjects.rows
    .map((row) => {
      const tableName = row.table_name ? expectedTableNames.get(row.table_name) : undefined;
      return {
        name:
          (row.kind === "i" || row.kind === "I") && tableName
            ? `${tableName}.<index>`
            : (expectedTableNames.get(row.name) ?? row.name),
        kind: row.kind
      };
    })
    .sort(compareRelationInventoryRows);
  assertCatalogEqual(
    "closed work/content relation inventory",
    [...installedObjects.rows].sort(compareRelationInventoryRows),
    expectedObjects
  );

  const schemas = await client.query<SchemaOwnershipContract>(
    `SELECT namespace_record.nspname AS schema,
            pg_get_userbyid(namespace_record.nspowner) AS owner,
            current_user AS current_owner
     FROM pg_namespace namespace_record
     WHERE namespace_record.nspname IN ('work', 'content') ORDER BY 1`
  );
  const privileges = await client.query<SchemaPrivilegeContract>(
    `SELECT namespace_record.nspname::text AS schema,
            CASE WHEN acl_record.grantee = 0 THEN 'PUBLIC'
                 ELSE pg_get_userbyid(acl_record.grantee) END::text AS grantee,
            acl_record.privilege_type::text AS privilege,
            acl_record.is_grantable AS grantable
     FROM pg_namespace namespace_record
     CROSS JOIN LATERAL aclexplode(COALESCE(
       namespace_record.nspacl, acldefault('n', namespace_record.nspowner)
     )) acl_record
     WHERE namespace_record.nspname IN ('work', 'content')
       AND acl_record.grantee <> namespace_record.nspowner
     ORDER BY 1, 2, 3, 4`
  );
  const expectedSchemas = expectedSchemaNames.map((schema) => ({
    schema,
    owner: schemas.rows[0]?.current_owner,
    current_owner: schemas.rows[0]?.current_owner
  }));
  const expectedPrivileges = expectedSchemaNames.flatMap((schema) => [
    { schema, grantee: "throughline_app", privilege: "USAGE", grantable: false },
    ...(integrityInstalled
      ? [
          {
            schema,
            grantee: "throughline_b1_0_integrity",
            privilege: "USAGE",
            grantable: false
          }
        ]
      : [])
  ]);
  assertCatalogEqual(
    "work/content schema ownership and ACL",
    { schemas: schemas.rows, privileges: privileges.rows },
    { schemas: expectedSchemas, privileges: expectedPrivileges }
  );
}

function functionSource(source: string, schema: string, name: string): string {
  const matcher = new RegExp(
    `CREATE (?:OR REPLACE )?FUNCTION ${schema}\\.${name}\\([\\s\\S]*?AS \\$function\\$([\\s\\S]*?)\\$function\\$;`
  );
  const match = matcher.exec(source);
  if (!match) throw new Error(`Missing fixed function source for ${schema}.${name}`);
  return match[1]!;
}

async function validateFunctions(
  client: PgPoolClient,
  installed: readonly B1MigrationId[],
  sources: MigrationSources
): Promise<void> {
  const installedContracts = functionContracts.filter(([schema]) =>
    schema === "work"
      ? installed.includes(B1_MIGRATION_IDS[0])
      : schema === "content"
        ? installed.includes(B1_MIGRATION_IDS[1])
        : installed.includes(B1_MIGRATION_IDS[2])
  );
  const currentOwner = (await client.query<{ owner: string }>("SELECT current_user AS owner"))
    .rows[0]!.owner;
  for (const contract of installedContracts) {
    const [schema, name, argumentsText, resultType, language, volatility, strict, securityDefiner] =
      contract;
    const migrationId =
      schema === "work"
        ? B1_MIGRATION_IDS[0]
        : schema === "content"
          ? B1_MIGRATION_IDS[1]
          : name === "enforce_domain_command_transition" ||
              name === "reject_committed_reserved_command"
            ? B1_PREDECESSOR_IDS[2]
            : B1_MIGRATION_IDS[2];
    const result = await client.query<Record<string, unknown>>(
      `SELECT oidvectortypes(procedure_record.proargtypes) AS arguments,
              pg_get_function_result(procedure_record.oid) AS result,
              language_record.lanname AS language,
              procedure_record.provolatile::text AS volatility,
              procedure_record.proisstrict AS strict,
              procedure_record.prosecdef AS security_definer,
              procedure_record.prokind::text AS kind,
              pg_get_userbyid(procedure_record.proowner) AS owner,
              procedure_record.proconfig AS configuration,
              procedure_record.prosrc AS source
       FROM pg_proc procedure_record
       JOIN pg_namespace namespace_record ON namespace_record.oid = procedure_record.pronamespace
       JOIN pg_language language_record ON language_record.oid = procedure_record.prolang
       WHERE namespace_record.nspname = $1 AND procedure_record.proname = $2
         AND oidvectortypes(procedure_record.proargtypes) = $3`,
      [schema, name, argumentsText]
    );
    const executeAcl = await client.query<FunctionPrivilegeContract>(
      `SELECT CASE WHEN acl_record.grantee = 0 THEN 'PUBLIC'
                   ELSE pg_get_userbyid(acl_record.grantee) END::text AS grantee,
              acl_record.is_grantable AS grantable
       FROM pg_proc procedure_record
       JOIN pg_namespace namespace_record ON namespace_record.oid = procedure_record.pronamespace
       CROSS JOIN LATERAL aclexplode(COALESCE(
         procedure_record.proacl, acldefault('f', procedure_record.proowner)
       )) acl_record
       WHERE namespace_record.nspname = $1 AND procedure_record.proname = $2
         AND oidvectortypes(procedure_record.proargtypes) = $3
         AND acl_record.privilege_type = 'EXECUTE'
         AND acl_record.grantee <> procedure_record.proowner
       ORDER BY 1, 2`,
      [schema, name, argumentsText]
    );
    const expectedAcl =
      `${schema}.${name}` === "work.canonical_domain" ||
      `${schema}.${name}` === "work.resolve_relationship_endpoint" ||
      `${schema}.${name}` === "content.access_class_rank" ||
      `${schema}.${name}` === "ops.b1_command_record_valid"
        ? [{ grantee: "throughline_app", grantable: false }]
        : [];
    assertCatalogEqual(`${schema}.${name}(${argumentsText}) function`, result.rows, [
      {
        arguments: argumentsText,
        result: resultType,
        language,
        volatility,
        strict,
        security_definer: securityDefiner,
        kind: "f",
        owner: [
          "ops.enforce_domain_command_transition",
          "ops.reject_committed_reserved_command",
          "ops.require_b1_command_atomicity"
        ].includes(`${schema}.${name}`)
          ? "throughline_b1_0_integrity"
          : currentOwner,
        configuration: ["search_path=pg_catalog"],
        source: functionSource(requireSource(sources, migrationId), schema, name)
      }
    ]);
    assertCatalogEqual(
      `${schema}.${name}(${argumentsText}) function EXECUTE ACL`,
      executeAcl.rows,
      expectedAcl
    );
  }

  const namesBySchema = new Map<string, string[]>();
  for (const [schema, name] of installedContracts) {
    namesBySchema.set(schema, [...(namesBySchema.get(schema) ?? []), name]);
  }
  for (const [schema, names] of namesBySchema) {
    const overloads = await client.query<{ name: string; arguments: string }>(
      `SELECT procedure_record.proname AS name,
              oidvectortypes(procedure_record.proargtypes) AS arguments
       FROM pg_proc procedure_record
       JOIN pg_namespace namespace_record ON namespace_record.oid = procedure_record.pronamespace
       WHERE namespace_record.nspname = $1
         AND ($3::boolean OR procedure_record.proname = ANY($2::text[]))
       ORDER BY 1, 2`,
      [schema, names, schema !== "ops"]
    );
    const expected = installedContracts
      .filter(([contractSchema]) => contractSchema === schema)
      .map(([, name, argumentsText]) => ({ name, arguments: argumentsText }))
      .sort((left, right) =>
        `${left.name}|${left.arguments}`.localeCompare(`${right.name}|${right.arguments}`)
      );
    assertCatalogEqual(`${schema} B1 function overload inventory`, overloads.rows, expected);
  }
}

async function validateCommandIntegrityObjects(
  client: PgPoolClient,
  scratch: ScratchCatalog,
  predecessorSource: string,
  source: string
): Promise<void> {
  const expectedTable = "b1_contract_domain_command_records";
  const expectedRelation = scratchRelation(scratch, expectedTable);
  // This must be an ordinary transaction-local scratch relation: PostgreSQL forbids temporary-table
  // constraints from referencing the persistent predecessor relations used by the fixed contract.
  await client.query(`CREATE TABLE ${expectedRelation}
    (LIKE ops.domain_command_records INCLUDING DEFAULTS INCLUDING GENERATED INCLUDING IDENTITY)`);
  const predecessorConstraintStatement = predecessorSource.match(
    /ALTER TABLE throughline_b1_0_migration_contract\.b1_0_expected_domain_command_records[\s\S]*?;\n/
  )?.[0];
  const b1ConstraintStatement = source.match(
    /ALTER TABLE ops\.domain_command_records\s+ADD CONSTRAINT domain_command_records_b1_shape_check[\s\S]*?\n\s*\);/
  )?.[0];
  if (!predecessorConstraintStatement || !b1ConstraintStatement) {
    throw new Error("Fixed command integrity contract parser failed");
  }
  await client.query(
    predecessorConstraintStatement.replace(
      "ALTER TABLE throughline_b1_0_migration_contract.b1_0_expected_domain_command_records",
      `ALTER TABLE ${expectedRelation}`
    )
  );
  await client.query(
    b1ConstraintStatement.replace(
      "ALTER TABLE ops.domain_command_records",
      `ALTER TABLE ${expectedRelation}`
    )
  );

  for (const [triggerSource, triggerName] of [
    [predecessorSource, "domain_command_records_transition_guard"],
    [predecessorSource, "domain_command_records_no_committed_reserved"],
    [source, "domain_command_records_b1_atomicity_deferred"]
  ] as const) {
    const triggerStatement = triggerSource.match(
      new RegExp(`CREATE (?:CONSTRAINT )?TRIGGER ${triggerName}[\\s\\S]*?;`)
    )?.[0];
    if (!triggerStatement) throw new Error(`Fixed ${triggerName} trigger parser failed`);
    await client.query(
      triggerStatement.replace("ON ops.domain_command_records", `ON ${expectedRelation}`)
    );
  }

  const constraintCatalog = async (relation: string) =>
    (
      await client.query<Record<string, unknown>>(
        `SELECT constraint_record.conname AS name,
                constraint_record.contype::text AS type,
                pg_get_constraintdef(constraint_record.oid, false) AS definition,
                constraint_record.condeferrable AS deferrable,
                constraint_record.condeferred AS initially_deferred,
                constraint_record.convalidated AS validated,
                constraint_record.connoinherit AS no_inherit
         FROM pg_constraint constraint_record
         WHERE constraint_record.conrelid = $1::regclass
         ORDER BY constraint_record.conname`,
        [relation]
      )
    ).rows;
  assertCatalogEqual(
    "exact domain command constraint inventory",
    normalizeRows(
      await constraintCatalog("ops.domain_command_records"),
      "ops.domain_command_records"
    ),
    normalizeRows(await constraintCatalog(expectedRelation), expectedTable)
  );

  const actualTriggers = await triggerCatalog(client, "ops.domain_command_records");
  const expectedTriggers = await triggerCatalog(client, expectedRelation);
  assertCatalogEqual(
    "exact domain command user-trigger inventory",
    normalizeRows(actualTriggers, "ops.domain_command_records"),
    normalizeRows(expectedTriggers, expectedTable)
  );

  const rewriteRules = await client.query<Record<string, unknown>>(
    `SELECT rewrite_record.rulename AS name,
            rewrite_record.ev_type::text AS event,
            rewrite_record.is_instead AS instead,
            rewrite_record.ev_enabled::text AS enabled,
            pg_get_ruledef(rewrite_record.oid, false) AS definition
     FROM pg_rewrite rewrite_record
     WHERE rewrite_record.ev_class = 'ops.domain_command_records'::regclass
       AND rewrite_record.rulename <> '_RETURN'
     ORDER BY rewrite_record.rulename`
  );
  assertCatalogEqual("exact domain command rewrite-rule inventory", rewriteRules.rows, []);
}

const integrityPolicyContracts = [
  ["ops.domain_command_records", "domain_command_records_integrity_select"],
  ["access.spaces", "spaces_b1_integrity_select"],
  ["access.access_relationships", "access_relationships_b1_integrity_select"],
  ["identity.service_principals", "service_principals_b1_integrity_select"],
  ["ops.audit_events", "audit_events_b1_integrity_select"],
  ["ops.product_outbox_events", "product_outbox_events_b1_integrity_select"],
  ["work.organizations", "organizations_b1_integrity_select"],
  ["work.initiatives", "initiatives_b1_integrity_select"],
  ["work.activities", "activities_b1_integrity_select"],
  ["work.relationships", "relationships_b1_integrity_select"],
  ["work.activity_sources", "activity_sources_b1_integrity_select"],
  ["content.content_items", "content_items_b1_integrity_select"],
  ["content.source_artifacts", "source_artifacts_b1_integrity_select"],
  ["content.source_chunks", "source_chunks_b1_integrity_select"]
] as const;

interface ExpectedPredecessorAcl {
  schema_name: string;
  relation_name: string;
  scope: "table" | "column";
  column_name: string | null;
  grantee: string;
  privilege: string;
  grantable: boolean;
}

const predecessorAclRelations = [
  "access.access_relationships",
  "access.spaces",
  "identity.policy_versions",
  "identity.service_principals",
  "identity.tenants",
  "identity.workspaces",
  "ops.audit_events",
  "ops.domain_command_records",
  "ops.product_outbox_events"
] as const;

function predecessorAclRows(
  relation: string,
  scope: "table" | "column",
  columnNames: readonly string[],
  grantee: string,
  privileges: readonly string[]
): ExpectedPredecessorAcl[] {
  const [schema_name, relation_name] = relation.split(".") as [string, string];
  const columns = scope === "table" ? [null] : columnNames;
  return columns.flatMap((column_name) =>
    privileges.map((privilege) => ({
      schema_name,
      relation_name,
      scope,
      column_name,
      grantee,
      privilege,
      grantable: false
    }))
  );
}

function expectedPredecessorAcl(integrityInstalled: boolean): ExpectedPredecessorAcl[] {
  const rows: ExpectedPredecessorAcl[] = [];
  for (const relation of [
    "access.access_relationships",
    "access.spaces",
    "identity.policy_versions",
    "identity.service_principals",
    "identity.tenants",
    "identity.workspaces"
  ]) {
    rows.push(
      ...predecessorAclRows(relation, "table", [], "throughline_app", [
        "DELETE",
        "INSERT",
        "SELECT",
        "UPDATE"
      ])
    );
  }
  const scopeColumns = {
    "access.access_relationships": [
      "id",
      "tenant_id",
      "workspace_id",
      "subject_type",
      "subject_id",
      "relation",
      "resource_type",
      "resource_id",
      "source"
    ],
    "access.spaces": ["id", "tenant_id", "workspace_id", "archived_at"],
    "identity.tenants": ["id", "status"],
    "identity.workspaces": ["id", "tenant_id", "status"],
    "identity.policy_versions": ["id", "tenant_id", "workspace_id", "status"],
    "identity.service_principals": ["id", "tenant_id", "workspace_id", "purpose", "status"]
  } as const;
  for (const [relation, columns] of Object.entries(scopeColumns)) {
    for (const grantee of [
      "throughline_relay",
      "throughline_worker",
      "throughline_product_relay"
    ]) {
      rows.push(...predecessorAclRows(relation, "column", columns, grantee, ["SELECT"]));
      rows.push(...predecessorAclRows(relation, "column", ["id"], grantee, ["UPDATE"]));
    }
  }
  rows.push(
    ...predecessorAclRows("ops.domain_command_records", "table", [], "throughline_app", ["SELECT"]),
    ...predecessorAclRows(
      "ops.domain_command_records",
      "column",
      [
        "id",
        "tenant_id",
        "workspace_id",
        "reservation_space_id",
        "command_kind",
        "command_schema_version",
        "idempotency_key",
        "canonical_request_hash",
        "actor_user_id",
        "actor_membership_id",
        "delegating_user_id",
        "delegating_membership_id",
        "agent_principal_id",
        "policy_version_id",
        "request_id",
        "traceparent",
        "tracestate"
      ],
      "throughline_app",
      ["INSERT"]
    ),
    ...predecessorAclRows(
      "ops.domain_command_records",
      "column",
      [
        "state",
        "result_resource_type",
        "result_resource_id",
        "safe_response",
        "completed_at",
        "updated_at"
      ],
      "throughline_app",
      ["UPDATE"]
    ),
    ...predecessorAclRows(
      "ops.domain_command_records",
      "column",
      ["id", "tenant_id", "workspace_id", "state"],
      "throughline_b1_0_integrity",
      ["SELECT"]
    ),
    ...predecessorAclRows("ops.audit_events", "table", [], "throughline_app", ["INSERT", "SELECT"])
  );
  const productCommandColumns = [
    "id",
    "tenant_id",
    "workspace_id",
    "space_id",
    "relay_service_principal_id",
    "policy_version_id",
    "event_type",
    "event_schema_version",
    "payload_schema_version",
    "aggregate_type",
    "aggregate_id",
    "aggregate_version",
    "causation_command_id",
    "payload",
    "request_id",
    "traceparent",
    "tracestate"
  ] as const;
  rows.push(
    ...predecessorAclRows(
      "ops.product_outbox_events",
      "column",
      productCommandColumns,
      "throughline_app",
      ["INSERT", "SELECT"]
    ),
    ...predecessorAclRows(
      "ops.product_outbox_events",
      "column",
      [
        ...productCommandColumns,
        "created_at",
        "publication_state",
        "publication_attempt",
        "next_attempt_at",
        "claimed_at",
        "claimed_by",
        "claim_token",
        "claim_expires_at",
        "last_outcome_code",
        "published_at",
        "published_message_id",
        "terminal_at"
      ],
      "throughline_product_relay",
      ["SELECT"]
    ),
    ...predecessorAclRows(
      "ops.product_outbox_events",
      "column",
      [
        "publication_state",
        "publication_attempt",
        "next_attempt_at",
        "claimed_at",
        "claimed_by",
        "claim_token",
        "claim_expires_at",
        "last_outcome_code",
        "published_at",
        "published_message_id",
        "terminal_at"
      ],
      "throughline_product_relay",
      ["UPDATE"]
    )
  );
  if (integrityInstalled) {
    for (const relation of [
      "access.access_relationships",
      "access.spaces",
      "identity.service_principals",
      "ops.audit_events",
      "ops.product_outbox_events"
    ]) {
      rows.push(
        ...predecessorAclRows(relation, "table", [], "throughline_b1_0_integrity", ["SELECT"])
      );
    }
  }
  return rows;
}

async function validateIntegrityPredecessorAccess(
  client: PgPoolClient,
  integrityInstalled: boolean
): Promise<void> {
  const policies = await client.query<Record<string, unknown>>(
    `SELECT namespace_record.nspname || '.' || relation_record.relname AS relation,
            policy_record.polname AS name,
            policy_record.polcmd::text AS command,
            policy_record.polpermissive AS permissive,
            ARRAY(SELECT CASE WHEN role_oid = 0 THEN 'PUBLIC' ELSE role_oid::regrole::text END
                  FROM unnest(policy_record.polroles) role_oid ORDER BY 1) AS roles,
            pg_get_expr(policy_record.polqual, policy_record.polrelid) AS using_expression,
            pg_get_expr(policy_record.polwithcheck, policy_record.polrelid) AS check_expression
     FROM pg_policy policy_record
     JOIN pg_class relation_record ON relation_record.oid = policy_record.polrelid
     JOIN pg_namespace namespace_record ON namespace_record.oid = relation_record.relnamespace
     WHERE 'throughline_b1_0_integrity'::regrole = ANY(policy_record.polroles)
     ORDER BY 1, 2`
  );
  const expectedPolicies = integrityPolicyContracts
    .filter(([relation]) => integrityInstalled || relation === "ops.domain_command_records")
    .map(([relation, name]) => ({
      relation,
      name,
      command: "r",
      permissive: true,
      roles: ["throughline_b1_0_integrity"],
      using_expression: "true",
      check_expression: null
    }))
    .sort((left, right) =>
      `${left.relation}|${left.name}`.localeCompare(`${right.relation}|${right.name}`)
    );
  assertCatalogEqual("B1 integrity policy capability boundary", policies.rows, expectedPolicies);

  const aclDiagnostics = await client.query<Record<string, unknown>>(
    `WITH expected_acl AS (
       SELECT expected.schema_name, expected.relation_name, expected.scope,
              expected.column_name, expected.grantee, expected.privilege,
              expected.grantable, current_user::text AS grantor
       FROM jsonb_to_recordset($2::jsonb) AS expected(
         schema_name text, relation_name text, scope text, column_name text,
         grantee text, privilege text, grantable boolean
       )
     ), actual_acl AS (
       SELECT namespace_record.nspname::text AS schema_name,
              relation_record.relname::text AS relation_name,
              'table'::text AS scope, NULL::text AS column_name,
              CASE WHEN acl_record.grantee = 0 THEN 'PUBLIC'
                   ELSE pg_get_userbyid(acl_record.grantee) END::text AS grantee,
              acl_record.privilege_type::text AS privilege,
              acl_record.is_grantable AS grantable,
              CASE WHEN acl_record.grantor = 0 THEN 'PUBLIC'
                   ELSE pg_get_userbyid(acl_record.grantor) END::text AS grantor
       FROM pg_class relation_record
       JOIN pg_namespace namespace_record ON namespace_record.oid = relation_record.relnamespace
       CROSS JOIN LATERAL aclexplode(
         CASE WHEN cardinality(relation_record.relacl) = 0 THEN NULL::aclitem[]
              ELSE relation_record.relacl END
       ) acl_record
       WHERE namespace_record.nspname || '.' || relation_record.relname = ANY($1::text[])
         AND acl_record.grantee <> relation_record.relowner
       UNION ALL
       SELECT namespace_record.nspname::text AS schema_name,
              relation_record.relname::text AS relation_name,
              'column'::text AS scope, attribute_record.attname::text AS column_name,
              CASE WHEN acl_record.grantee = 0 THEN 'PUBLIC'
                   ELSE pg_get_userbyid(acl_record.grantee) END::text AS grantee,
              acl_record.privilege_type::text AS privilege,
              acl_record.is_grantable AS grantable,
              CASE WHEN acl_record.grantor = 0 THEN 'PUBLIC'
                   ELSE pg_get_userbyid(acl_record.grantor) END::text AS grantor
       FROM pg_attribute attribute_record
       JOIN pg_class relation_record ON relation_record.oid = attribute_record.attrelid
       JOIN pg_namespace namespace_record ON namespace_record.oid = relation_record.relnamespace
       CROSS JOIN LATERAL aclexplode(
         CASE WHEN cardinality(attribute_record.attacl) = 0 THEN NULL::aclitem[]
              ELSE attribute_record.attacl END
       ) acl_record
       WHERE namespace_record.nspname || '.' || relation_record.relname = ANY($1::text[])
         AND attribute_record.attnum > 0 AND NOT attribute_record.attisdropped
         AND acl_record.grantee <> relation_record.relowner
     ), missing_acl AS (
       SELECT * FROM expected_acl
       EXCEPT
       SELECT * FROM actual_acl
     ), unexpected_acl AS (
       SELECT * FROM actual_acl
       EXCEPT
       SELECT * FROM expected_acl
     ), missing_diagnostic AS (
       SELECT 'missing'::text AS direction, missing_acl.* FROM missing_acl
       ORDER BY schema_name, relation_name, scope, column_name NULLS FIRST,
                grantee, privilege, grantable, grantor
       LIMIT 1
     ), unexpected_diagnostic AS (
       SELECT 'unexpected'::text AS direction, unexpected_acl.* FROM unexpected_acl
       ORDER BY schema_name, relation_name, scope, column_name NULLS FIRST,
                grantee, privilege, grantable, grantor
       LIMIT 1
     )
     SELECT * FROM missing_diagnostic
     UNION ALL
     SELECT * FROM unexpected_diagnostic
     ORDER BY direction`,
    [predecessorAclRelations, JSON.stringify(expectedPredecessorAcl(integrityInstalled))]
  );
  if (aclDiagnostics.rowCount !== 0) {
    throw new Error(
      `Installed predecessor ACL authority does not match the exact normalized contract: ${JSON.stringify(aclDiagnostics.rows)}`
    );
  }

  const schemaPrivileges = await client.query<Record<string, unknown>>(
    `SELECT namespace_record.nspname AS schema,
            acl_record.privilege_type AS privilege,
            acl_record.is_grantable AS grantable
     FROM pg_namespace namespace_record
     CROSS JOIN LATERAL aclexplode(namespace_record.nspacl) acl_record
     WHERE acl_record.grantee = 'throughline_b1_0_integrity'::regrole
     ORDER BY 1, 2`
  );
  assertCatalogEqual(
    "B1 integrity schema grants",
    schemaPrivileges.rows,
    (integrityInstalled ? ["access", "content", "identity", "ops", "work"] : ["ops"]).map(
      (schema) => ({
        schema,
        privilege: "USAGE",
        grantable: false
      })
    )
  );

  const unexpectedCapabilities = await client.query(
    `SELECT 1 FROM pg_proc procedure_record
        CROSS JOIN LATERAL aclexplode(procedure_record.proacl) acl_record
       WHERE acl_record.grantee = 'throughline_b1_0_integrity'::regrole
         AND procedure_record.proowner <> acl_record.grantee
     UNION ALL
     SELECT 1 FROM pg_database database_record
        CROSS JOIN LATERAL aclexplode(database_record.datacl) acl_record
       WHERE acl_record.grantee = 'throughline_b1_0_integrity'::regrole`
  );
  if (unexpectedCapabilities.rowCount !== 0) {
    throw new Error("B1 integrity role has an unexpected function or database capability");
  }
}
