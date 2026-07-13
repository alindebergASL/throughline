import { describe, expect, it } from "vitest";
import {
  buildScopedCacheKey,
  buildScopedObjectKey,
  buildScopedQueueKey
} from "./scoped-resource-keys.js";

const scope = {
  tenantId: "11111111-1111-4111-8111-111111111111",
  workspaceId: "11111111-1111-4111-8111-111111111112",
  spaceId: "11111111-1111-4111-8111-111111111113"
} as const;

const resource = {
  ...scope,
  resourceType: "foundation-proof",
  resourceId: "11111111-1111-4111-8111-111111111114"
} as const;

describe("scoped infrastructure keys", () => {
  it("builds deterministic queue, cache, and object keys with the complete scope", () => {
    expect(buildScopedQueueKey(scope)).toBe(
      "tenant/11111111-1111-4111-8111-111111111111/workspace/11111111-1111-4111-8111-111111111112/space/11111111-1111-4111-8111-111111111113"
    );
    expect(buildScopedCacheKey(scope, resource)).toBe(
      "tenant:11111111-1111-4111-8111-111111111111:workspace:11111111-1111-4111-8111-111111111112:space:11111111-1111-4111-8111-111111111113:foundation-proof:11111111-1111-4111-8111-111111111114"
    );
    expect(buildScopedObjectKey(scope, resource)).toBe(
      "tenant/11111111-1111-4111-8111-111111111111/workspace/11111111-1111-4111-8111-111111111112/space/11111111-1111-4111-8111-111111111113/foundation-proof/11111111-1111-4111-8111-111111111114"
    );
  });

  it.each(["tenantId", "workspaceId", "spaceId"] as const)("rejects an empty %s", (field) => {
    expect(() => buildScopedQueueKey({ ...scope, [field]: "" })).toThrow(/identifier/i);
  });

  it.each([
    "not-a-uuid",
    "../11111111-1111-4111-8111-111111111111",
    "11111111-1111-4111-8111-111111111111/child",
    "https://example.com/resource",
    "s3://foundation-bucket/object",
    "arn:aws:s3:::foundation-bucket",
    "s3.amazonaws.com",
    "127.0.0.1",
    "localhost"
  ])("rejects malformed or infrastructure-shaped scope identifier %s", (identifier) => {
    expect(() => buildScopedQueueKey({ ...scope, tenantId: identifier })).toThrow(/identifier/i);
  });

  it.each(["tenantId", "workspaceId", "spaceId"] as const)(
    "rejects a resource with a mismatched %s",
    (field) => {
      const crossScopeResource = {
        ...resource,
        [field]: "22222222-2222-4222-8222-222222222222"
      };

      expect(() => buildScopedCacheKey(scope, crossScopeResource)).toThrow(/scope/i);
      expect(() => buildScopedObjectKey(scope, crossScopeResource)).toThrow(/scope/i);
    }
  );

  it.each([
    ["resourceType", ""],
    ["resourceType", "../proof"],
    ["resourceType", "proof/item"],
    ["resourceType", "https://example.com"],
    ["resourceType", "arn:aws:sqs:us-east-1:000000000000:proof"],
    ["resourceType", "queue.amazonaws.com"],
    ["resourceType", "localhost"],
    ["resourceId", ""],
    ["resourceId", "../marker"],
    ["resourceId", "marker/value"],
    ["resourceId", "https://example.com/marker"],
    ["resourceId", "s3://foundation-bucket/marker"],
    ["resourceId", "cache.internal.example"],
    ["resourceId", "127.0.0.1"]
  ] as const)("rejects unsafe %s value %s", (field, value) => {
    const malformedResource = { ...resource, [field]: value };

    expect(() => buildScopedCacheKey(scope, malformedResource)).toThrow(/segment/i);
    expect(() => buildScopedObjectKey(scope, malformedResource)).toThrow(/segment/i);
  });

  it("rejects ambiguous separators instead of normalizing them", () => {
    expect(() =>
      buildScopedCacheKey(scope, { ...resource, resourceType: "foundation:proof" })
    ).toThrow(/segment/i);
    expect(() =>
      buildScopedObjectKey(scope, { ...resource, resourceId: "foundation%2Fmarker" })
    ).toThrow(/segment/i);
  });
});
