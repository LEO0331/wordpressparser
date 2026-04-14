const DEFAULT_TIMEOUT_MS = 15000;
const TRUE_VALUES = new Set(["1", "true", "yes", "on"]);

function isTrue(value) {
  return TRUE_VALUES.has(String(value || "").trim().toLowerCase());
}

function normalizeBaseUrl(input, allowInsecureHttp = false) {
  const url = new URL(input);
  if (url.protocol === "https:") {
    return `${url.protocol}//${url.host}`;
  }
  if (url.protocol === "http:" && allowInsecureHttp) {
    return `${url.protocol}//${url.host}`;
  }
  if (url.protocol === "http:") {
    throw new Error(
      "WP_BASE_URL must use https. For local-only testing, set WP_ALLOW_INSECURE_HTTP=true."
    );
  }
  throw new Error("WP_BASE_URL must use https protocol.");
}

export function loadMcpConfig(env = process.env) {
  const baseUrlRaw = String(env.WP_BASE_URL || "").trim();
  const username = String(env.WP_USERNAME || "").trim();
  const appPassword = String(env.WP_APP_PASSWORD || "").trim();
  const preferredVersion = String(env.WP_API_VERSION || "v2").trim();
  const timeoutMs = Number(env.WP_TIMEOUT_MS || DEFAULT_TIMEOUT_MS);
  const allowInsecureHttp = isTrue(env.WP_ALLOW_INSECURE_HTTP);

  return {
    baseUrl: baseUrlRaw ? normalizeBaseUrl(baseUrlRaw, allowInsecureHttp) : "",
    username,
    appPassword,
    preferredVersion,
    timeoutMs: Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : DEFAULT_TIMEOUT_MS,
    allowInsecureHttp
  };
}

export function assertConfigured(config) {
  if (!config.baseUrl || !config.username || !config.appPassword) {
    throw new Error(
      "Missing WordPress credentials. Set WP_BASE_URL, WP_USERNAME, and WP_APP_PASSWORD."
    );
  }
}
