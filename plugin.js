const YT_API_BASE = "https://www.googleapis.com/youtube/v3";
const YT_INNERTUBE_BASE = "https://www.youtube.com/youtubei/v1";
const OAUTH_TOKEN_URL = "https://oauth2.googleapis.com/token";

/**
 * Plan B - Instancias de respaldo automático de Invidious y Piped
 * en caso de limitaciones o fallos de YouTube directo.
 */
const INVIDIOUS_MIRRORS = [
  "https://invidious.nerdvpn.de",
  "https://inv.nadeko.net",
  "https://invidious.tiekoetter.com"
];

const PIPED_INSTANCES = [
  "https://cf.piped.video",
  "https://pipedapi.ducks.party",
  "https://piped.ducks.party",
  "https://pipedapi.kavin.rocks",
  "https://piped.kavin.rocks",
  "https://pipedapi.wireway.ch",
  "https://piped.wireway.ch"
];

const HOME_CATEGORIES = [
  { id: "trending", title: "Tendencias en YouTube", ref: "cat:trending", query: "tendencias tecnologia musica cine", genre: "entretenimiento" },
  { id: "music", title: "Música y Conciertos", ref: "cat:music", query: "official music video live concert", videoCategoryId: "10", genre: "musica" },
  { id: "documentaries", title: "Documentales y Ciencia", ref: "cat:documentaries", query: "documental completo espanol ciencia historia", genre: "documentales" },
  { id: "movies", title: "Películas y Cortometrajes", ref: "cat:movies", query: "pelicula completa dominio publico cortometraje", genre: "peliculas" },
  { id: "playlists", title: "Listas de Reproducción Destacadas", ref: "cat:playlists", query: "curso completo documental serie playlist", searchType: "playlist", genre: "series" },
  { id: "channels", title: "Canales Destacados", ref: "cat:channels", query: "canal oficial ciencia historia musica", searchType: "channel", genre: "otros" }
];

function getRegionCode() {
  const raw = (kino.config && typeof kino.config.region_code === "string")
    ? kino.config.region_code.trim().toUpperCase()
    : "";
  return /^[A-Z]{2}$/.test(raw) ? raw : "AR";
}

function getPreferredLang() {
  const raw = (kino.config && typeof kino.config.preferred_lang === "string")
    ? kino.config.preferred_lang.trim().toLowerCase()
    : "";
  return /^[a-z]{2}(-[a-z0-9]+)?$/i.test(raw) ? raw : "es";
}

async function getAuthCredentials() {
  const userApiKey = (kino.config && typeof kino.config.api_key === "string")
    ? kino.config.api_key.trim()
    : "";
  let sealedKey = "";
  let clientId = "";
  let clientSecret = "";

  try {
    sealedKey = (await kino.secret("mi_clave")) || "";
  } catch (_) {
    sealedKey = "";
  }
  try {
    clientId = (await kino.secret("client_id")) || "";
  } catch (_) {
    clientId = "";
  }
  try {
    clientSecret = (await kino.secret("client_secret")) || "";
  } catch (_) {
    clientSecret = "";
  }

  const effectiveApiKey = userApiKey || (sealedKey.startsWith("AIza") ? sealedKey : "");
  let accessToken = "";
  try {
    const storedToken = await kino.storage.get("yt_access_token");
    const expiresAt = Number(await kino.storage.get("yt_token_expires_at")) || 0;
    const refreshToken = await kino.storage.get("yt_refresh_token");
    if (storedToken && Date.now() < expiresAt - 30000) {
      accessToken = String(storedToken);
    } else if (refreshToken && clientId && (clientSecret || sealedKey)) {
      const refreshed = await refreshOAuthToken(String(refreshToken), clientId, clientSecret || sealedKey);
      if (refreshed) accessToken = refreshed;
    }
  } catch (_) {
    accessToken = "";
  }

  return {
    apiKey: effectiveApiKey,
    sealedKey,
    clientId,
    clientSecret: clientSecret || sealedKey,
    accessToken
  };
}

async function refreshOAuthToken(refreshToken, clientId, clientSecret) {
  try {
    const body = new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      refresh_token: refreshToken,
      grant_type: "refresh_token"
    }).toString();

    const res = await kino.fetch(OAUTH_TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body
    });
    if (!res.ok) return "";
    const data = await res.json();
    if (data && data.access_token) {
      const ttlMs = (Number(data.expires_in) || 3600) * 1000;
      await kino.storage.set("yt_access_token", data.access_token);
      await kino.storage.set("yt_token_expires_at", String(Date.now() + ttlMs));
      return String(data.access_token);
    }
  } catch (err) {
    kino.log("Error renovando token OAuth:", String(err));
  }
  return "";
}

async function ytDataApiFetch(endpoint, params = {}) {
  const creds = await getAuthCredentials();
  const keyToTry = creds.apiKey || creds.sealedKey;
  if (!keyToTry && !creds.accessToken) return null;

  const query = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null && v !== "") {
      query.set(k, String(v));
    }
  }
  const headers = { "Accept": "application/json" };
  if (creds.accessToken) {
    headers["Authorization"] = `Bearer ${creds.accessToken}`;
  } else if (keyToTry) {
    query.set("key", keyToTry);
  }

  const url = `${YT_API_BASE}/${endpoint}?${query.toString()}`;
  try {
    const res = await kino.fetch(url, { headers });
    if (!res.ok) return null;
    const data = await res.json();
    if (data && !data.error) return data;
  } catch (err) {
    kino.log("Aviso en consulta Data API v3:", String(err));
  }
  return null;
}

async function ytInnertubeFetch(endpoint, payload) {
  const region = getRegionCode();
  const prefLang = getPreferredLang();
  const body = {
    context: {
      client: {
        clientName: "WEB",
        clientVersion: "2.20250101.00.00",
        hl: prefLang,
        gl: region
      }
    },
    ...payload
  };
  const res = await kino.fetch(`${YT_INNERTUBE_BASE}/${endpoint}?prettyPrint=false`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Accept": "application/json",
      "User-Agent": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36"
    },
    body: JSON.stringify(body)
  });
  if (!res.ok) {
    throw new Error(`Error HTTP ${res.status} al consultar YouTube`);
  }
  return await res.json();
}

