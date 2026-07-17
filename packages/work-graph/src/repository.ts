import type { AccessClass, SafePersonProjection } from "@throughline/core-types";
import type { TenantDbTransaction } from "@throughline/db";
import type {
  Activity,
  B1RelationshipEntityKind,
  Initiative,
  Organization,
  Relationship,
  RelationshipEndpoint,
  SpaceBearingEndpoint
} from "./work-graph.js";

export interface WorkspaceProfilePin {
  rootSpaceId: string;
  profileId: string;
  profileVersion: string;
  defaultAccessClass: AccessClass;
  retentionPolicyId?: string;
}

interface ActivityRow {
  id: string;
  space_id: string;
  subtype: string;
  profile_template_key: string;
  title: string;
  status: Activity["status"];
  occurred_at: Date | null;
  starts_at: Date | null;
  ends_at: Date | null;
  owner_person_id: string;
  governing_initiative_id: string | null;
  governing_organization_id: string | null;
  version: number;
}

export interface ActivityAssociationVisibility {
  organizationIds: readonly string[];
  initiativeIds: readonly string[];
  personIds: readonly string[];
}

export class WorkGraphRepository {
  constructor(private readonly tx: TenantDbTransaction) {}

  async getWorkspaceProfilePin(
    tenantId: string,
    workspaceId: string
  ): Promise<WorkspaceProfilePin> {
    const result = await this.tx.query<{
      default_space_id: string | null;
      profile_id: string;
      profile_version: string;
      default_access_class: AccessClass;
      retention_policy_id: string | null;
    }>(
      `SELECT default_space_id, profile_id, profile_version, default_access_class, retention_policy_id
       FROM identity.workspaces
       WHERE tenant_id = $1 AND id = $2 AND status = 'active' LIMIT 1 FOR SHARE`,
      [tenantId, workspaceId]
    );
    const row = result.rows[0];
    if (!row?.default_space_id) throw new Error("Workspace configuration is unavailable");
    return {
      rootSpaceId: row.default_space_id,
      profileId: row.profile_id,
      profileVersion: row.profile_version,
      defaultAccessClass: row.default_access_class,
      ...(row.retention_policy_id === null ? {} : { retentionPolicyId: row.retention_policy_id })
    };
  }

  async getSpace(
    tenantId: string,
    workspaceId: string,
    spaceId: string,
    lock = false
  ): Promise<{ id: string; parentSpaceId?: string; accessClass: AccessClass; kind: string }> {
    const result = await this.tx.query<{
      id: string;
      parent_space_id: string | null;
      access_class: AccessClass;
      kind: string;
    }>(
      `SELECT id, parent_space_id, access_class, kind FROM access.spaces
       WHERE tenant_id = $1 AND workspace_id = $2 AND id = $3 AND archived_at IS NULL
       LIMIT 1 ${lock ? "FOR UPDATE" : ""}`,
      [tenantId, workspaceId, spaceId]
    );
    const row = result.rows[0];
    if (!row) throw new Error("Work graph resource is unavailable");
    return {
      id: row.id,
      ...(row.parent_space_id === null ? {} : { parentSpaceId: row.parent_space_id }),
      accessClass: row.access_class,
      kind: row.kind
    };
  }

