import { randomBytes } from "node:crypto";

const ADMIN_TOKEN_ENV = "LLM_SIDECAR_ADMIN_TOKEN";

/** Generates a random admin token for proxy reload authentication. */
export const generateAdminToken = (): string =>
  randomBytes(32).toString("hex");

/** Returns the admin token from the environment, if set. */
export const readAdminTokenFromEnv = (): string | undefined =>
  process.env[ADMIN_TOKEN_ENV]?.trim() || undefined;

/** Sets the admin token in the child process environment. */
export const withAdminTokenEnv = (
  env: NodeJS.ProcessEnv,
  token: string
): NodeJS.ProcessEnv => ({
  ...env,
  [ADMIN_TOKEN_ENV]: token,
});

export const ADMIN_TOKEN_HEADER = "x-llm-sidecar-admin-token";