function selectThumbnail(thumbnails, videoId = "") {
  if (thumbnails && typeof thumbnails === "object") {
    if (Array.isArray(thumbnails)) {
      const sorted = [...thumbnails].filter(t => t && t.url);
      if (sorted.length > 0) {
        let rawUrl = sorted[sorted.length - 1].url;
        if (rawUrl.startsWith("//")) rawUrl = "https:" + rawUrl;
        return rawUrl;
      }
    } else {
      const order = ["maxres", "standard", "high", "medium", "default"];
      for (const k of order) {
        if (thumbnails[k] && thumbnails[k].url) {
          let rawUrl = thumbnails[k].url;
          if (rawUrl.startsWith("//")) rawUrl = "https:" + rawUrl;
          return rawUrl;
        }
      }
    }
  }
  if (videoId) {
    return `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`;
  }
  return "https://www.youtube.com/img/desktop/yt_1200.png";
}

function mapDataApiItem(raw) {
  if (!raw) return null;
  const snippet = raw.snippet || {};
  const rawKind = typeof raw.id === "string" ? (raw.kind || "") : (raw.id && raw.id.kind ? raw.id.kind : "");

  if (rawKind.includes("playlist") || (raw.id && raw.id.playlistId)) {
    const playlistId = typeof raw.id === "string" ? raw.id : raw.id.playlistId;
    if (!playlistId) return null;
    const poster = selectThumbnail(snippet.thumbnails);
    return {
      id: `yt-pl-${playlistId}`,
      ref: `playlist:${playlistId}`,
      title: snippet.title || "Lista de reproducción",
      kind: "series",
      poster,
      backdrop: poster,
      overview: snippet.description || (snippet.channelTitle ? `Canal: ${snippet.channelTitle}` : "Lista de reproducción de YouTube")
    };
  }

  if (rawKind.includes("channel") || (raw.id && raw.id.channelId)) {
    const channelId = typeof raw.id === "string" ? raw.id : raw.id.channelId;
    if (!channelId) return null;
    const poster = selectThumbnail(snippet.thumbnails);
    return {
      id: `yt-ch-${channelId}`,
      ref: `channel:${channelId}`,
      title: snippet.title || snippet.channelTitle || "Canal de YouTube",
      kind: "series",
      poster,
      backdrop: poster,
      overview: snippet.description || "Canal público de YouTube"
    };
  }

  const videoId = typeof raw.id === "string"
    ? raw.id
    : (raw.id && raw.id.videoId) || (snippet.resourceId && snippet.resourceId.videoId) || "";
  if (!videoId) return null;

  const isLive = snippet.liveBroadcastContent === "live";
  const poster = `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`;
  const backdrop = `https://i.ytimg.com/vi/${videoId}/maxresdefault.jpg`;
  const year = snippet.publishedAt ? String(snippet.publishedAt).slice(0, 4) : undefined;

  return {
    id: `yt-v-${videoId}`,
    ref: `video:${videoId}`,
    title: snippet.title || `Video ${videoId}`,
    kind: isLive ? "live" : "movie",
    year: year && /^\d{4}$/.test(year) ? year : undefined,
    poster,
    backdrop,
    overview: snippet.description || (snippet.channelTitle ? `Canal: ${snippet.channelTitle}` : "")
  };
}

function extractText(node) {
  if (!node) return "";
  if (typeof node === "string") return node;
  if (typeof node.simpleText === "string") return node.simpleText;
  if (Array.isArray(node.runs)) return node.runs.map(r => r.text || "").join("");
  return "";
}

function collectInnertubeRenderers(root, out = [], depth = 0) {
  if (!root || typeof root !== "object" || depth > 40 || out.length >= 45) return out;
  if (root.videoRenderer && root.videoRenderer.videoId) {
    out.push({ type: "video", data: root.videoRenderer });
    return out;
  }
  if (root.playlistvideoRenderer && root.playlistvideoRenderer.videoId) {
    out.push({ type: "video", data: root.playlistvideoRenderer });
    return out;
  }
  if (root.playlistVideoRenderer && root.playlistVideoRenderer.videoId) {
    out.push({ type: "video", data: root.playlistVideoRenderer });
    return out;
  }
  if (root.gridVideoRenderer && root.gridVideoRenderer.videoId) {
    out.push({ type: "video", data: root.gridVideoRenderer });
    return out;
  }
  if (root.reelItemRenderer && root.reelItemRenderer.videoId) {
    out.push({ type: "video", data: root.reelItemRenderer });
    return out;
  }
  if (root.playlistRenderer && root.playlistRenderer.playlistId) {
    out.push({ type: "playlist", data: root.playlistRenderer });
    return out;
  }
  if (root.lockupViewModel && root.lockupViewModel.contentId) {
    out.push({ type: "lockup", data: root.lockupViewModel });
    return out;
  }
  if (root.channelRenderer && root.channelRenderer.channelId) {
    out.push({ type: "channel", data: root.channelRenderer });
    return out;
  }
  if (Array.isArray(root)) {
    for (const child of root) {
      collectInnertubeRenderers(child, out, depth + 1);
      if (out.length >= 45) break;
    }
  } else {
    for (const val of Object.values(root)) {
      if (val && typeof val === "object") {
        collectInnertubeRenderers(val, out, depth + 1);
        if (out.length >= 45) break;
      }
    }
  }
  return out;
}

function mapInnertubeEntry(entry) {
  const { type, data } = entry;
  if (type === "video") {
    const videoId = data.videoId;
    const title = extractText(data.title || data.headline) || `Video ${videoId}`;
    const channelName = extractText(data.ownerText || data.longBylineText || data.shortBylineText);
    const desc = extractText(data.descriptionSnippet) || (channelName ? `Canal: ${channelName}` : "");
    return {
      id: `yt-v-${videoId}`,
      ref: `video:${videoId}`,
      title,
      kind: "movie",
      poster: `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`,
      backdrop: `https://i.ytimg.com/vi/${videoId}/maxresdefault.jpg`,
      overview: desc
    };
  }
  if (type === "playlist") {
    const playlistId = data.playlistId;
    const title = extractText(data.title) || `Lista ${playlistId}`;
    const thumbs = (data.thumbnails && data.thumbnails[0] && data.thumbnails[0].thumbnails) || (data.thumbnail && data.thumbnail.thumbnails) || [];
    const poster = selectThumbnail(thumbs);
    const channelName = extractText(data.shortBylineText || data.longBylineText);
    return {
      id: `yt-pl-${playlistId}`,
      ref: `playlist:${playlistId}`,
      title,
      kind: "series",
      poster,
      backdrop: poster,
      overview: channelName ? `Lista de reproducción · ${channelName}` : "Lista de reproducción de YouTube"
    };
  }
  if (type === "lockup") {
    const contentId = String(data.contentId || "");
    const title = (data.metadata && data.metadata.lockupMetadataViewModel && data.metadata.lockupMetadataViewModel.title && data.metadata.lockupMetadataViewModel.title.content) || `Contenido ${contentId}`;
    if (contentId.startsWith("PL") || contentId.startsWith("OL") || contentId.startsWith("UU")) {
      return {
        id: `yt-pl-${contentId}`,
        ref: `playlist:${contentId}`,
        title,
        kind: "series",
        poster: "https://www.youtube.com/img/desktop/yt_1200.png",
        backdrop: "https://www.youtube.com/img/desktop/yt_1200.png",
        overview: "Lista de reproducción de YouTube"
      };
    }
    if (contentId.length === 11) {
      return {
        id: `yt-v-${contentId}`,
        ref: `video:${contentId}`,
        title,
        kind: "movie",
        poster: `https://i.ytimg.com/vi/${contentId}/hqdefault.jpg`,
        backdrop: `https://i.ytimg.com/vi/${contentId}/maxresdefault.jpg`,
        overview: "Video de YouTube"
      };
    }
  }
  if (type === "channel") {
    const channelId = data.channelId;
    const title = extractText(data.title) || `Canal ${channelId}`;
    const thumbs = (data.thumbnail && data.thumbnail.thumbnails) || [];
    const poster = selectThumbnail(thumbs);
    const desc = extractText(data.descriptionSnippet) || "Canal público de YouTube";
    return {
      id: `yt-ch-${channelId}`,
      ref: `channel:${channelId}`,
      title,
      kind: "series",
      poster,
      backdrop: poster,
      overview: desc
    };
  }
  return null;
}

