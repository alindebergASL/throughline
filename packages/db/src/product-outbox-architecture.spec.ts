import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

describe("ProductOutboxRepository architecture boundary", () => {
  it("uses a server-owned immutable handle and exact bounded retry schedule", async () => {
    const source = await readFile(
      new URL("./product-outbox-repository.ts", import.meta.url),
      "utf8"
    );
    expect(source).toContain("new WeakSet<object>()");
    expect(source).toContain("deepFreeze({");
    expect(source).toContain("const RETRY_DELAYS_SECONDS = [1, 5, 30, 120, 600]");
    expect(source).toContain("publicationAttempt < 6");
    expect(source).toContain('"terminal_failed" : "terminal_unconfirmed"');
  });

  it("persists one millisecond claim clock while retaining exact handle equality", async () => {
    const source = await readFile(
      new URL("./product-outbox-repository.ts", import.meta.url),
      "utf8"
    );
    const claimStatement = source.slice(
      source.indexOf("const claimed = await"),
      source.indexOf("async publishClaimed(")
    );

    expect(claimStatement).toContain("WITH claim_clock AS MATERIALIZED");
    expect(claimStatement).toContain("date_trunc('milliseconds', clock_timestamp()) AS claimed_at");
    expect(claimStatement.match(/clock_timestamp\(\)/g)).toHaveLength(1);
    expect(claimStatement).toContain("claimed_at = eligible.claimed_at");
    expect(claimStatement).toContain(
      "claim_expires_at = eligible.claimed_at + ($8 * interval '1 second')"
    );
    expect(source.match(/claim_expires_at = \$10::timestamptz/g)).toHaveLength(4);
    expect(source).toContain("row.claimed_at.toISOString() === handle.claimedAt");
    expect(source).toContain("row.claim_expires_at.toISOString() === handle.claimExpiresAt");
  });

  it("locks the exact claimed row before transaction-local central reauthorization", async () => {
    const source = await readFile(
      new URL("./product-outbox-repository.ts", import.meta.url),
      "utf8"
    );
    const rowLock = source.indexOf(
      "FROM ops.product_outbox_events",
      source.indexOf("publishClaimed(")
    );
    const forUpdate = source.indexOf("FOR UPDATE", rowLock);
    const authorization = source.indexOf("this.authorization.canInTransaction", forUpdate);
    const send = source.indexOf("publisher.publish", authorization);
    const marker = source.indexOf("SET publication_state = 'published'", send);
    expect(rowLock).toBeGreaterThan(0);
    expect(forUpdate).toBeGreaterThan(rowLock);
    expect(authorization).toBeGreaterThan(forUpdate);
    expect(send).toBeGreaterThan(authorization);
    expect(marker).toBeGreaterThan(send);
  });

  it("contains no generic SQL callback, worker context, consumer, or Foundation claim filter", async () => {
    const source = await readFile(
      new URL("./product-outbox-repository.ts", import.meta.url),
      "utf8"
    );
    expect(source).not.toMatch(/queryCallback|executeSql|arbitrarySql|callerSql/);
    expect(source).not.toMatch(/job_id|context_reference|foundation\.proof|ops\.outbox_events/);
    expect(source).not.toMatch(/ReceiveMessage|DeleteMessage|ChangeMessageVisibility/);
  });
});
