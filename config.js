/*
 * Public browser configuration. Do not place secrets in this file.
 * Use "/api" when the Cloudflare Worker is routed on the same custom domain.
 * For a separate Worker hostname, use its full URL, for example:
 * "https://peso-attachments-api.example.workers.dev/api"
 */
window.PESO_CONFIG = Object.freeze({
  apiBaseUrl: '/api',
  requestTimeoutMs: 20000
});