function mapInvidiousSearchItem(v) {
  if (!v || typeof v !== "object") return null;
  const itemType = String(v.type || "video").toLowerCase();

  if (itemType === "playlist" || v.playlistId) {
    const playlistId = v.playlistId;
    if (!playlistId) return null;
    const poster = v.playlistThumbnail || selectThumbnail(v.videos && v.videos[0] && v.videos[0].videoThumbnails);
    return {
      id: `yt-pl-${playlistId}`,
      ref: `playlist:${playlistId}`,
      title: v.title || `Lista ${playlistId}`,
      kind: "series",
      poster,
      backdrop: poster,
      overview: v.author ? `Lista de reproducción · ${v.author}` : "Lista de reproducción de YouTube"
    };
  }

  if (itemType === "channel" || (v.authorId && !v.videoId)) {
    const channelId = v.authorId;
    if (!channelId) return null;
    const poster = selectThumbnail(v.authorThumbnails);
    return {
      id: `yt-ch-${channelId}`,
      ref: `channel:${channelId}`,
      title: v.author || v.title || `Canal ${channelId}`,
      kind: "series",
      poster,
      backdrop: poster,
      overview: v.description || "Canal público de YouTube"
    };
  }

  const videoId = v.videoId;
  if (!videoId) return null;
  const isLive = Boolean(v.liveNow);
  return {
    id: `yt-v-${videoId}`,
    ref: `video:${videoId}`,
    title: v.title || `Video ${videoId}`,
    kind: isLive ? "live" : "movie",
    poster: `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`,
    backdrop: `https://i.ytimg.com/vi/${videoId}/maxresdefault.jpg`,
    overview: v.description || (v.author ? `Canal: ${v.author}` : "")
  };
}

async function searchViaInvidious(queryText, searchType = "video", region = "AR") {
  const encoded = encodeURIComponent(queryText.trim());
  let invType = "all";
  if (searchType === "video") invType = "video";
  else if (searchType === "playlist") invType = "playlist";
  else if (searchType === "channel") invType = "channel";

  for (const inv of INVIDIOUS_MIRRORS) {
    try {
      const res = await kino.fetch(
        `${inv}/api/v1/search?q=${encoded}&type=${invType}&region=${region}`,
        {
          headers: {
            "Accept": "application/json",
            "User-Agent": "Mozilla/5.0 KinoPlugin"
          }
        }
      );
      if (!res.ok) continue;
      const data = await res.json();
      if (!Array.isArray(data) || data.length === 0) continue;

      const items = [];
      const seen = new Set();
      for (const entry of data) {
        const mapped = mapInvidiousSearchItem(entry);
        if (mapped && !seen.has(mapped.id)) {
          seen.add(mapped.id);
          items.push(mapped);
        }
      }
      if (items.length > 0) return items;
    } catch (err) {
      kino.log(`Aviso en búsqueda Invidious (${inv}):`, String(err));
    }
  }
  return [];
}

function mapPipedSearchItem(st) {
  if (!st || typeof st !== "object") return null;
  const url = String(st.url || "");
  const itemType = String(st.type || "").toLowerCase();

  if (itemType === "playlist" || url.includes("list=")) {
    const plMatch = url.match(/[?&]list=([A-Za-z0-9_-]+)/);
    const playlistId = plMatch ? plMatch[1] : "";
    if (!playlistId) return null;
    const poster = st.thumbnail || "https://www.youtube.com/img/desktop/yt_1200.png";
    return {
      id: `yt-pl-${playlistId}`,
      ref: `playlist:${playlistId}`,
      title: st.name || st.title || `Lista ${playlistId}`,
      kind: "series",
      poster,
      backdrop: poster,
      overview: st.uploaderName ? `Lista de reproducción · ${st.uploaderName}` : "Lista de reproducción de YouTube"
    };
  }

  if (itemType === "channel" || url.startsWith("/channel/")) {
    const chMatch = url.match(/\/channel\/(UC[A-Za-z0-9_-]{22})/);
    const channelId = chMatch ? chMatch[1] : "";
    if (!channelId) return null;
    const poster = st.thumbnail || "https://www.youtube.com/img/desktop/yt_1200.png";
    return {
      id: `yt-ch-${channelId}`,
      ref: `channel:${channelId}`,
      title: st.name || st.title || `Canal ${channelId}`,
      kind: "series",
      poster,
      backdrop: poster,
      overview: st.description || "Canal público de YouTube"
    };
  }

  const vidMatch = url.match(/(?:v=|\/watch\?v=|youtu\.be\/)([A-Za-z0-9_-]{11})/);
  const videoId = vidMatch ? vidMatch[1] : "";
  if (!videoId) return null;
  return {
    id: `yt-v-${videoId}`,
    ref: `video:${videoId}`,
    title: st.title || st.name || `Video ${videoId}`,
    kind: st.isShort ? "movie" : "movie",
    poster: `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`,
    backdrop: `https://i.ytimg.com/vi/${videoId}/maxresdefault.jpg`,
    overview: st.shortDescription || (st.uploaderName ? `Canal: ${st.uploaderName}` : "")
  };
}

