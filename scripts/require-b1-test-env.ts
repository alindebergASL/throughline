import { B10TestConfigError, b10TestConfigErrorMessage } from "./b1-0-test-config.js";
import { parseB1TestEnv } from "./b1-test-config.js";

try {
  parseB1TestEnv(process.env);
} catch (error) {
  const code = error instanceof B10TestConfigError ? error.code : "MALFORMED_URL";
  console.error(`B1 test preflight failed [${code}]: ${b10TestConfigErrorMessage(code)}`);
  process.exitCode = 1;
}
