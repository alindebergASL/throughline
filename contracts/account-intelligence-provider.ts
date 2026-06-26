/**
 * Throughline Account Intelligence Provider contract v0.1
 * Read-only. All data is provenance-bearing and is mapped to SourceArtifacts
 * and provider-attributed Claims. It must never create AcceptedFacts directly.
 */
export type AccessClass = 'public' | 'workspace' | 'restricted' | 'confidential';
export type Confidence = 'confirmed' | 'strong' | 'weak' | 'unknown';

export interface ProvenanceEnvelope {
  sourceSystem: string;
  externalId?: string;
  sourceRef?: string;
  retrievedAt: string;
  providerVersion: string;
  schemaVersion: string;
  adapterVersion: string;
  confidence: Confidence;
  freshness?: { observedAt?: string; expiresAt?: string };
  accessClass: AccessClass;
}

export type Provenanced<T> = { data: T; provenance: ProvenanceEnvelope };

export interface OrganizationMatch {
  externalRef: string;
  name: string;
  domains: string[];
  matchScore?: number;
}

export interface ExternalOrganizationProfile {
  externalRef: string;
  name: string;
  domains: string[];
  description?: string;
  attributes: Record<string, unknown>;
}

export interface ExternalPerson {
  externalRef: string;
  name: string;
  title?: string;
  email?: string;
  attributes?: Record<string, unknown>;
}

export interface ExternalInitiative {
  externalRef: string;
  title: string;
  summary?: string;
  status?: string;
  attributes?: Record<string, unknown>;
}

export interface ExternalSignal {
  externalRef: string;
  title: string;
  summary: string;
  observedAt?: string;
  sourceRefs: string[];
}

export interface ExternalReadinessSignal {
  dimensionHint?: string;
  statement: string;
  sourceRefs: string[];
}

export interface ExternalSourceCitation {
  externalRef: string;
  title?: string;
  uri?: string;
  publisher?: string;
  publishedAt?: string;
}

export interface AccountIntelligenceProvider {
  searchOrganizations(input: { query: string; limit?: number }): Promise<Provenanced<OrganizationMatch[]>>;
  resolveOrganization(input: { externalRef?: string; domain?: string; name?: string }): Promise<Provenanced<OrganizationMatch | null>>;
  getOrganizationProfile(input: { organizationRef: string }): Promise<Provenanced<ExternalOrganizationProfile>>;
  getPeople(input: { organizationRef: string }): Promise<Provenanced<ExternalPerson[]>>;
  getKnownInitiatives(input: { organizationRef: string }): Promise<Provenanced<ExternalInitiative[]>>;
  getSignals(input: { organizationRef: string; since?: string }): Promise<Provenanced<ExternalSignal[]>>;
  getReadinessSignals(input: { organizationRef: string }): Promise<Provenanced<ExternalReadinessSignal[]>>;
  getSources(input: { organizationRef: string }): Promise<Provenanced<ExternalSourceCitation[]>>;
  getProviderMetadata(): Promise<{ provider: string; version: string; schemaVersion: string }>;
  getLastRefresh(input: { organizationRef: string }): Promise<{ refreshedAt: string }>;
}