async function searchViaPiped(queryText, searchType = "video") {
  const encoded = encodeURIComponent(queryText.trim());
  let filter = "all";
  if (searchType === "video") filter = "videos";
  else if (searchType === "playlist") filter = "playlists";
  else if (searchType === "channel") filter = "channels";

  for (const piped of PIPED_INSTANCES) {
    try {
      const endpoints = [
        `${piped}/search?q=${encoded}&filter=${filter}`,
        `${piped}/results?search_query=${encoded}`
      ];
      for (const endpoint of endpoints) {
        try {
          const res = await kino.fetch(endpoint, {
            headers: {
              "Accept": "application/json",
              "User-Agent": "Mozilla/5.0 KinoPlugin"
            }
          });
          if (!res.ok) continue;
          const data = await res.json();
          const rawItems = Array.isArray(data) ? data : (data && Array.isArray(data.items) ? data.items : []);
          if (rawItems.length === 0) continue;

          const items = [];
          const seen = new Set();
          for (const st of rawItems) {
            const mapped = mapPipedSearchItem(st);
            if (mapped && !seen.has(mapped.id)) {
              seen.add(mapped.id);
              items.push(mapped);
            }
          }
          if (items.length > 0) return items;
        } catch (_) {}
      }
    } catch (err) {
      kino.log(`Aviso en búsqueda Piped (${piped}):`, String(err));
    }
  }
  return [];
}

async function fetchTrendingFallback(region = "AR") {
  for (const inv of INVIDIOUS_MIRRORS) {
    try {
      const res = await kino.fetch(`${inv}/api/v1/trending?region=${region}`, {
        headers: {
          "Accept": "application/json",
          "User-Agent": "Mozilla/5.0 KinoPlugin"
        }
      });
      if (!res.ok) continue;
      const data = await res.json();
      if (Array.isArray(data) && data.length > 0) {
        const items = data.map(mapInvidiousSearchItem).filter(Boolean);
        if (items.length > 0) return items;
      }
    } catch (_) {}
  }

  for (const piped of PIPED_INSTANCES) {
    try {
      const res = await kino.fetch(`${piped}/trending?region=${region}`, {
        headers: {
          "Accept": "application/json",
          "User-Agent": "Mozilla/5.0 KinoPlugin"
        }
      });
      if (!res.ok) continue;
      const data = await res.json();
      if (Array.isArray(data) && data.length > 0) {
        const items = data.map(mapPipedSearchItem).filter(Boolean);
        if (items.length > 0) return items;
      }
    } catch (_) {}
  }

  return [];
}

async function fetchItemsByQuery(queryText, options = {}) {
  const { searchType = "video,playlist,channel", pageToken = "", maxResults = 18, videoCategoryId = "" } = options;
  const region = getRegionCode();

  // Plan A.1: YouTube Data API v3
  const apiParams = {
    part: "snippet",
    q: queryText,
    type: searchType,
    maxResults: String(maxResults),
    regionCode: region
  };
  if (pageToken) apiParams.pageToken = pageToken;
  if (videoCategoryId && searchType === "video") apiParams.videoCategoryId = videoCategoryId;

  const apiData = await ytDataApiFetch("search", apiParams);
  if (apiData && Array.isArray(apiData.items) && apiData.items.length > 0) {
    const items = apiData.items.map(mapDataApiItem).filter(Boolean);
    if (items.length > 0) {
      return {
        items,
        next: apiData.nextPageToken || undefined
      };
    }
  }

  // Plan A.2: YouTube Innertube directo
  try {
    const innertubePayload = { query: queryText };
    if (searchType === "playlist") {
      innertubePayload.params = "EgIQAw%3D%3D";
    } else if (searchType === "channel") {
      innertubePayload.params = "EgIQAg%3D%3D";
    }

    const raw = await ytInnertubeFetch("search", innertubePayload);
    const renderers = collectInnertubeRenderers(raw);
    const seen = new Set();
    const items = [];
    for (const r of renderers) {
      const mapped = mapInnertubeEntry(r);
      if (mapped && !seen.has(mapped.id)) {
        seen.add(mapped.id);
        items.push(mapped);
      }
    }
    if (items.length > 0) {
      return { items };
    }
  } catch (err) {
    kino.log("Aviso en búsqueda Innertube:", String(err));
  }

  // Plan B.1: Invidious (invidious.nerdvpn.de, inv.nadeko.net, invidious.tiekoetter.com)
  const invItems = await searchViaInvidious(queryText, searchType, region);
  if (invItems.length > 0) {
    return { items: invItems.slice(0, maxResults) };
  }

  // Plan B.2: Piped (cf.piped.video, piped.ducks.party, piped.kavin.rocks, piped.wireway.ch)
  const pipedItems = await searchViaPiped(queryText, searchType);
  if (pipedItems.length > 0) {
    return { items: pipedItems.slice(0, maxResults) };
  }

  return { items: [] };
}

export async function home() {
  const rows = [];
  const region = getRegionCode();

  let trendingItems = [];
  const popularData = await ytDataApiFetch("videos", {
    part: "snippet",
    chart: "mostPopular",
    regionCode: region,
    maxResults: "15"
  });

  if (popularData && Array.isArray(popularData.items) && popularData.items.length > 0) {
    trendingItems = popularData.items.map(mapDataApiItem).filter(Boolean);
  } else {
    trendingItems = (await fetchTrendingFallback(region)).slice(0, 15);
  }

  if (trendingItems.length > 0) {
    rows.push({
      id: "trending",
      title: "Tendencias en YouTube",
      ref: "cat:trending",
      genre: "entretenimiento",
      items: trendingItems
    });
  }

  const categoriesToLoad = rows.length > 0 ? HOME_CATEGORIES.slice(1, 5) : HOME_CATEGORIES.slice(0, 4);
  for (const cat of categoriesToLoad) {
    try {
      const page = await fetchItemsByQuery(cat.query, {
        searchType: cat.searchType || "video",
        videoCategoryId: cat.videoCategoryId || "",
        maxResults: 12
      });
      if (page.items && page.items.length > 0) {
        rows.push({
          id: cat.id,
          title: cat.title,
          ref: cat.ref,
          genre: cat.genre,
          items: page.items
        });
      }
    } catch (err) {
      kino.log(`Aviso cargando fila ${cat.id}:`, String(err));
    }
  }

  return rows;
}

