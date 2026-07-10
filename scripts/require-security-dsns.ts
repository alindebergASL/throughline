const requiredVariables = ["TEST_DATABASE_URL", "TEST_APP_DATABASE_URL"] as const;
const missingVariables = requiredVariables.filter(
  (name) => !process.env[name] || process.env[name]?.trim() === ""
);

if (missingVariables.length > 0) {
  console.error(
    `test:security requires explicit ${requiredVariables.join(
      " and "
    )}; missing ${missingVariables.join(", ")}`
  );
  process.exitCode = 1;
}