  async getOrganization(
    tenantId: string,
    workspaceId: string,
    organizationId: string,
    lock = false
  ): Promise<Organization> {
    if (lock) {
      const locked = await this.tx.query<{ id: string }>(
        `SELECT id FROM work.organizations
         WHERE tenant_id = $1 AND workspace_id = $2 AND id = $3 LIMIT 1 FOR UPDATE`,
        [tenantId, workspaceId, organizationId]
      );
      if (!locked.rows[0]) throw new Error("Work graph resource is unavailable");
    }
    const result = await this.tx.query<{
      id: string;
      space_id: string;
      name: string;
      normalized_name: string;
      status: "active" | "archived";
      version: number;
      domains: string[];
    }>(
      `SELECT organization.id, organization.space_id, organization.name,
              organization.normalized_name, organization.status, organization.version,
              COALESCE(array_agg(domain.domain ORDER BY domain.domain)
                FILTER (WHERE domain.domain IS NOT NULL), ARRAY[]::text[]) AS domains
       FROM work.organizations organization
       LEFT JOIN work.organization_domains domain
         ON domain.tenant_id = organization.tenant_id
        AND domain.workspace_id = organization.workspace_id
        AND domain.organization_id = organization.id
       WHERE organization.tenant_id = $1 AND organization.workspace_id = $2
         AND organization.id = $3
       GROUP BY organization.id, organization.space_id, organization.name,
         organization.normalized_name, organization.status, organization.version
       `,
      [tenantId, workspaceId, organizationId]
    );
    const row = result.rows[0];
    if (!row) throw new Error("Work graph resource is unavailable");
    return {
      id: row.id,
      tenantId,
      workspaceId,
      spaceId: row.space_id,
      name: row.name,
      normalizedName: row.normalized_name,
      domains: row.domains,
      status: row.status,
      version: row.version
    };
  }

  async listOrganizations(
    tenantId: string,
    workspaceId: string,
    permittedSpaceIds: readonly string[],
    ceiling: AccessClass
  ): Promise<Organization[]> {
    if (permittedSpaceIds.length === 0) return [];
    const result = await this.tx.query<{
      id: string;
      space_id: string;
      name: string;
      normalized_name: string;
      status: "active" | "archived";
      version: number;
      domains: string[];
    }>(
      `SELECT organization.id, organization.space_id, organization.name,
              organization.normalized_name, organization.status, organization.version,
              COALESCE(array_agg(domain.domain ORDER BY domain.domain)
                FILTER (WHERE domain.domain IS NOT NULL), ARRAY[]::text[]) AS domains
       FROM work.organizations organization
       JOIN access.spaces space ON space.tenant_id = organization.tenant_id
        AND space.workspace_id = organization.workspace_id AND space.id = organization.space_id
       LEFT JOIN work.organization_domains domain ON domain.tenant_id = organization.tenant_id
        AND domain.workspace_id = organization.workspace_id AND domain.organization_id = organization.id
       WHERE organization.tenant_id = $1 AND organization.workspace_id = $2
         AND organization.space_id = ANY($3::uuid[]) AND space.archived_at IS NULL
         AND CASE space.access_class WHEN 'public' THEN 0 WHEN 'workspace' THEN 1
           WHEN 'restricted' THEN 2 ELSE 3 END <= $4
       GROUP BY organization.id, organization.space_id, organization.name,
         organization.normalized_name, organization.status, organization.version
       ORDER BY organization.name, organization.id`,
      [tenantId, workspaceId, permittedSpaceIds, accessRank(ceiling)]
    );
    return result.rows.map((row) => ({
      id: row.id,
      tenantId,
      workspaceId,
      spaceId: row.space_id,
      name: row.name,
      normalizedName: row.normalized_name,
      status: row.status,
      domains: row.domains,
      version: row.version
    }));
  }

