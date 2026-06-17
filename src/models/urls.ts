import type { EndpointConfig } from "../config/schema.ts";

const CHAT_COMPLETIONS_SUFFIX = "/chat/completions";

/** Ensures upstream URLs end with /chat/completions for OpenAI-compatible providers. */
export const normalizeUpstreamChatUrl = (upstreamUrl: string): string => {
  const trimmed = upstreamUrl.trim().replace(/\/+$/, "");
  if (!trimmed) {
    return trimmed;
  }
  if (
    trimmed.includes("/chat/completions") ||
    trimmed.endsWith("/completions")
  ) {
    return trimmed;
  }
  if (
    trimmed.endsWith("/openai") ||
    trimmed.endsWith("/v1beta/openai") ||
    trimmed.endsWith("/v1beta") ||
    /\/v\d+$/.test(trimmed)
  ) {
    return `${trimmed}/chat/completions`;
  }
  return `${trimmed}/v1/chat/completions`;
};

/** Apply pathname rules to derive a sibling models list path. */
export const deriveModelsPathname = (pathname: string): string => {
  let path = pathname.replace(/\/+$/, "") || "/";

  if (path.endsWith(CHAT_COMPLETIONS_SUFFIX)) {
    return `${path.slice(0, -CHAT_COMPLETIONS_SUFFIX.length)}/models`;
  }
  if (path.endsWith("/openai")) {
    return `${path}/models`;
  }
  if (path.endsWith("/v1beta/openai")) {
    return `${path}/models`;
  }
  if (path.endsWith("/v1beta")) {
    return `${path}/openai/models`;
  }
  if (path.endsWith("/v1")) {
    return `${path}/models`;
  }

  const lastSlash = path.lastIndexOf("/");
  if (lastSlash > 0) {
    return `${path.slice(0, lastSlash + 1)}models`;
  }
  return `${path}/models`;
};

/** Derive OpenAI-style GET models URL from chat completions upstream URL. */
export const deriveModelsUrl = (upstreamUrl: string): string => {
  try {
    const url = new URL(upstreamUrl);
    url.search = "";
    url.hash = "";
    url.pathname = deriveModelsPathname(url.pathname);
    return url.toString().replace(/\/+$/, "");
  } catch {
    const trimmed = upstreamUrl.replace(/\/+$/, "").split("?")[0]?.split("#")[0] ?? upstreamUrl;
    if (trimmed.endsWith(CHAT_COMPLETIONS_SUFFIX)) {
      return `${trimmed.slice(0, -CHAT_COMPLETIONS_SUFFIX.length)}/models`;
    }
    if (trimmed.endsWith("/openai") || trimmed.endsWith("/v1beta/openai")) {
      return `${trimmed}/models`;
    }
    if (trimmed.endsWith("/v1beta")) {
      return `${trimmed}/openai/models`;
    }
    if (trimmed.endsWith("/v1")) {
      return `${trimmed}/models`;
    }
    return `${trimmed}/models`;
  }
};

export const resolveModelsUrl = (endpoint: EndpointConfig): string =>
  endpoint.discoverModels?.modelsUrl?.trim() ||
  deriveModelsUrl(endpoint.upstreamUrl);

export const isDiscoveryEnabled = (endpoint: EndpointConfig): boolean => {
  const explicit = endpoint.discoverModels?.enabled;
  if (explicit !== undefined) {
    return explicit;
  }
  return (endpoint.models?.length ?? 0) === 0;
};

export const discoveryTtlMinutes = (endpoint: EndpointConfig): number =>
  endpoint.discoverModels?.ttlMinutes ?? 60;

export const shouldRefreshOnActivate = (endpoint: EndpointConfig): boolean =>
  endpoint.discoverModels?.refreshOnActivate ?? true;
