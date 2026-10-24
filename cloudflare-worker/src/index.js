let accessKeysCache = null;
let accessKeysExpiresAt = 0;

export default {
  async fetch(request, env) {
    const origin = request.headers.get('Origin');
    const cors = corsHeaders(origin, env);

    if (request.method === 'OPTIONS') {
      if (!originAllowed(origin, env)) return json({ok: false, error: 'Origin is not allowed.'}, 403, cors);
      return new Response(null, {status: 204, headers: cors});
    }

    if (!originAllowed(origin, env)) return json({ok: false, error: 'Origin is not allowed.'}, 403, cors);

    try {
      requireConfiguration(env);
      const user = await resolveRequestUser(request, env);

      if (env.API_RATE_LIMITER) {
        const limit = await env.API_RATE_LIMITER.limit({key: user.rateLimitKey || user.email});
        if (!limit.success) return json({ok: false, error: 'Too many requests. Please wait and try again.'}, 429, cors);
      }

      const url = new URL(request.url);
      const transactionMatch = url.pathname.match(/^\/api\/transactions\/([^/]+)$/);
      let backendRequest;

      if (request.method === 'POST' && url.pathname === '/api/post-travel-report/generate') {
        if (!isAccessRequired(env)) throw httpError(403, 'AI report generation requires Cloudflare Access authentication.');
        if (!env.AI) throw httpError(503, 'AI report generation is not enabled. Configure the Workers AI binding first.');
        const transaction = await readJsonBody(request);
        const report = await generatePostTravelReport(transaction, env);
        return json({ok: true, data: {report}}, 200, cors);
      } else if (request.method === 'GET' && url.pathname === '/api/health') {
        backendRequest = {action: 'health'};
      } else if (request.method === 'GET' && url.pathname === '/api/bootstrap') {
        backendRequest = {action: 'getBootstrap'};
      } else if (request.method === 'GET' && url.pathname === '/api/transactions') {
        backendRequest = {action: 'listTransactions'};
      } else if (request.method === 'GET' && transactionMatch) {
        backendRequest = {action: 'getTransaction', id: decodeURIComponent(transactionMatch[1])};
      } else if (request.method === 'POST' && url.pathname === '/api/transactions') {
        backendRequest = {action: 'upsertTransaction', transaction: await readJsonBody(request)};
      } else if (request.method === 'DELETE' && transactionMatch) {
        backendRequest = {action: 'deleteTransaction', id: decodeURIComponent(transactionMatch[1])};
      } else if (request.method === 'GET' && url.pathname === '/api/settings') {
        backendRequest = {action: 'getSettings'};
      } else if (request.method === 'PUT' && url.pathname === '/api/settings') {
        backendRequest = {action: 'saveSettings', settings: await readJsonBody(request)};
      } else {
        return json({ok: false, error: 'API route not found.'}, 404, cors);
      }

      const result = await callAppsScript(backendRequest, user.email, env);
      return json(result, result.ok ? 200 : backendStatus(result.error), cors);
    } catch (error) {
      const status = error.status || 500;
      const message = status >= 500 ? 'The API gateway could not complete the request.' : error.message;
      return json({ok: false, error: message}, status, cors);
    }
  }
};

