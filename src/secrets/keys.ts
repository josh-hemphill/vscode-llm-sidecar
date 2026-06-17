import type { EndpointConfig } from "../config/schema.ts";

/** Default SecretStorage key for an endpoint upstream API key. */
export const defaultEndpointSecretId = (endpointId: string): string =>
  `llmSidecar.endpoint.${endpointId}`;

export const resolveEndpointSecretId = (endpoint: EndpointConfig): string =>
  endpoint.apiKeySecretId?.trim() || defaultEndpointSecretId(endpoint.id);

/** VS Code chat.lm.secret.* placeholder id written into chatLanguageModels.json. */
export const buildCopilotByokSecretPlaceholder = (secretId: string): string =>
  `\${input:chat.lm.secret.${secretId}}`;
