// ==================================================================
// BUSCAR LUGARES PARA LAS AGENDAS  ->  /api/admin/geocode
//   GET ?q=texto            busca lugares por nombre (haciendas, salones…)
//   GET ?lat=..&lng=..      dice qué lugar hay en ese punto del mapa
//
// El panel (teléfono y computadora) NO habla con OpenStreetMap: pasa por
// aquí. Así la búsqueda lleva el User-Agent que Nominatim exige, se puede
// cachear y el panel no depende de CORS ni de la red del equipo.
//
// Nominatim (OpenStreetMap) pide como máximo 1 petición por segundo y un
// User-Agent propio; por eso se cachean las respuestas y se espera lo justo
// entre peticiones seguidas. Si el servicio no responde, el panel muestra el
// mensaje y el usuario siempre puede tocar el mapa para elegir el punto.
// ==================================================================
import type { NextApiRequest, NextApiResponse } from "next";
import { withCors } from "../../../lib/cors";
import { requirePermission } from "../../../lib/permissions";
import { ok, fail } from "../../../lib/api-response";

const NOMINATIM = "https://nominatim.openstreetmap.org";
const USER_AGENT =
  "HardstreetAdmin/1.0 (panel de agendas; contacto: hardstreet)";
const TIMEOUT_MS = 8000;
/** Nominatim: 1 petición por segundo como mucho. */
const MIN_GAP_MS = 1100;
/** Lo que se repite (misma búsqueda, mismo punto) se responde de memoria. */
const CACHE_MS = 10 * 60 * 1000;
const cache = new Map<string, { at: number; data: unknown }>();
let lastCall = 0;

const norm = (v: unknown) => (typeof v === "string" ? v.trim() : "");

/** Todas las claves de caché que se acumulen de más se van soltando. */
function remember(key: string, data: unknown) {
  const now = Date.now();
  for (const [k, v] of cache) {
    if (now - v.at > CACHE_MS) cache.delete(k);
  }
  cache.set(key, { at: now, data });
  return data;
}

function cached(key: string): unknown | undefined {
  const hit = cache.get(key);
  if (!hit) return undefined;
  if (Date.now() - hit.at > CACHE_MS) {
    cache.delete(key);
    return undefined;
  }
  return hit.data;
}

/** Respeta el ritmo de Nominatim sin bloquear otras peticiones de la API. */
async function waitTurn() {
  const now = Date.now();
  const wait = lastCall + MIN_GAP_MS - now;
  lastCall = Math.max(now, lastCall + MIN_GAP_MS);
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
}

async function getJson(url: string): Promise<any> {
  await waitTurn();
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      headers: { "User-Agent": USER_AGENT, "Accept-Language": "es" },
      signal: ctrl.signal,
    });
    if (!res.ok) throw new Error(`Nominatim ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

/** Un resultado de búsqueda tal como lo pinta el panel. */
type Place = {
  name: string;
  address: string;
  displayName: string;
  lat: number;
  lng: number;
};

function toPlace(raw: any): Place | null {
  const lat = Number(raw?.lat);
  const lng = Number(raw?.lon);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  const displayName = String(raw?.display_name || "").trim();
  const address = raw?.address && typeof raw.address === "object" ? raw.address : {};
  const name =
    String(
      address.tourism ||
        address.leisure ||
        address.amenity ||
        address.building ||
        address.house_name ||
        address.venue ||
        raw?.name ||
        ""
    ).trim() ||
    // Sin nombre propio: la primera parte de la dirección ("Hacienda X, …").
    displayName.split(",")[0].trim();
  return { name: name.slice(0, 255), address: displayName, displayName, lat, lng };
}

export default withCors(async (req: NextApiRequest, res: NextApiResponse) => {
  if (req.method !== "GET") {
    fail(res, 405, "Método no permitido", `${req.method} no está soportado aquí`);
    return;
  }
  // Quien puede leer agendas puede buscar lugares para ellas.
  const me = await requirePermission(req, res, "schedules", "read");
  if (!me) return;

  const q = norm(req.query.q).slice(0, 160);
  const latRaw = norm(req.query.lat);
  const lngRaw = norm(req.query.lng);

  try {
    // --- ¿Qué lugar hay en este punto? (al tocar el mapa) ---
    if (latRaw && lngRaw) {
      const lat = Number(latRaw);
      const lng = Number(lngRaw);
      if (!Number.isFinite(lat) || Math.abs(lat) > 90 || !Number.isFinite(lng) || Math.abs(lng) > 180) {
        fail(res, 400, "Coordenadas inválidas", "El punto del mapa no es válido");
        return;
      }
      const key = `rev:${lat.toFixed(5)},${lng.toFixed(5)}`;
      const hit = cached(key);
      if (hit !== undefined) {
        ok(res, "Lugar encontrado", { place: hit });
        return;
      }
      const data = await getJson(
        `${NOMINATIM}/reverse?format=jsonv2&zoom=18&addressdetails=1&lat=${lat}&lng=${lng}`
      );
      const place = toPlace(data);
      if (!place) {
        fail(res, 404, "No se encontró el lugar", "Ese punto no tiene una dirección conocida");
        return;
      }
      ok(res, "Lugar encontrado", { place: remember(key, place) });
      return;
    }

    // --- Búsqueda por nombre ---
    if (q.length < 3) {
      ok(res, "Escribe al menos 3 letras", { results: [] });
      return;
    }
    const key = `q:${q.toLowerCase()}`;
    const hit = cached(key);
    if (hit !== undefined) {
      ok(res, "Lugares encontrados", { results: hit });
      return;
    }
    const data = await getJson(
      `${NOMINATIM}/search?format=jsonv2&addressdetails=1&limit=8&q=${encodeURIComponent(q)}`
    );
    const results = Array.isArray(data)
      ? data.map(toPlace).filter((p): p is Place => !!p)
      : [];
    ok(res, "Lugares encontrados", { results: remember(key, results) });
  } catch (e) {
    console.error("[admin/geocode]", e);
    fail(
      res,
      502,
      "No se pudo buscar el lugar",
      "El servicio de mapas no respondió. Puedes tocar el mapa para elegir el punto."
    );
  }
});
