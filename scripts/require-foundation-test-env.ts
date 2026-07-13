import {
  FoundationTestConfigError,
  foundationTestConfigErrorMessage,
  parseFoundationTestEnv
} from "./foundation-test-config.js";

try {
  parseFoundationTestEnv(process.env);
} catch (error) {
  const code =
    error instanceof FoundationTestConfigError ? error.code : "INVALID_VERIFICATION_KEY_MAP";
  console.error(
    `Foundation test preflight failed [${code}]: ${foundationTestConfigErrorMessage(code)}`
  );
  process.exitCode = 1;
}
