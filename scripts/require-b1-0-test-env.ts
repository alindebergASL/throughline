import {
  B10TestConfigError,
  b10TestConfigErrorMessage,
  parseB10TestEnv
} from "./b1-0-test-config.js";

try {
  parseB10TestEnv(process.env);
} catch (error) {
  const code = error instanceof B10TestConfigError ? error.code : "MALFORMED_URL";
  console.error(`B1.0 test preflight failed [${code}]: ${b10TestConfigErrorMessage(code)}`);
  process.exitCode = 1;
}