  async getInitiative(
    tenantId: string,
    workspaceId: string,
    initiativeId: string,
    lock = false
  ): Promise<Initiative> {
    const aggregate = await this.tx.query<{
      id: string;
      space_id: string;
      title: string;
      type_key: string;
      stage_key: string;
      health: Initiative["health"];
      owner_person_id: string;
      profile_id: string;
      profile_version: string;
      version: number;
    }>(
      `SELECT id, space_id, title, type_key, stage_key, health, owner_person_id,
              profile_id, profile_version, version
       FROM work.initiatives WHERE tenant_id = $1 AND workspace_id = $2 AND id = $3
       LIMIT 1 ${lock ? "FOR UPDATE" : ""}`,
      [tenantId, workspaceId, initiativeId]
    );
    const row = aggregate.rows[0];
    if (!row) throw new Error("Work graph resource is unavailable");
    const organizations = await this.tx.query<{
      organization_id: string;
      association_role: string;
    }>(
      `SELECT organization_id, association_role FROM work.initiative_organizations
       WHERE tenant_id = $1 AND workspace_id = $2 AND initiative_id = $3 AND ended_at IS NULL
       ORDER BY association_role, organization_id`,
      [tenantId, workspaceId, initiativeId]
    );
    const contributors = await this.tx.query<{ person_id: string }>(
      `SELECT person_id FROM work.initiative_people
       WHERE tenant_id = $1 AND workspace_id = $2 AND initiative_id = $3 AND ended_at IS NULL
       ORDER BY person_id`,
      [tenantId, workspaceId, initiativeId]
    );
    const primary = organizations.rows.find(
      ({ association_role }) => association_role === "primary"
    );
    if (!primary) throw new Error("Work graph resource is unavailable");
    return {
      id: row.id,
      tenantId,
      workspaceId,
      spaceId: row.space_id,
      title: row.title,
      typeKey: row.type_key,
      stageKey: row.stage_key,
      health: row.health,
      ownerPersonId: row.owner_person_id,
      profileId: row.profile_id,
      profileVersion: row.profile_version,
      organizationIds: organizations.rows.map(({ organization_id }) => organization_id),
      primaryOrganizationId: primary.organization_id,
      contributorPersonIds: contributors.rows.map(({ person_id }) => person_id),
      version: row.version
    };
  }

  async getActivity(
    tenantId: string,
    workspaceId: string,
    activityId: string,
    visibility: ActivityAssociationVisibility
  ): Promise<Activity> {
    const aggregate = await this.tx.query<ActivityRow>(
      `SELECT id, space_id, subtype, profile_template_key, title, status, occurred_at,
              starts_at, ends_at, owner_person_id, governing_initiative_id,
              governing_organization_id, version
       FROM work.activities WHERE tenant_id = $1 AND workspace_id = $2 AND id = $3
       LIMIT 1`,
      [tenantId, workspaceId, activityId]
    );
    const row = aggregate.rows[0];
    if (!row) throw new Error("Work graph resource is unavailable");
    return this.projectActivity(tenantId, workspaceId, row, visibility);
  }

  async getActivityScope(
    tenantId: string,
    workspaceId: string,
    activityId: string
  ): Promise<{ spaceId: string }> {
    const result = await this.tx.query<{ space_id: string }>(
      `SELECT space_id FROM work.activities
       WHERE tenant_id = $1 AND workspace_id = $2 AND id = $3 LIMIT 1`,
      [tenantId, workspaceId, activityId]
    );
    const row = result.rows[0];
    if (!row) throw new Error("Work graph resource is unavailable");
    return { spaceId: row.space_id };
  }

  async getActivityAssociationCandidates(
    tenantId: string,
    workspaceId: string,
    activityId: string
  ): Promise<ActivityAssociationVisibility> {
    const result = await this.tx.query<{
      organization_ids: string[];
      initiative_ids: string[];
      person_ids: string[];
    }>(
      `SELECT
         ARRAY(SELECT DISTINCT association.organization_id
           FROM work.activity_organizations association
           WHERE association.tenant_id = activity.tenant_id
             AND association.workspace_id = activity.workspace_id
             AND association.activity_id = activity.id
           ORDER BY association.organization_id) AS organization_ids,
         ARRAY(SELECT DISTINCT association.initiative_id
           FROM work.activity_initiatives association
           WHERE association.tenant_id = activity.tenant_id
             AND association.workspace_id = activity.workspace_id
             AND association.activity_id = activity.id
           ORDER BY association.initiative_id) AS initiative_ids,
         ARRAY(SELECT person_id FROM (
           SELECT activity.owner_person_id AS person_id
           UNION
           SELECT attendee.person_id FROM work.activity_attendees attendee
           WHERE attendee.tenant_id = activity.tenant_id
             AND attendee.workspace_id = activity.workspace_id
             AND attendee.activity_id = activity.id
         ) people ORDER BY person_id) AS person_ids
       FROM work.activities activity
       WHERE activity.tenant_id = $1 AND activity.workspace_id = $2 AND activity.id = $3
       LIMIT 1`,
      [tenantId, workspaceId, activityId]
    );
    const row = result.rows[0];
    if (!row) throw new Error("Work graph resource is unavailable");
    return {
      organizationIds: row.organization_ids,
      initiativeIds: row.initiative_ids,
      personIds: row.person_ids
    };
  }

