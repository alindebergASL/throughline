import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

describe("canonical Wave A2 migration", () => {
  it("configures throughline_app without embedding a login credential", async () => {
    const sql = await readFile(
      new URL("../migrations/0001_wave_a2_identity_access_rls.sql", import.meta.url),
      "utf8"
    );

    expect(sql).toContain(
      "NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD NULL"
    );
    expect(sql).toContain("NOBYPASSRLS");
    expect(sql).not.toMatch(/PASSWORD\s+'[^']+'/i);
  });
});
