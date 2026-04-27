// Tiny self-hosted DHL shipment cancellation service.
// All config is read from environment at startup.
import Fastify from "fastify";
import fastifyStatic from "@fastify/static";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ---------- config ----------
const REQUIRED = ["DHL_ENV", "DHL_USER", "DHL_PASSWORD", "DHL_API_KEY", "DHL_API_SECRET"];
const missing = REQUIRED.filter((k) => !process.env[k] || !process.env[k].trim());
if (missing.length) {
  console.error(
    `[dhl-cancel] Missing required environment variables: ${missing.join(", ")}.\n` +
      `Copy .env.example to .env and fill them in, then restart the container.`
  );
  process.exit(1);
}

const CONFIG = {
  env: process.env.DHL_ENV.trim(), // "eu" or "sandbox"
  user: process.env.DHL_USER.trim(),
  password: process.env.DHL_PASSWORD,
  apiKey: process.env.DHL_API_KEY.trim(),
  apiSecret: process.env.DHL_API_SECRET.trim(),
  profile: (process.env.DHL_PROFILE || "STANDARD_GRUPPENPROFIL").trim(),
  port: Number(process.env.PORT || 8080),
};

if (!["eu", "sandbox"].includes(CONFIG.env)) {
  console.error(`[dhl-cancel] DHL_ENV must be "eu" or "sandbox" (got "${CONFIG.env}").`);
  process.exit(1);
}

const BASE = `https://api-${CONFIG.env}.dhl.com`;

// ---------- token cache ----------
let tokenCache = { token: null, expiresAt: 0 };

async function fetchToken() {
  const body = new URLSearchParams({
    grant_type: "password",
    username: CONFIG.user,
    password: CONFIG.password,
    client_id: CONFIG.apiKey,
    client_secret: CONFIG.apiSecret,
  });

  const res = await fetch(`${BASE}/parcel/de/account/auth/ropc/v1/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });

  let data = null;
  try {
    data = await res.json();
  } catch {
    /* ignore */
  }

  if (!res.ok || !data?.access_token) {
    const detail = data?.error_description || data?.error || `HTTP ${res.status}`;
    throw new AuthError(`DHL authentication failed: ${detail}`);
  }

  // 60s safety margin
  const ttlMs = Math.max(30, (data.expires_in || 1799) - 60) * 1000;
  tokenCache = {
    token: data.access_token,
    expiresAt: Date.now() + ttlMs,
  };
  return tokenCache.token;
}

async function getToken({ force = false } = {}) {
  if (!force && tokenCache.token && Date.now() < tokenCache.expiresAt) {
    return tokenCache.token;
  }
  return await fetchToken();
}

class AuthError extends Error {}

// ---------- DHL cancel ----------
async function cancelShipment(shipment) {
  const url =
    `${BASE}/parcel/de/shipping/v2/orders` +
    `?profile=${encodeURIComponent(CONFIG.profile)}` +
    `&shipment=${encodeURIComponent(shipment)}`;

  const doCall = async (token) =>
    fetch(url, {
      method: "DELETE",
      headers: {
        "Accept-Language": "de-DE",
        Authorization: `Bearer ${token}`,
      },
    });

  let token = await getToken();
  let res = await doCall(token);

  // Token might have been revoked early -> retry once with a fresh token
  if (res.status === 401) {
    token = await getToken({ force: true });
    res = await doCall(token);
  }

  let payload = null;
  try {
    payload = await res.json();
  } catch {
    /* DHL may return empty body on success */
  }

  return interpretCancelResponse(res.status, payload, shipment);
}

function interpretCancelResponse(status, payload, shipment) {
  // The shipping v2 API returns a top-level status object plus per-item status.
  const itemStatus = payload?.items?.[0]?.sstatus ?? payload?.items?.[0]?.status;
  const itemCode = itemStatus?.statusCode ?? itemStatus?.code;
  const itemText =
    itemStatus?.title ||
    itemStatus?.detail ||
    itemStatus?.statusText ||
    (Array.isArray(itemStatus?.statusMessage) ? itemStatus.statusMessage.join("; ") : itemStatus?.statusMessage);

  const topStatus = payload?.status;
  const topText = topStatus?.title || topStatus?.detail || topStatus?.statusText;

  // Success: HTTP 200 and per-item code 200 (or no items but 200 OK)
  if (status === 200 && (itemCode === undefined || itemCode === 200)) {
    return { ok: true, shipment };
  }

  // Build a human-readable message
  if (status === 200 && itemCode && itemCode !== 200) {
    // Per-item failure (most common for "shipment cannot be cancelled")
    return {
      ok: false,
      message: itemText
        ? `${itemText} (Sendung ${shipment})`
        : `Sendung ${shipment} konnte nicht storniert werden.`,
    };
  }

  switch (status) {
    case 400:
      return {
        ok: false,
        message: topText || itemText || `Ungültige Sendungsnummer: ${shipment}`,
      };
    case 401:
    case 403:
      return {
        ok: false,
        message: "DHL-Authentifizierung fehlgeschlagen — bitte API-Zugangsdaten prüfen.",
      };
    case 404:
      return { ok: false, message: `Sendung ${shipment} nicht gefunden.` };
    case 409:
      return {
        ok: false,
        message:
          topText || itemText || `Sendung ${shipment} kann nicht mehr storniert werden (bereits abgeholt/zugestellt).`,
      };
    case 422:
      return {
        ok: false,
        message:
          topText || itemText || `Sendung ${shipment} kann nicht storniert werden.`,
      };
    case 429:
      return { ok: false, message: "DHL-API-Limit erreicht — bitte kurz warten und erneut scannen." };
    case 500:
    case 502:
    case 503:
    case 504:
      return { ok: false, message: "DHL-Service derzeit nicht erreichbar — bitte später erneut versuchen." };
    default:
      return {
        ok: false,
        message:
          topText || itemText || `Unbekannter Fehler von DHL (HTTP ${status}) für Sendung ${shipment}.`,
      };
  }
}

// ---------- HTTP server ----------
const app = Fastify({ logger: true });

await app.register(fastifyStatic, {
  root: path.join(__dirname, "public"),
  prefix: "/",
  index: ["index.html"],
});

app.get("/healthz", async () => "ok");

app.post("/cancel", async (req, reply) => {
  const raw = (req.body && (req.body.shipment ?? req.body.Shipment)) || "";
  const shipment = String(raw).trim();

  if (!shipment) {
    return reply.code(400).send({ ok: false, message: "Keine Sendungsnummer übermittelt." });
  }
  // Basic sanity: DHL shipment numbers are digits, typically 12-22 chars.
  if (!/^[A-Za-z0-9]{6,40}$/.test(shipment)) {
    return reply
      .code(400)
      .send({ ok: false, message: `Ungültige Sendungsnummer: "${shipment}"` });
  }

  try {
    const result = await cancelShipment(shipment);
    return reply.send(result);
  } catch (err) {
    req.log.error({ err }, "cancel failed");
    if (err instanceof AuthError) {
      return reply.send({ ok: false, message: err.message });
    }
    return reply.send({
      ok: false,
      message: "Verbindung zur DHL-API fehlgeschlagen — bitte Netzwerk prüfen.",
    });
  }
});

try {
  await app.listen({ port: CONFIG.port, host: "0.0.0.0" });
  console.log(`[dhl-cancel] listening on :${CONFIG.port} (env=${CONFIG.env})`);
} catch (err) {
  app.log.error(err);
  process.exit(1);
}
