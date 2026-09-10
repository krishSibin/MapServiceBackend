import express from "express";
import crypto from "crypto";

/* ------------------------------------------------------------------ *
 * CARTO Maps API v3 integration
 *
 * The CARTO access token is a server-side secret, so it never reaches
 * the browser. Instead:
 *   1. /api/carto/tilejson instantiates a map on CARTO and returns the
 *      resulting TileJSON, with every tile URL rewritten to point back
 *      at this server.
 *   2. /api/carto/tiles/... proxies each vector tile to CARTO, adding
 *      the Authorization header on the way out.
 * ------------------------------------------------------------------ */

// Read lazily: ES modules are evaluated before server.js calls dotenv.config(),
// so reading process.env at module scope here would always come back empty.
const config = () => ({
    apiBaseUrl: (process.env.CARTO_API_BASE_URL || "https://gcp-us-east1.api.carto.com").replace(/\/+$/, ""),
    accessToken: process.env.CARTO_ACCESS_TOKEN,
    defaultConnection: process.env.CARTO_CONNECTION_NAME || "carto_dw"
});

const SOURCE_TYPES = new Set(["table", "query", "tileset"]);

// Parameters CARTO understands that we forward untouched.
const PASSTHROUGH_PARAMS = [
    "columns",
    "geo_column",
    "spatialDataType",
    "spatialDataColumn",
    "aggregationExp",
    "aggregationResLevel",
    "filters",
    "queryParameters"
];

const TILEJSON_TTL_MS = 5 * 60 * 1000;   // re-instantiate maps every 5 min
const TEMPLATE_TTL_MS = 60 * 60 * 1000;  // keep tile templates alive for 1 h

const tilejsonCache = new Map();  // cacheKey -> { expires, payload }
const tileTemplates = new Map();  // id       -> { expires, url }

export const isCartoConfigured = () => Boolean(config().accessToken);

function sweep(store) {
    const now = Date.now();
    for (const [key, entry] of store) {
        if (entry.expires <= now) store.delete(key);
    }
}

async function cartoFetch(url, { accept = "application/json" } = {}) {
    return fetch(url, {
        headers: {
            Authorization: `Bearer ${config().accessToken}`,
            Accept: accept
        }
    });
}

/** Register a CARTO tile URL template and return the opaque id the client sees. */
function registerTemplate(url) {
    sweep(tileTemplates);
    const id = crypto.createHash("sha1").update(url).digest("hex").slice(0, 16);
    tileTemplates.set(id, { url, expires: Date.now() + TEMPLATE_TTL_MS });
    return id;
}

/** Rewrite CARTO's tile URLs so the browser talks to us instead of CARTO. */
function proxifyTiles(tilejson, publicBaseUrl) {
    const tiles = Array.isArray(tilejson.tiles) ? tilejson.tiles : [];

    return {
        ...tilejson,
        tiles: tiles.map(tileUrl => {
            const id = registerTemplate(tileUrl);
            return `${publicBaseUrl}/api/carto/tiles/${id}/{z}/{x}/{y}.mvt`;
        })
    };
}

/**
 * Ask CARTO for a map layer. Depending on the source type CARTO either
 * answers with TileJSON directly, or with an instantiation envelope that
 * points at a TileJSON document we then have to fetch.
 */
async function instantiateMap({ type, connection, params }) {
    const url = new URL(`${config().apiBaseUrl}/v3/maps/${encodeURIComponent(connection)}/${type}`);
    url.searchParams.set("format", "tilejson");
    for (const [key, value] of Object.entries(params)) {
        if (value !== undefined && value !== null && value !== "") {
            url.searchParams.set(key, value);
        }
    }

    const response = await cartoFetch(url.toString());
    const body = await response.text();

    if (!response.ok) {
        const error = new Error(`CARTO responded ${response.status}`);
        error.status = response.status;
        error.body = body;
        throw error;
    }

    let payload;
    try {
        payload = JSON.parse(body);
    } catch {
        const error = new Error("CARTO returned a non-JSON response");
        error.status = 502;
        error.body = body.slice(0, 500);
        throw error;
    }

    // Already TileJSON.
    if (Array.isArray(payload.tiles)) return payload;

    // Instantiation envelope: follow tilejson.url to the real document.
    const tilejsonUrl = payload?.tilejson?.url?.[0];
    if (!tilejsonUrl) {
        const error = new Error("CARTO response contained no tile URLs");
        error.status = 502;
        error.body = JSON.stringify(payload).slice(0, 500);
        throw error;
    }

    const followUp = await cartoFetch(tilejsonUrl);
    if (!followUp.ok) {
        const error = new Error(`CARTO TileJSON fetch failed (${followUp.status})`);
        error.status = followUp.status;
        error.body = await followUp.text();
        throw error;
    }

    return followUp.json();
}

