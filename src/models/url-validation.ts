const PRIVATE_HOSTS = new Set([
  "localhost",
  "127.0.0.1",
  "::1",
  "0.0.0.0",
]);

/** Returns true when the URL is safe for discovery fetches (https, non-private host). */
export const isDiscoveryUrlAllowed = (raw: string): boolean => {
  try {
    const parsed = new URL(raw.trim());
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
      return false;
    }
    const host = parsed.hostname.toLowerCase();
    if (PRIVATE_HOSTS.has(host)) {
      return false;
    }
    if (
      host.startsWith("10.") ||
      host.startsWith("192.168.") ||
      /^172\.(1[6-9]|2\d|3[01])\./.test(host)
    ) {
      return false;
    }
    if (host.endsWith(".local") || host === "metadata.google.internal") {
      return false;
    }
    return true;
  } catch {
    return false;
  }
};