export async function browse(ref, cursor) {
  const cleanRef = String(ref || "cat:trending").trim();

  if (cleanRef.startsWith("playlist:") || cleanRef.startsWith("channel:")) {
    const epData = await episodes(cleanRef);
    const items = (epData.episodes || []).map(ep => ({
      id: `yt-v-${ep.ref.replace(/^video:/, "")}`,
      ref: ep.ref,
      title: ep.title,
      kind: "movie",
      poster: ep.still || "https://www.youtube.com/img/desktop/yt_1200.png",
      backdrop: ep.still || "https://www.youtube.com/img/desktop/yt_1200.png",
      overview: ep.overview || ""
    }));
    return { items };
  }

  const catId = cleanRef.replace(/^cat:/, "");
  const foundCat = HOME_CATEGORIES.find(c => c.id === catId || c.ref === cleanRef) || HOME_CATEGORIES[0];

  if (foundCat.id === "trending" && !cursor) {
    const region = getRegionCode();
    const popularData = await ytDataApiFetch("videos", {
      part: "snippet",
      chart: "mostPopular",
      regionCode: region,
      maxResults: "20"
    });
    if (popularData && Array.isArray(popularData.items) && popularData.items.length > 0) {
      return {
        items: popularData.items.map(mapDataApiItem).filter(Boolean),
        next: popularData.nextPageToken || undefined
      };
    }
    const fallbackTrending = await fetchTrendingFallback(region);
    if (fallbackTrending.length > 0) {
      return { items: fallbackTrending.slice(0, 20) };
    }
  }

  return await fetchItemsByQuery(foundCat.query, {
    searchType: foundCat.searchType || "video",
    pageToken: cursor || "",
    maxResults: 20
  });
}

export async function search(query) {
  const qText = typeof query === "string"
    ? query.trim()
    : (query && typeof query.q === "string" ? query.q.trim() : "");

  if (!qText) {
    return { items: [] };
  }

  const cursor = (query && typeof query === "object" && query.cursor) ? String(query.cursor) : "";
  let searchType = "video,playlist,channel";
  if (query && typeof query === "object") {
    if (query.type === "movie") searchType = "video";
    else if (query.type === "series") searchType = "playlist,channel";
  }

  return await fetchItemsByQuery(qText, {
    searchType,
    pageToken: cursor,
    maxResults: 20
  });
}

function extractEpisodesFromBrowseRoot(raw, fallbackOverview = "") {
  const renderers = collectInnertubeRenderers(raw);
  const epList = [];
  const seen = new Set();
  for (const r of renderers) {
    let vid = "";
    let title = "";
    let overview = "";
    if (r.type === "video" && r.data && r.data.videoId) {
      vid = r.data.videoId;
      title = extractText(r.data.title || r.data.headline);
      overview = extractText(r.data.descriptionSnippet || r.data.shortBylineText || r.data.publishedTimeText) || fallbackOverview;
    } else if (r.type === "lockup" && r.data && String(r.data.contentId || "").length === 11) {
      vid = String(r.data.contentId);
      title = (r.data.metadata && r.data.metadata.lockupMetadataViewModel && r.data.metadata.lockupMetadataViewModel.title && r.data.metadata.lockupMetadataViewModel.title.content) || "";
      overview = fallbackOverview;
    }
    if (vid && !seen.has(vid)) {
      seen.add(vid);
      epList.push({
        season: 1,
        number: epList.length + 1,
        ref: `video:${vid}`,
        title: title || `Episodio ${epList.length + 1}`,
        still: `https://i.ytimg.com/vi/${vid}/hqdefault.jpg`,
        overview
      });
    }
  }
  return epList;
}

async function fetchPlaylistEpisodesFallback(playlistId) {
  for (const inv of INVIDIOUS_MIRRORS) {
    try {
      const res = await kino.fetch(`${inv}/api/v1/playlists/${playlistId}`, {
        headers: {
          "Accept": "application/json",
          "User-Agent": "Mozilla/5.0 KinoPlugin"
        }
      });
      if (!res.ok) continue;
      const data = await res.json();
      const videos = data && Array.isArray(data.videos) ? data.videos : [];
      if (videos.length === 0) continue;

      const epList = [];
      const seen = new Set();
      for (const v of videos) {
        if (!v || !v.videoId || seen.has(v.videoId)) continue;
        seen.add(v.videoId);
        epList.push({
          season: 1,
          number: epList.length + 1,
          ref: `video:${v.videoId}`,
          title: v.title || `Episodio ${epList.length + 1}`,
          still: `https://i.ytimg.com/vi/${v.videoId}/hqdefault.jpg`,
          overview: v.author ? `Canal: ${v.author}` : ""
        });
      }
      if (epList.length > 0) {
        return {
          series: { title: data.title || "Lista de reproducción de YouTube" },
          episodes: epList
        };
      }
    } catch (_) {}
  }

  for (const piped of PIPED_INSTANCES) {
    try {
      const res = await kino.fetch(`${piped}/playlists/${playlistId}`, {
        headers: {
          "Accept": "application/json",
          "User-Agent": "Mozilla/5.0 KinoPlugin"
        }
      });
      if (!res.ok) continue;
      const data = await res.json();
      const streams = data && Array.isArray(data.relatedStreams) ? data.relatedStreams : [];
      if (streams.length === 0) continue;

      const epList = [];
      const seen = new Set();
      for (const st of streams) {
        if (!st) continue;
        const vid = extractVideoId(st.url || "");
        if (!vid || vid.length !== 11 || seen.has(vid)) continue;
        seen.add(vid);
        epList.push({
          season: 1,
          number: epList.length + 1,
          ref: `video:${vid}`,
          title: st.title || `Episodio ${epList.length + 1}`,
          still: `https://i.ytimg.com/vi/${vid}/hqdefault.jpg`,
          overview: st.shortDescription || (st.uploaderName ? `Canal: ${st.uploaderName}` : "")
        });
      }
      if (epList.length > 0) {
        return {
          series: { title: data.name || "Lista de reproducción de YouTube" },
          episodes: epList
        };
      }
    } catch (_) {}
  }

  return null;
}