async function generatePostTravelReport(transaction, env) {
  const safe = {
    personnel: textField(transaction.personnel || transaction.payee, 200),
    position: textField(transaction.position, 200),
    office: textField(transaction.office, 200),
    travelFrom: textField(transaction.travelFrom, 100),
    travelTo: textField(transaction.travelTo, 100),
    destination: textField(transaction.destination, 500),
    purpose: textField(transaction.purpose, 1000),
    itinerary: Array.isArray(transaction.itinerary) ? transaction.itinerary.slice(0, 30).map(row => ({
      date: textField(row && row.dateRange, 100),
      from: textField(row && row.from, 200),
      to: textField(row && row.to, 200),
      means: textField(row && row.means, 80)
    })) : []
  };
  const prompt = `Draft a concise Philippine local-government post-travel report using only the verified facts in the JSON below. Never invent specific events, people, dates, approvals, certificates, outputs, or attachments. If the facts do not support a detail, use an empty string for that section. Return only valid JSON with these string keys: summary, activities, accomplishments, issues, recommendations, attachments. Activities and accomplishments may be cautious general statements directly supported by the stated purpose; use bullet lines separated by newline. If no verified issue or attachment is stated, leave it blank. Recommendations may say to share and apply the knowledge gained when the purpose indicates a training, meeting, or conference. Do not repeat private information beyond the report fields.\n\nVerified transaction data:\n${JSON.stringify(safe)}`;
  const result = await env.AI.run('@cf/meta/llama-3.1-8b-instruct-fp8', {
    messages: [
      {role: 'system', content: 'You draft factual administrative reports. Follow the requested JSON format and do not invent facts.'},
      {role: 'user', content: prompt}
    ],
    max_tokens: 900,
    temperature: 0.2
  });
  const output = typeof result?.response === 'string' ? result.response : '';
  const jsonText = output.match(/\{[\s\S]*\}/)?.[0];
  if (!jsonText) throw httpError(502, 'The AI service returned an incomplete report. Please try again.');
  let parsed;
  try { parsed = JSON.parse(jsonText); } catch { throw httpError(502, 'The AI service returned an unreadable report. Please try again.'); }
  const fields = ['summary', 'activities', 'accomplishments', 'issues', 'recommendations', 'attachments'];
  return Object.fromEntries(fields.map(field => [field, textField(parsed[field], 2500)]));
}

function textField(value, maxLength) {
  return String(value == null ? '' : value).replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, maxLength);
}

function requireConfiguration(env) {
  const required = ['APPS_SCRIPT_URL', 'GATEWAY_SECRET', 'ALLOWED_ORIGIN'];
  if (isAccessRequired(env)) required.push('ACCESS_TEAM_DOMAIN', 'ACCESS_AUD');
  if (required.some(key => !env[key])) throw httpError(500, 'Worker configuration is incomplete.');
}

function isAccessRequired(env) {
  return String(env.REQUIRE_ACCESS || 'true').trim().toLowerCase() !== 'false';
}

function originAllowed(origin, env) {
  if (!origin) return true;
  return allowedOrigins(env).includes(origin);
}

function allowedOrigins(env) {
  return String(env.ALLOWED_ORIGIN || '').split(',').map(value => value.trim()).filter(Boolean);
}

function corsHeaders(origin, env) {
  const allowed = origin && originAllowed(origin, env) ? origin : allowedOrigins(env)[0] || '';
  return {
    'Access-Control-Allow-Origin': allowed,
    'Access-Control-Allow-Credentials': 'true',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'GET,POST,PUT,DELETE,OPTIONS',
    'Access-Control-Max-Age': '86400',
    'Cache-Control': 'no-store',
    'Vary': 'Origin',
    'X-Content-Type-Options': 'nosniff'
  };
}

