export const FOUNDATION_PROOF_POOL = Symbol("FOUNDATION_PROOF_POOL");
export const FOUNDATION_PROOF_AUTHORIZATION = Symbol("FOUNDATION_PROOF_AUTHORIZATION");
export const FOUNDATION_PROOF_CODEC = Symbol("FOUNDATION_PROOF_CODEC");
export const FOUNDATION_PROOF_OPTIONS = Symbol("FOUNDATION_PROOF_OPTIONS");

export interface FoundationProofRuntimeOptions {
  relayServicePrincipalId: string;
  workerServicePrincipalId: string;
  uuidV7: () => string;
}