async function fetchChannelEpisodesFallback(channelId) {
  for (const inv of INVIDIOUS_MIRRORS) {
    try {
      const res = await kino.fetch(`${inv}/api/v1/channels/${channelId}/videos`, {
        headers: {
          "Accept": "application/json",
          "User-Agent": "Mozilla/5.0 KinoPlugin"
        }
      });
      if (!res.ok) continue;
      const data = await res.json();
      const rawVideos = Array.isArray(data) ? data : (data && Array.isArray(data.videos) ? data.videos : []);
      if (rawVideos.length === 0) continue;

      const epList = [];
      const seen = new Set();
      for (const v of rawVideos) {
        if (!v || !v.videoId || seen.has(v.videoId)) continue;
        seen.add(v.videoId);
        epList.push({
          season: 1,
          number: epList.length + 1,
          ref: `video:${v.videoId}`,
          title: v.title || `Episodio ${epList.length + 1}`,
          still: `https://i.ytimg.com/vi/${v.videoId}/hqdefault.jpg`,
          overview: v.description || (v.author ? `Canal: ${v.author}` : "")
        });
      }
      if (epList.length > 0) {
        return {
          series: { title: (rawVideos[0] && rawVideos[0].author) || "Videos del canal" },
          episodes: epList
        };
      }
    } catch (_) {}
  }

  for (const piped of PIPED_INSTANCES) {
    try {
      const res = await kino.fetch(`${piped}/channel/${channelId}`, {
        headers: {
          "Accept": "application/json",
          "User-Agent": "Mozilla/5.0 KinoPlugin"
        }
      });
      if (!res.ok) continue;
      const data = await res.json();
      const streams = data && Array.isArray(data.relatedStreams) ? data.relatedStreams : [];
      if (streams.length === 0) continue;

      const epList = [];
      const seen = new Set();
      for (const st of streams) {
        if (!st) continue;
        const vid = extractVideoId(st.url || "");
        if (!vid || vid.length !== 11 || seen.has(vid)) continue;
        seen.add(vid);
        epList.push({
          season: 1,
          number: epList.length + 1,
          ref: `video:${vid}`,
          title: st.title || `Episodio ${epList.length + 1}`,
          still: `https://i.ytimg.com/vi/${vid}/hqdefault.jpg`,
          overview: st.shortDescription || (data.name ? `Canal: ${data.name}` : "")
        });
      }
      if (epList.length > 0) {
        return {
          series: { title: data.name || "Videos del canal" },
          episodes: epList
        };
      }
    } catch (_) {}
  }

  return null;
}

export async function episodes(ref) {
  const rawRef = String(ref || "").trim();

  if (rawRef.startsWith("playlist:")) {
    const playlistId = rawRef.slice("playlist:".length);
    const apiData = await ytDataApiFetch("playlistItems", {
      part: "snippet",
      playlistId,
      maxResults: "50"
    });

    if (apiData && Array.isArray(apiData.items) && apiData.items.length > 0) {
      const epList = [];
      for (let i = 0; i < apiData.items.length; i++) {
        const snippet = apiData.items[i].snippet || {};
        const vid = snippet.resourceId && snippet.resourceId.videoId;
        if (!vid) continue;
        epList.push({
          season: 1,
          number: epList.length + 1,
          ref: `video:${vid}`,
          title: snippet.title || `Episodio ${epList.length + 1}`,
          still: `https://i.ytimg.com/vi/${vid}/hqdefault.jpg`,
          overview: snippet.description || ""
        });
      }
      if (epList.length > 0) {
        return {
          series: { title: "Lista de reproducción de YouTube" },
          episodes: epList
        };
      }
    }

    const browseId = playlistId.startsWith("VL") ? playlistId : `VL${playlistId}`;
    try {
      const raw = await ytInnertubeFetch("browse", { browseId });
      const epList = extractEpisodesFromBrowseRoot(raw);
      if (epList.length > 0) {
        return {
          series: { title: "Lista de reproducción de YouTube" },
          episodes: epList
        };
      }
    } catch (err) {
      kino.log("Aviso en browse de playlist:", String(err));
    }

    const fallbackPl = await fetchPlaylistEpisodesFallback(playlistId);
    if (fallbackPl) return fallbackPl;

    return {
      series: { title: "Lista de reproducción de YouTube" },
      episodes: []
    };
  }

  if (rawRef.startsWith("channel:")) {
    const channelId = rawRef.slice("channel:".length);
    const channelData = await ytDataApiFetch("channels", {
      part: "contentDetails,snippet",
      id: channelId
    });
    const uploadsPlaylistId = channelData
      && channelData.items
      && channelData.items[0]
      && channelData.items[0].contentDetails
      && channelData.items[0].contentDetails.relatedPlaylists
      && channelData.items[0].contentDetails.relatedPlaylists.uploads;

    if (uploadsPlaylistId) {
      const fromApi = await episodes(`playlist:${uploadsPlaylistId}`);
      if (fromApi.episodes && fromApi.episodes.length > 0) {
        return fromApi;
      }
    }

    try {
      const rawVideosTab = await ytInnertubeFetch("browse", {
        browseId: channelId,
        params: "EgZ2aWRlb3PyBgQKAjoA"
      });
      const channelTitle = (rawVideosTab && rawVideosTab.metadata && rawVideosTab.metadata.channelMetadataRenderer && rawVideosTab.metadata.channelMetadataRenderer.title) || "Videos del canal";
      const epList = extractEpisodesFromBrowseRoot(rawVideosTab, `Canal: ${channelTitle}`);
      if (epList.length > 0) {
        return {
          series: { title: channelTitle },
          episodes: epList
        };
      }
    } catch (err) {
      kino.log("Aviso en pestaña videos del canal:", String(err));
    }

    if (channelId.startsWith("UC") && channelId.length > 4) {
      const uuPlaylist = "UU" + channelId.slice(2);
      const fromUploads = await episodes(`playlist:${uuPlaylist}`);
      if (fromUploads.episodes && fromUploads.episodes.length > 0) {
        return fromUploads;
      }
    }

    const fallbackCh = await fetchChannelEpisodesFallback(channelId);
    if (fallbackCh) return fallbackCh;

    return {
      series: { title: "Videos del canal" },
      episodes: []
    };
  }

  const vid = extractVideoId(rawRef);
  return {
    series: { title: "Video de YouTube" },
    episodes: [
      {
        season: 1,
        number: 1,
        ref: `video:${vid}`,
        title: "Reproducir video",
        still: `https://i.ytimg.com/vi/${vid}/hqdefault.jpg`
      }
    ]
  };
}

function extractVideoId(ref) {
  const clean = String(ref || "").trim();
  if (clean.startsWith("video:")) return clean.slice("video:".length).trim();
  const match = clean.match(/(?:v=|youtu\.be\/|\/vi\/|\/embed\/)([A-Za-z0-9_-]{11})/);
  if (match) return match[1];
  return clean;
}

