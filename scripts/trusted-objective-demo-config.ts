export const TRUSTED_OBJECTIVE_DEMO_DATABASE = "throughline_demo";

export const trustedObjectiveDemoFixtures = Object.freeze({
  organizationSpaceId: "70000000-0000-7000-8000-000000000201",
  organizationId: "70000000-0000-7000-8000-000000000202",
  initiativeSpaceId: "70000000-0000-7000-8000-000000000203",
  initiativeId: "70000000-0000-7000-8000-000000000204",
  activityId: "70000000-0000-7000-8000-000000000205"
});

export function parseDemoAdminUrl(value: string | undefined): URL {
  if (!value) throw new Error("DEMO_ADMIN_DATABASE_URL is required");
  const url = new URL(value);
  if (
    !["postgres:", "postgresql:"].includes(url.protocol) ||
    !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) ||
    decodeURIComponent(url.username) === "throughline_app" ||
    url.pathname.slice(1) === TRUSTED_OBJECTIVE_DEMO_DATABASE
  ) {
    throw new Error("Demo setup requires a loopback admin URL connected outside throughline_demo");
  }
  return url;
}

export function demoDatabaseUrl(admin: URL, username?: string, password?: string): string {
  const result = new URL(admin);
  result.pathname = `/${TRUSTED_OBJECTIVE_DEMO_DATABASE}`;
  if (username !== undefined) result.username = username;
  if (password !== undefined) result.password = password;
  return result.toString();
}