  async lockActivityForSourceCapture(
    tenantId: string,
    workspaceId: string,
    governingSpaceId: string,
    activityId: string
  ): Promise<Activity> {
    const aggregate = await this.tx.query<ActivityRow>(
      `SELECT activity.id, activity.space_id, activity.subtype,
              activity.profile_template_key, activity.title, activity.status,
              activity.occurred_at, activity.starts_at, activity.ends_at,
              activity.owner_person_id, activity.governing_initiative_id,
              activity.governing_organization_id, activity.version
       FROM work.activities activity
       JOIN access.spaces governing_space
         ON governing_space.tenant_id = activity.tenant_id
        AND governing_space.workspace_id = activity.workspace_id
        AND governing_space.id = activity.space_id
        AND governing_space.archived_at IS NULL
       WHERE activity.tenant_id = $1 AND activity.workspace_id = $2
         AND activity.space_id = $3 AND activity.id = $4
         AND activity.status IN (
           'planned', 'in_progress', 'captured', 'review_pending', 'completed'
         )
       LIMIT 1 FOR SHARE OF activity`,
      [tenantId, workspaceId, governingSpaceId, activityId]
    );
    const row = aggregate.rows[0];
    if (!row) throw new Error("Work graph resource is unavailable");
    return this.projectActivity(tenantId, workspaceId, row);
  }

  private async projectActivity(
    tenantId: string,
    workspaceId: string,
    row: ActivityRow,
    visibility?: ActivityAssociationVisibility
  ): Promise<Activity> {
    const organizations = await this.tx.query<{ organization_id: string }>(
      `SELECT organization_id FROM work.activity_organizations
       WHERE tenant_id = $1 AND workspace_id = $2 AND activity_id = $3
         ${visibility ? "AND organization_id = ANY($4::uuid[])" : ""}
       ORDER BY organization_id`,
      visibility
        ? [tenantId, workspaceId, row.id, [...visibility.organizationIds]]
        : [tenantId, workspaceId, row.id]
    );
    const initiatives = await this.tx.query<{ initiative_id: string }>(
      `SELECT initiative_id FROM work.activity_initiatives
       WHERE tenant_id = $1 AND workspace_id = $2 AND activity_id = $3
         ${visibility ? "AND initiative_id = ANY($4::uuid[])" : ""}
       ORDER BY initiative_id`,
      visibility
        ? [tenantId, workspaceId, row.id, [...visibility.initiativeIds]]
        : [tenantId, workspaceId, row.id]
    );
    const attendees = await this.tx.query<{ person_id: string }>(
      `SELECT person_id FROM work.activity_attendees
       WHERE tenant_id = $1 AND workspace_id = $2 AND activity_id = $3
         ${visibility ? "AND person_id = ANY($4::uuid[])" : ""}
       ORDER BY person_id`,
      visibility
        ? [tenantId, workspaceId, row.id, [...visibility.personIds]]
        : [tenantId, workspaceId, row.id]
    );
    return {
      id: row.id,
      tenantId,
      workspaceId,
      spaceId: row.space_id,
      subtype: row.subtype,
      profileTemplateKey: row.profile_template_key,
      title: row.title,
      status: row.status,
      ...(row.occurred_at === null ? {} : { occurredAt: row.occurred_at.toISOString() }),
      ...(row.starts_at === null ? {} : { startsAt: row.starts_at.toISOString() }),
      ...(row.ends_at === null ? {} : { endsAt: row.ends_at.toISOString() }),
      ...(!visibility || visibility.personIds.includes(row.owner_person_id)
        ? { ownerPersonId: row.owner_person_id }
        : {}),
      ...(row.governing_initiative_id === null ||
      (visibility && !visibility.initiativeIds.includes(row.governing_initiative_id))
        ? {}
        : { governingInitiativeId: row.governing_initiative_id }),
      ...(row.governing_organization_id === null ||
      (visibility && !visibility.organizationIds.includes(row.governing_organization_id))
        ? {}
        : { governingOrganizationId: row.governing_organization_id }),
      organizationIds: organizations.rows.map(({ organization_id }) => organization_id),
      initiativeIds: initiatives.rows.map(({ initiative_id }) => initiative_id),
      attendeePersonIds: attendees.rows.map(({ person_id }) => person_id),
      version: row.version
    };
  }