function extractSubtitles(data, prefLang) {
  const subList = [];
  const captionTracks = data
    && data.captions
    && data.captions.playerCaptionsTracklistRenderer
    && data.captions.playerCaptionsTracklistRenderer.captionTracks;

  let hasPrefSub = false;
  let translatableTrack = null;

  if (Array.isArray(captionTracks)) {
    for (const track of captionTracks) {
      if (!track || !track.baseUrl) continue;
      const langCode = String(track.languageCode || "es");
      if (langCode === prefLang || langCode.startsWith(prefLang + "-")) {
        hasPrefSub = true;
      }
      if (track.isTranslatable && (langCode.startsWith("en") || !translatableTrack)) {
        translatableTrack = track;
      }
      const vttUrl = track.baseUrl.includes("fmt=")
        ? track.baseUrl.replace(/fmt=[^&]+/, "fmt=vtt")
        : track.baseUrl + "&fmt=vtt";
      subList.push({
        lang: langCode,
        url: vttUrl,
        format: "vtt",
        label: extractText(track.name) || langCode,
        translated: false
      });
    }

    if (!hasPrefSub && translatableTrack && translatableTrack.baseUrl) {
      const baseVtt = translatableTrack.baseUrl.includes("fmt=")
        ? translatableTrack.baseUrl.replace(/fmt=[^&]+/, "fmt=vtt")
        : translatableTrack.baseUrl + "&fmt=vtt";
      subList.push({
        lang: prefLang,
        url: baseVtt + "&tlang=" + encodeURIComponent(prefLang),
        format: "vtt",
        label: prefLang.toUpperCase() + " (Traducción automática)",
        translated: true
      });
    }

    subList.sort((a, b) => {
      const aMatch = (a.lang === prefLang || a.lang.startsWith(prefLang + "-")) ? 0 : 1;
      const bMatch = (b.lang === prefLang || b.lang.startsWith(prefLang + "-")) ? 0 : 1;
      return aMatch - bMatch;
    });
  }

  return subList;
}

/**
 * Plan B.1 de reproducción: Invidious (invidious.nerdvpn.de, inv.nadeko.net, invidious.tiekoetter.com).
 */
async function resolveViaInvidious(videoId) {
  for (const inv of INVIDIOUS_MIRRORS) {
    try {
      const res = await kino.fetch(`${inv}/api/v1/videos/${videoId}`, {
        headers: {
          "Accept": "application/json",
          "User-Agent": "Mozilla/5.0 KinoPlugin"
        }
      });

      if (!res.ok) continue;
      const data = await res.json();
      if (!data || typeof data !== "object") continue;

      const subList = [];
      if (Array.isArray(data.captions)) {
        for (const cap of data.captions) {
          if (cap && typeof cap.url === "string") {
            const subUrl = cap.url.startsWith("http") ? cap.url : `${inv}${cap.url}`;
            subList.push({
              lang: cap.language_code || cap.languageCode || "es",
              label: cap.label || "Subtítulo",
              url: subUrl,
              format: "vtt"
            });
          }
        }
      }

      const candidates = [];

      if (typeof data.hlsUrl === "string" && data.hlsUrl.startsWith("http")) {
        candidates.push({
          url: data.hlsUrl.startsWith("https://") ? data.hlsUrl : `${inv}${data.hlsUrl}`,
          mime: "application/x-mpegURL",
          headers: { "User-Agent": "Mozilla/5.0" },
          label: "HLS (Invidious)"
        });
      }

      if (Array.isArray(data.formatStreams)) {
        const sorted = [...data.formatStreams]
          .filter(f => f && typeof f.url === "string")
          .sort((a, b) => (parseInt(String(b.resolution || "0"), 10) || 0) - (parseInt(String(a.resolution || "0"), 10) || 0));

        for (const fmt of sorted) {
          const streamUrl = fmt.url.startsWith("http") ? fmt.url : `${inv}${fmt.url}`;
          const mime = String(fmt.type || "video/mp4").split(";")[0].trim() || "video/mp4";
          candidates.push({
            url: streamUrl,
            mime,
            headers: { "User-Agent": "Mozilla/5.0" },
            label: `${fmt.qualityLabel || fmt.resolution || "MP4"} (Invidious)`
          });
        }
      }

      candidates.push({
        url: `${inv}/latest_version?id=${videoId}&itag=18`,
        mime: "video/mp4",
        headers: { "User-Agent": "Mozilla/5.0" },
        label: "360p Directo (Invidious)"
      });

      if (candidates.length > 0) {
        const primary = candidates[0];
        const alternatives = candidates.slice(1, 9);
        return {
          url: primary.url,
          mime: primary.mime,
          headers: primary.headers,
          subtitles: subList.length > 0 ? subList.slice(0, 30) : undefined,
          alternatives: alternatives.length > 0 ? alternatives : undefined,
          expiresInSeconds: 10800
        };
      }
    } catch (_) {
      // Probar siguiente espejo de Invidious
    }
  }

  return null;
}

/**
 * Plan B.2 de reproducción: Piped (cf.piped.video, piped.ducks.party, piped.kavin.rocks, piped.wireway.ch).
 */
async function resolveViaPiped(videoId) {
  for (const piped of PIPED_INSTANCES) {
    try {
      const res = await kino.fetch(`${piped}/streams/${videoId}`, {
        headers: {
          "Accept": "application/json",
          "User-Agent": "Mozilla/5.0 KinoPlugin"
        }
      });

      if (!res.ok) continue;
      const data = await res.json();
      if (!data || typeof data !== "object") continue;

      const subList = [];
      if (Array.isArray(data.subtitles)) {
        for (const sub of data.subtitles) {
          if (sub && typeof sub.url === "string" && sub.url.startsWith("https://")) {
            subList.push({
              lang: sub.code || "es",
              label: sub.name || sub.code || "Subtítulo",
              url: sub.url,
              format: (sub.mimeType && sub.mimeType.includes("ttml")) ? "ttml" : "vtt"
            });
          }
        }
      }

      const candidates = [];

      if (typeof data.hls === "string" && data.hls.startsWith("https://")) {
        candidates.push({
          url: data.hls,
          mime: "application/x-mpegURL",
          headers: { "User-Agent": "Mozilla/5.0" },
          label: "HLS (Piped)"
        });
      }

      if (Array.isArray(data.videoStreams)) {
        const withAudio = data.videoStreams
          .filter(v => v && typeof v.url === "string" && v.url.startsWith("https://") && v.videoOnly === false)
          .sort((a, b) => (Number(b.height) || 0) - (Number(a.height) || 0));

        const anyVideo = data.videoStreams
          .filter(v => v && typeof v.url === "string" && v.url.startsWith("https://") && v.videoOnly !== false)
          .sort((a, b) => (Number(b.height) || 0) - (Number(a.height) || 0));

        for (const v of [...withAudio, ...anyVideo]) {
          const mime = String(v.mimeType || "video/mp4").split(";")[0].trim() || "video/mp4";
          candidates.push({
            url: v.url,
            mime,
            headers: { "User-Agent": "Mozilla/5.0" },
            label: `${v.quality || (v.height ? v.height + "p" : "MP4")} (Piped)`
          });
        }
      }

      if (candidates.length > 0) {
        const primary = candidates[0];
        const alternatives = candidates.slice(1, 9);
        return {
          url: primary.url,
          mime: primary.mime,
          headers: primary.headers,
          subtitles: subList.length > 0 ? subList.slice(0, 30) : undefined,
          alternatives: alternatives.length > 0 ? alternatives : undefined,
          expiresInSeconds: 10800
        };
      }
    } catch (_) {
      // Probar siguiente instancia de Piped
    }
  }

  return null;
}