/* ---------------- ROUTER ---------------- */

const router = express.Router();

router.use((req, res, next) => {
    if (!isCartoConfigured()) {
        return res.status(503).json({
            error: "CARTO is not configured. Set CARTO_ACCESS_TOKEN in backend/.env."
        });
    }
    next();
});

/** Quick health/config check — never exposes the token itself. */
router.get("/status", (req, res) => {
    const { apiBaseUrl, defaultConnection } = config();
    res.json({ configured: true, apiBaseUrl, defaultConnection });
});

/**
 * GET /api/carto/tilejson
 *   ?type=table   &name=project.dataset.table
 *   ?type=tileset &name=project.dataset.tileset
 *   ?type=query   &q=SELECT ...
 * Optional: connection, columns, geo_column, aggregationExp, ...
 */
router.get("/tilejson", async (req, res) => {
    const type = String(req.query.type || "table").toLowerCase();
    const connection = String(req.query.connection || config().defaultConnection);

    if (!SOURCE_TYPES.has(type)) {
        return res.status(400).json({
            error: `Invalid type "${type}". Use one of: ${[...SOURCE_TYPES].join(", ")}.`
        });
    }

    const params = {};
    if (type === "query") {
        if (!req.query.q) {
            return res.status(400).json({ error: "Query maps require a `q` parameter." });
        }
        params.q = String(req.query.q);
    } else {
        if (!req.query.name) {
            return res.status(400).json({ error: `${type} maps require a \`name\` parameter.` });
        }
        params.name = String(req.query.name);
    }

    for (const key of PASSTHROUGH_PARAMS) {
        if (req.query[key] !== undefined) params[key] = String(req.query[key]);
    }

    const cacheKey = JSON.stringify({ type, connection, params });
    const cached = tilejsonCache.get(cacheKey);
    if (cached && cached.expires > Date.now()) {
        return res.json(cached.payload);
    }

    try {
        const tilejson = await instantiateMap({ type, connection, params });
        const publicBaseUrl = (process.env.PUBLIC_BASE_URL || `${req.protocol}://${req.get("host")}`).replace(/\/+$/, "");
        const payload = proxifyTiles(tilejson, publicBaseUrl);

        sweep(tilejsonCache);
        tilejsonCache.set(cacheKey, { payload, expires: Date.now() + TILEJSON_TTL_MS });

        console.log(`🗺️  CARTO map instantiated: ${type} → ${params.name || params.q}`);
        res.json(payload);
    } catch (err) {
        console.error("CARTO tilejson error:", err.message, err.body || "");
        res.status(err.status >= 400 ? err.status : 502).json({
            error: "Failed to load the CARTO map layer.",
            details: err.body || err.message
        });
    }
});

/** Vector tile proxy. The CARTO token is attached here, server-side only. */
router.get("/tiles/:id/:z/:x/:y.mvt", async (req, res) => {
    const { id, z, x, y } = req.params;

    const entry = tileTemplates.get(id);
    if (!entry || entry.expires <= Date.now()) {
        tileTemplates.delete(id);
        return res.status(410).json({ error: "Tile source expired. Request /api/carto/tilejson again." });
    }

    const target = entry.url
        .replace("{z}", encodeURIComponent(z))
        .replace("{x}", encodeURIComponent(x))
        .replace("{y}", encodeURIComponent(y));

    try {
        const upstream = await cartoFetch(target, { accept: "application/vnd.mapbox-vector-tile" });

        if (upstream.status === 204 || upstream.status === 404) {
            return res.status(204).end(); // empty tile
        }
        if (!upstream.ok) {
            return res.status(upstream.status).json({ error: `CARTO tile request failed (${upstream.status})` });
        }

        // CARTO signals truncation through these headers; pass them along.
        for (const header of ["features-dropped-from-tile", "truncated-tile-rows"]) {
            const value = upstream.headers.get(header);
            if (value) res.setHeader(header, value);
        }

        res.setHeader("Access-Control-Expose-Headers", "Features-Dropped-From-Tile,Truncated-Tile-Rows");
        res.setHeader("Content-Type", upstream.headers.get("content-type") || "application/vnd.mapbox-vector-tile");
        res.setHeader("Cache-Control", "public, max-age=300");

        res.end(Buffer.from(await upstream.arrayBuffer()));
    } catch (err) {
        console.error("CARTO tile proxy error:", err.message);
        res.status(502).json({ error: "CARTO tile proxy failed" });
    }
});

export default router;