  async createActivity(input: Activity): Promise<void> {
    await this.tx.query(
      `INSERT INTO work.activities (
         id, tenant_id, workspace_id, space_id, subtype, profile_template_key, title, status,
         occurred_at, starts_at, ends_at, owner_person_id,
         governing_initiative_id, governing_organization_id, version
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,1)`,
      [
        input.id,
        input.tenantId,
        input.workspaceId,
        input.spaceId,
        input.subtype,
        input.profileTemplateKey,
        input.title,
        input.status,
        input.occurredAt ?? null,
        input.startsAt ?? null,
        input.endsAt ?? null,
        input.ownerPersonId,
        input.governingInitiativeId ?? null,
        input.governingOrganizationId ?? null
      ]
    );
    for (const organizationId of input.organizationIds) {
      await this.tx.query(
        `INSERT INTO work.activity_organizations
         (tenant_id, workspace_id, space_id, activity_id, organization_id)
         VALUES ($1,$2,$3,$4,$5)`,
        [input.tenantId, input.workspaceId, input.spaceId, input.id, organizationId]
      );
    }
    for (const initiativeId of input.initiativeIds) {
      await this.tx.query(
        `INSERT INTO work.activity_initiatives
         (tenant_id, workspace_id, space_id, activity_id, initiative_id)
         VALUES ($1,$2,$3,$4,$5)`,
        [input.tenantId, input.workspaceId, input.spaceId, input.id, initiativeId]
      );
    }
    for (const personId of input.attendeePersonIds) {
      await this.tx.query(
        `INSERT INTO work.activity_attendees
         (tenant_id, workspace_id, space_id, activity_id, person_id)
         VALUES ($1,$2,$3,$4,$5)`,
        [input.tenantId, input.workspaceId, input.spaceId, input.id, personId]
      );
    }
  }

  async createRelationship(input: Relationship): Promise<void> {
    await this.tx.query(
      `INSERT INTO work.relationships (
         id, tenant_id, workspace_id, space_id, subject_type, subject_id, predicate,
         object_type, object_id, context_type, context_id, valid_from, version
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,1)`,
      [
        input.id,
        input.tenantId,
        input.workspaceId,
        input.spaceId,
        input.subject.type,
        input.subject.id,
        input.predicate,
        input.object.type,
        input.object.id,
        input.context?.type ?? null,
        input.context?.id ?? null,
        input.validFrom ?? null
      ]
    );
  }

