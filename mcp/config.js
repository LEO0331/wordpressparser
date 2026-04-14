const DEFAULT_TIMEOUT_MS = 15000;

function normalizeBaseUrl(input) {
  const url = new URL(input);
  if (!/^https?:$/.test(url.protocol)) {
    throw new Error("WP_BASE_URL must use http or https protocol.");
  }
  return `${url.protocol}//${url.host}`;
}

export function loadMcpConfig(env = process.env) {
  const baseUrlRaw = String(env.WP_BASE_URL || "").trim();
  const username = String(env.WP_USERNAME || "").trim();
  const appPassword = String(env.WP_APP_PASSWORD || "").trim();
  const preferredVersion = String(env.WP_API_VERSION || "v2").trim();
  const timeoutMs = Number(env.WP_TIMEOUT_MS || DEFAULT_TIMEOUT_MS);

  return {
    baseUrl: baseUrlRaw ? normalizeBaseUrl(baseUrlRaw) : "",
    username,
    appPassword,
    preferredVersion,
    timeoutMs: Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : DEFAULT_TIMEOUT_MS
  };
}

export function assertConfigured(config) {
  if (!config.baseUrl || !config.username || !config.appPassword) {
    throw new Error(
      "Missing WordPress credentials. Set WP_BASE_URL, WP_USERNAME, and WP_APP_PASSWORD."
    );
  }
}
