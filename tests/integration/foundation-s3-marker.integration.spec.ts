import { randomUUID } from "node:crypto";

import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client
} from "@aws-sdk/client-s3";
import { afterAll, describe, expect, it } from "vitest";
import { parseFoundationTestEnv } from "../../scripts/foundation-test-config.js";
import { buildScopedObjectKey } from "../../packages/tenancy/src/scoped-resource-keys.js";

const explicitLocalAwsEnvironment = {
  endpoint: process.env.FOUNDATION_SQS_ENDPOINT,
  bucket: process.env.FOUNDATION_S3_BUCKET,
  accessKeyId: process.env.AWS_ACCESS_KEY_ID,
  secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY
};
const config = parseFoundationTestEnv(process.env);
const s3 = new S3Client({
  endpoint: config.localstack.endpoint,
  region: config.localstack.region,
  credentials: config.localstack.credentials,
  forcePathStyle: true
});

describe.sequential("Foundation scoped S3 marker integration", () => {
  const scope = {
    tenantId: randomUUID(),
    workspaceId: randomUUID(),
    spaceId: randomUUID()
  };
  const resourceId = randomUUID();
  const alternateResourceId = randomUUID();
  const marker = randomUUID();
  const key = buildScopedObjectKey(scope, {
    ...scope,
    resourceType: "foundation-test-marker",
    resourceId
  });
  const alternateKey = buildScopedObjectKey(scope, {
    ...scope,
    resourceType: "foundation-test-marker",
    resourceId: alternateResourceId
  });
  const exactScopePrefix = `tenant/${scope.tenantId}/workspace/${scope.workspaceId}/space/${scope.spaceId}/`;

  afterAll(async () => {
    await s3
      .send(new DeleteObjectCommand({ Bucket: config.localstack.bucket, Key: key }))
      .catch(() => undefined);
    s3.destroy();
  });

  it("puts, reads, and removes only the exact generated scoped marker", async () => {
    expect(explicitLocalAwsEnvironment).toEqual({
      endpoint: config.localstack.endpoint,
      bucket: config.localstack.bucket,
      accessKeyId: config.localstack.credentials.accessKeyId,
      secretAccessKey: config.localstack.credentials.secretAccessKey
    });
    expect(config.localstack.endpoint).toMatch(
      /^https?:\/\/(?:127\.0\.0\.1|localhost|\[::1\])(?::\d+)?$/
    );
    expect(key.startsWith(exactScopePrefix)).toBe(true);
    expect(alternateKey).not.toBe(key);

    await s3.send(
      new PutObjectCommand({
        Bucket: config.localstack.bucket,
        Key: key,
        Body: marker,
        ContentType: "text/plain"
      })
    );

    await expect(
      s3.send(new HeadObjectCommand({ Bucket: config.localstack.bucket, Key: key }))
    ).resolves.toMatchObject({ ContentLength: Buffer.byteLength(marker) });
    const fetched = await s3.send(
      new GetObjectCommand({ Bucket: config.localstack.bucket, Key: key })
    );
    await expect(fetched.Body?.transformToString()).resolves.toBe(marker);
    await expect(
      s3.send(new HeadObjectCommand({ Bucket: config.localstack.bucket, Key: alternateKey }))
    ).rejects.toMatchObject({ $metadata: { httpStatusCode: 404 } });

    await s3.send(new DeleteObjectCommand({ Bucket: config.localstack.bucket, Key: key }));
    await expect(
      s3.send(new HeadObjectCommand({ Bucket: config.localstack.bucket, Key: key }))
    ).rejects.toMatchObject({ $metadata: { httpStatusCode: 404 } });
  });
});
