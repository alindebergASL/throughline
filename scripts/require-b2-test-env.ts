const required = ["TEST_DATABASE_URL", "TEST_APP_DATABASE_URL"] as const;

if (process.env.B2_AUTHORITATIVE_GATE !== "1") {
  throw new Error("test:b2 requires B2_AUTHORITATIVE_GATE=1");
}

const missing = required.filter((name) => !process.env[name]?.trim());
if (missing.length > 0) {
  throw new Error(`test:b2 requires ${missing.join(" and ")}`);
}