async function readJsonBody(request) {
  const length = Number(request.headers.get('Content-Length') || 0);
  if (length > 100000) throw httpError(413, 'Request body is too large.');
  let value;
  try {
    value = await request.json();
  } catch (error) {
    throw httpError(400, 'Request body must be valid JSON.');
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw httpError(400, 'A JSON object is required.');
  if (JSON.stringify(value).length > 100000) throw httpError(413, 'Request body is too large.');
  return value;
}

async function callAppsScript(request, authenticatedUser, env) {
  const response = await fetch(env.APPS_SCRIPT_URL, {
    method: 'POST',
    redirect: 'follow',
    headers: {'Content-Type': 'application/json'},
    body: JSON.stringify({...request, authenticatedUser, gatewaySecret: env.GATEWAY_SECRET})
  });
  if (!response.ok) throw httpError(502, 'Google Apps Script did not accept the request.');
  let result;
  try {
    result = await response.json();
  } catch (error) {
    throw httpError(502, 'Google Apps Script returned an invalid response.');
  }
  if (!result || typeof result.ok !== 'boolean') throw httpError(502, 'Google Apps Script returned an invalid response.');
  return result;
}

function backendStatus(message) {
  if (/not found|deleted/i.test(String(message))) return 404;
  if (/unauthorized/i.test(String(message))) return 502;
  return 400;
}

function resolveRequestUser(request, env) {
  if (isAccessRequired(env)) return authenticateAccess(request, env);

  return {
    email: 'public-user',
    rateLimitKey: request.headers.get('CF-Connecting-IP') || 'public-user'
  };
}

async function authenticateAccess(request, env) {
  const token = request.headers.get('Cf-Access-Jwt-Assertion');
  if (!token) throw httpError(401, 'Cloudflare Access login is required.');
  const parts = token.split('.');
  if (parts.length !== 3) throw httpError(401, 'Invalid Cloudflare Access token.');

  let header;
  let payload;
  try {
    header = JSON.parse(new TextDecoder().decode(base64UrlBytes(parts[0])));
    payload = JSON.parse(new TextDecoder().decode(base64UrlBytes(parts[1])));
  } catch (error) {
    throw httpError(401, 'Invalid Cloudflare Access token.');
  }

  if (header.alg !== 'RS256' || !header.kid) throw httpError(401, 'Unsupported Cloudflare Access token.');
  const teamDomain = normalizeTeamDomain(env.ACCESS_TEAM_DOMAIN);
  const keys = await getAccessKeys(teamDomain);
  const jwk = keys.find(key => key.kid === header.kid);
  if (!jwk) throw httpError(401, 'Cloudflare Access signing key was not found.');

  const cryptoKey = await crypto.subtle.importKey(
    'jwk',
    jwk,
    {name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256'},
    false,
    ['verify']
  );
  const verified = await crypto.subtle.verify(
    'RSASSA-PKCS1-v1_5',
    cryptoKey,
    base64UrlBytes(parts[2]),
    new TextEncoder().encode(`${parts[0]}.${parts[1]}`)
  );
  if (!verified) throw httpError(401, 'Cloudflare Access token signature is invalid.');

  const now = Math.floor(Date.now() / 1000);
  const issuer = `https://${teamDomain}`;
  const audiences = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
  if (payload.iss !== issuer || !audiences.includes(env.ACCESS_AUD)) throw httpError(401, 'Cloudflare Access token claims are invalid.');
  if (!payload.exp || payload.exp <= now || (payload.nbf && payload.nbf > now + 30)) throw httpError(401, 'Cloudflare Access login has expired.');
  if (!payload.email) throw httpError(403, 'The authenticated user has no email address.');
  return {email: String(payload.email).toLowerCase()};
}

async function getAccessKeys(teamDomain) {
  if (accessKeysCache && Date.now() < accessKeysExpiresAt) return accessKeysCache;
  const response = await fetch(`https://${teamDomain}/cdn-cgi/access/certs`);
  if (!response.ok) throw httpError(502, 'Cloudflare Access signing keys could not be loaded.');
  const document = await response.json();
  accessKeysCache = Array.isArray(document.keys) ? document.keys : [];
  accessKeysExpiresAt = Date.now() + 60 * 60 * 1000;
  return accessKeysCache;
}

function normalizeTeamDomain(value) {
  return String(value).trim().replace(/^https?:\/\//, '').replace(/\/$/, '');
}

function base64UrlBytes(value) {
  const normalized = value.replace(/-/g, '+').replace(/_/g, '/');
  const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, '=');
  const binary = atob(padded);
  return Uint8Array.from(binary, character => character.charCodeAt(0));
}

function httpError(status, message) {
  const error = new Error(message);
  error.status = status;
  return error;
}

function json(body, status, headers) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {'Content-Type': 'application/json; charset=utf-8', ...headers}
  });
}