  async getRelationship(
    tenantId: string,
    workspaceId: string,
    relationshipId: string,
    lock = false
  ): Promise<Relationship> {
    const result = await this.tx.query<{
      id: string;
      space_id: string;
      subject_type: B1RelationshipEntityKind;
      subject_id: string;
      predicate: string;
      object_type: B1RelationshipEntityKind;
      object_id: string;
      context_type: B1RelationshipEntityKind | null;
      context_id: string | null;
      valid_from: Date | null;
      valid_to: Date | null;
      version: number;
    }>(
      `SELECT id, space_id, subject_type, subject_id, predicate, object_type, object_id,
              context_type, context_id, valid_from, valid_to, version
       FROM work.relationships
       WHERE tenant_id = $1 AND workspace_id = $2 AND id = $3
       LIMIT 1 ${lock ? "FOR UPDATE" : ""}`,
      [tenantId, workspaceId, relationshipId]
    );
    const row = result.rows[0];
    if (!row) throw new Error("Work graph resource is unavailable");
    return {
      id: row.id,
      tenantId,
      workspaceId,
      spaceId: row.space_id,
      subject: { type: row.subject_type, id: row.subject_id },
      predicate: row.predicate,
      object: { type: row.object_type, id: row.object_id },
      ...(row.context_type === null || row.context_id === null
        ? {}
        : { context: { type: row.context_type, id: row.context_id } }),
      ...(row.valid_from === null ? {} : { validFrom: row.valid_from.toISOString() }),
      ...(row.valid_to === null ? {} : { validTo: row.valid_to.toISOString() }),
      version: row.version
    };
  }

  async endRelationship(input: {
    tenantId: string;
    workspaceId: string;
    relationshipId: string;
    expectedVersion: number;
    validTo: string;
  }): Promise<{ spaceId: string; version: number }> {
    const result = await this.tx.query<{ space_id: string; version: number }>(
      `UPDATE work.relationships
       SET valid_to = $5, version = version + 1, updated_at = clock_timestamp()
       WHERE tenant_id = $1 AND workspace_id = $2 AND id = $3
         AND version = $4 AND valid_to IS NULL
       RETURNING space_id, version`,
      [
        input.tenantId,
        input.workspaceId,
        input.relationshipId,
        input.expectedVersion,
        input.validTo
      ]
    );
    const row = result.rows[0];
    if (!row) throw new Error("Relationship version precondition failed");
    return { spaceId: row.space_id, version: row.version };
  }

  async resolveEndpoint(
    tenantId: string,
    workspaceId: string,
    endpoint: RelationshipEndpoint
  ): Promise<SpaceBearingEndpoint | undefined> {
    const result = await this.tx.query<{
      endpoint_found: boolean;
      resolved_space_id: string | null;
    }>(
      `SELECT endpoint_found, resolved_space_id
       FROM work.resolve_relationship_endpoint($1,$2,$3,$4)`,
      [endpoint.type, endpoint.id, tenantId, workspaceId]
    );
    const row = result.rows[0];
    if (!row?.endpoint_found) return undefined;
    let accessClass: AccessClass = "workspace";
    if (row.resolved_space_id) {
      accessClass = (await this.getSpace(tenantId, workspaceId, row.resolved_space_id)).accessClass;
    }
    return {
      tenantId,
      workspaceId,
      ...(row.resolved_space_id === null ? {} : { spaceId: row.resolved_space_id }),
      accessClass
    };
  }

  async getSafePeople(
    tenantId: string,
    workspaceId: string,
    personIds: readonly string[]
  ): Promise<SafePersonProjection[]> {
    if (personIds.length === 0) return [];
    const result = await this.tx.query<{
      id: string;
      display_name: string;
      is_internal: boolean;
    }>(
      `SELECT id, display_name, is_internal FROM identity.people
       WHERE tenant_id = $1 AND workspace_id = $2 AND id = ANY($3::uuid[])
       ORDER BY id`,
      [tenantId, workspaceId, personIds]
    );
    if (result.rows.length !== new Set(personIds).size) {
      throw new Error("Person projection is unavailable");
    }
    return result.rows.map((row) => ({
      id: row.id,
      displayName: row.display_name,
      isInternal: row.is_internal
    }));
  }
}

export function relationshipEndpointKind(value: string): B1RelationshipEntityKind {
  if (!["space", "person", "organization", "initiative", "activity", "content"].includes(value)) {
    throw new Error("Relationship endpoint is not implemented in B1");
  }
  return value as B1RelationshipEntityKind;
}

function accessRank(value: AccessClass): number {
  return { public: 0, workspace: 1, restricted: 2, confidential: 3 }[value];
}