export async function resolve(ref) {
  const videoId = extractVideoId(ref);
  if (!videoId) {
    throw new Error("Identificador de video de YouTube inválido");
  }

  await ytDataApiFetch("videos", {
    part: "snippet,contentDetails",
    id: videoId
  });

  const prefLang = getPreferredLang();
  const region = getRegionCode();

  const clients = [
    {
      clientName: "IOS",
      clientVersion: "20.10.4",
      deviceMake: "Apple",
      deviceModel: "iPhone16,2",
      osName: "iPhone",
      osVersion: "18.3.2.22D82",
      userAgent: "com.google.ios.youtube/20.10.4 (iPhone16,2; U; CPU iOS 18_3_2 like Mac OS X;)"
    },
    {
      clientName: "ANDROID_VR",
      clientVersion: "1.61.48",
      deviceMake: "Oculus",
      deviceModel: "Quest 3",
      osName: "Android",
      osVersion: "12L",
      androidSdkVersion: 32,
      userAgent: "com.google.android.apps.youtube.vr.oculus/1.61.48 (Linux; U; Android 12L; eureka-user Build/SQ3A.220605.009.A1) gzip"
    },
    {
      clientName: "ANDROID",
      clientVersion: "20.10.38",
      deviceMake: "Google",
      deviceModel: "Pixel 8",
      osName: "Android",
      osVersion: "14",
      androidSdkVersion: 34,
      userAgent: "com.google.android.youtube/20.10.38 (Linux; U; Android 14) gzip"
    }
  ];

  let hlsCandidate = null;
  const progressiveCandidates = [];
  let collectedSubtitles = [];
  let minExpires = 21600;

  // Plan A: YouTube Innertube directo
  for (const client of clients) {
    try {
      const payload = {
        videoId,
        context: {
          client: {
            clientName: client.clientName,
            clientVersion: client.clientVersion,
            deviceMake: client.deviceMake,
            deviceModel: client.deviceModel,
            osName: client.osName,
            osVersion: client.osVersion,
            androidSdkVersion: client.androidSdkVersion,
            hl: prefLang,
            gl: region
          }
        },
        contentCheckOk: true,
        racyCheckOk: true
      };

      const res = await kino.fetch(`${YT_INNERTUBE_BASE}/player?prettyPrint=false`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Accept": "application/json",
          "User-Agent": client.userAgent
        },
        body: JSON.stringify(payload)
      });

      if (!res.ok) continue;
      const data = await res.json();
      const streamingData = data && data.streamingData;
      if (!streamingData) continue;

      if (Number(streamingData.expiresInSeconds) > 0) {
        minExpires = Math.min(minExpires, Number(streamingData.expiresInSeconds));
      }

      if (collectedSubtitles.length === 0) {
        collectedSubtitles = extractSubtitles(data, prefLang);
      }

      if (!hlsCandidate && typeof streamingData.hlsManifestUrl === "string" && streamingData.hlsManifestUrl.startsWith("https://")) {
        hlsCandidate = {
          url: streamingData.hlsManifestUrl,
          mime: "application/x-mpegURL",
          headers: { "User-Agent": client.userAgent },
          label: "HLS Adaptativo (Full HD / Multi-audio)"
        };
      }

      const progFormats = (Array.isArray(streamingData.formats) ? streamingData.formats : [])
        .filter(f => f && typeof f.url === "string" && f.url.startsWith("https://"))
        .sort((a, b) => (Number(b.height) || 0) - (Number(a.height) || 0));

      for (const fmt of progFormats) {
        const mimeType = String(fmt.mimeType || "").split(";")[0].trim() || "video/mp4";
        const quality = fmt.qualityLabel || `${fmt.height || 360}p`;
        const label = `${quality} MP4 (${client.clientName})`;
        if (!progressiveCandidates.some(p => p.url === fmt.url)) {
          progressiveCandidates.push({
            url: fmt.url,
            mime: mimeType,
            headers: { "User-Agent": client.userAgent },
            label
          });
        }
      }

      if (hlsCandidate && progressiveCandidates.length > 0) {
        break;
      }
    } catch (err) {
      kino.log(`Aviso en cliente ${client.clientName}:`, String(err));
    }
  }

  const allStreams = [];
  if (hlsCandidate) {
    allStreams.push(hlsCandidate);
  }
  for (const prog of progressiveCandidates) {
    allStreams.push(prog);
  }

  if (allStreams.length > 0) {
    const primary = allStreams[0];
    const mirrorFallbacks = INVIDIOUS_MIRRORS.map(inv => ({
      url: `${inv}/latest_version?id=${videoId}&itag=18`,
      mime: "video/mp4",
      headers: { "User-Agent": "Mozilla/5.0" },
      label: `Respaldo Invidious (${inv.replace(/^https:\/\//, "")})`
    }));
    const alternatives = [...allStreams.slice(1), ...mirrorFallbacks].slice(0, 9).map(s => ({
      url: s.url,
      mime: s.mime,
      headers: s.headers,
      label: s.label
    }));

    return {
      url: primary.url,
      mime: primary.mime,
      headers: primary.headers,
      subtitles: collectedSubtitles.length > 0 ? collectedSubtitles : undefined,
      alternatives: alternatives.length > 0 ? alternatives : undefined,
      expiresInSeconds: minExpires
    };
  }

  // Plan B.1: Invidious API + streams
  const invStream = await resolveViaInvidious(videoId);
  if (invStream) {
    return invStream;
  }

  // Plan B.2: Piped API
  const pipedStream = await resolveViaPiped(videoId);
  if (pipedStream) {
    return pipedStream;
  }

  // Plan B.3: Último recurso directo a través de los mirrors de Invidious (latest_version)
  const fallbackUrls = INVIDIOUS_MIRRORS.map(inv => ({
    url: `${inv}/latest_version?id=${videoId}&itag=18`,
    mime: "video/mp4",
    headers: { "User-Agent": "Mozilla/5.0" },
    label: `Invidious (${inv.replace(/^https:\/\//, "")})`
  }));

  return {
    url: fallbackUrls[0].url,
    mime: fallbackUrls[0].mime,
    headers: fallbackUrls[0].headers,
    alternatives: fallbackUrls.slice(1)
  };
}
