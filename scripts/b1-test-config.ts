import { parseB10TestEnv, type B10TestConfig } from "./b1-0-test-config.js";

export type B1TestConfig = B10TestConfig;

export function parseB1TestEnv(environment: Record<string, string | undefined>): B1TestConfig {
  return parseB10TestEnv(environment);
}
