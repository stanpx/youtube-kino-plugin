const YT_API_BASE = "https://www.googleapis.com/youtube/v3";
const YT_INNERTUBE_BASE = "https://www.youtube.com/youtubei/v1";
const OAUTH_TOKEN_URL = "https://oauth2.googleapis.com/token";

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
  if (!root || typeof root !== "object" || depth > 35 || out.length >= 40) return out;
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
      if (out.length >= 40) break;
    }
  } else {
    for (const val of Object.values(root)) {
      if (val && typeof val === "object") {
        collectInnertubeRenderers(val, out, depth + 1);
        if (out.length >= 40) break;
      }
    }
  }
  return out;
}

function mapInnertubeEntry(entry) {
  const { type, data } = entry;
  if (type === "video") {
    const videoId = data.videoId;
    const title = extractText(data.title) || `Video ${videoId}`;
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

async function fetchItemsByQuery(queryText, options = {}) {
  const { searchType = "video,playlist,channel", pageToken = "", maxResults = 18, videoCategoryId = "" } = options;

  const apiParams = {
    part: "snippet",
    q: queryText,
    type: searchType,
    maxResults: String(maxResults),
    regionCode: getRegionCode()
  };
  if (pageToken) apiParams.pageToken = pageToken;
  if (videoCategoryId && searchType === "video") apiParams.videoCategoryId = videoCategoryId;

  const apiData = await ytDataApiFetch("search", apiParams);
  if (apiData && Array.isArray(apiData.items) && apiData.items.length > 0) {
    const items = apiData.items.map(mapDataApiItem).filter(Boolean);
    return {
      items,
      next: apiData.nextPageToken || undefined
    };
  }

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
  return { items };
}

export async function home() {
  const rows = [];
  const region = getRegionCode();

  const popularData = await ytDataApiFetch("videos", {
    part: "snippet",
    chart: "mostPopular",
    regionCode: region,
    maxResults: "15"
  });

  if (popularData && Array.isArray(popularData.items) && popularData.items.length > 0) {
    const items = popularData.items.map(mapDataApiItem).filter(Boolean);
    if (items.length > 0) {
      rows.push({
        id: "trending",
        title: "Tendencias en YouTube",
        ref: "cat:trending",
        genre: "entretenimiento",
        items
      });
    }
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

  if (cleanRef.startsWith("playlist:")) {
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

  if (cleanRef.startsWith("channel:")) {
    const channelId = cleanRef.slice("channel:".length);
    return await fetchItemsByQuery(channelId, { searchType: "video", pageToken: cursor || "" });
  }

  const catId = cleanRef.replace(/^cat:/, "");
  const foundCat = HOME_CATEGORIES.find(c => c.id === catId || c.ref === cleanRef) || HOME_CATEGORIES[0];

  if (foundCat.id === "trending" && !cursor) {
    const popularData = await ytDataApiFetch("videos", {
      part: "snippet",
      chart: "mostPopular",
      regionCode: getRegionCode(),
      maxResults: "20"
    });
    if (popularData && Array.isArray(popularData.items) && popularData.items.length > 0) {
      return {
        items: popularData.items.map(mapDataApiItem).filter(Boolean),
        next: popularData.nextPageToken || undefined
      };
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
    const raw = await ytInnertubeFetch("browse", { browseId });
    const renderers = collectInnertubeRenderers(raw);
    const epList = [];
    const seen = new Set();
    for (const r of renderers) {
      if (r.type === "video" && r.data && r.data.videoId && !seen.has(r.data.videoId)) {
        const vid = r.data.videoId;
        seen.add(vid);
        epList.push({
          season: 1,
          number: epList.length + 1,
          ref: `video:${vid}`,
          title: extractText(r.data.title) || `Video ${epList.length + 1}`,
          still: `https://i.ytimg.com/vi/${vid}/hqdefault.jpg`,
          overview: extractText(r.data.shortBylineText) || ""
        });
      }
    }
    return {
      series: { title: "Lista de reproducción de YouTube" },
      episodes: epList
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
      return await episodes(`playlist:${uploadsPlaylistId}`);
    }

    if (channelId.startsWith("UC") && channelId.length > 4) {
      const uuPlaylist = "UU" + channelId.slice(2);
      const fromUploads = await episodes(`playlist:${uuPlaylist}`);
      if (fromUploads.episodes && fromUploads.episodes.length > 0) {
        return fromUploads;
      }
    }

    const searchPage = await fetchItemsByQuery(channelId, { searchType: "video", maxResults: 25 });
    const epList = (searchPage.items || [])
      .filter(it => it.ref.startsWith("video:"))
      .map((it, idx) => ({
        season: 1,
        number: idx + 1,
        ref: it.ref,
        title: it.title,
        still: it.poster,
        overview: it.overview
      }));

    return {
      series: { title: "Videos del canal" },
      episodes: epList
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

function extractSubtitlesAndAudio(data, prefLang) {
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
      if (track.isTranslatable && !translatableTrack) {
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

  const audioList = [];
  const seenAudio = new Set();
  const adaptive = (data && data.streamingData && Array.isArray(data.streamingData.adaptiveFormats))
    ? data.streamingData.adaptiveFormats
    : [];

  const audioFormats = adaptive
    .filter(f => f && typeof f.url === "string" && f.url.startsWith("https://") && String(f.mimeType || "").startsWith("audio/"))
    .sort((a, b) => (Number(b.bitrate) || 0) - (Number(a.bitrate) || 0));

  for (const fmt of audioFormats) {
    const trackInfo = fmt.audioTrack || {};
    const rawId = String(trackInfo.id || "");
    const langCode = rawId ? rawId.split(".")[0] : "";
    const label = trackInfo.displayName || langCode || "Audio original";
    const key = langCode || label;
    if (seenAudio.has(key)) continue;
    seenAudio.add(key);

    audioList.push({
      lang: langCode || prefLang,
      url: fmt.url,
      label: trackInfo.audioIsDefault ? label + " (Predeterminado)" : label
    });
  }

  audioList.sort((a, b) => {
    const aPref = (a.lang === prefLang || a.lang.startsWith(prefLang + "-")) ? 0 : 1;
    const bPref = (b.lang === prefLang || b.lang.startsWith(prefLang + "-")) ? 0 : 1;
    return aPref - bPref;
  });

  return { subtitles: subList, audioTracks: audioList };
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
      osName: "Android",
      osVersion: "14",
      userAgent: "com.google.android.apps.youtube.vr.oculus/1.61.48 (Linux; U; Android 14; es_AR) gzip"
    },
    {
      clientName: "TVHTML5_SIMPLY_EMBEDDED_PLAYER",
      clientVersion: "2.0",
      userAgent: "Mozilla/5.0 (PlayStation; PlayStation 5/2.26) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/13.0 Safari/605.1.15"
    }
  ];

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
            hl: prefLang,
            gl: getRegionCode()
          },
          thirdParty: {
            embedUrl: "https://www.youtube.com/"
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

      const { subtitles, audioTracks } = extractSubtitlesAndAudio(data, prefLang);

      const alternatives = [];
      const combinedFormats = [
        ...(Array.isArray(streamingData.formats) ? streamingData.formats : []),
        ...(Array.isArray(streamingData.adaptiveFormats) ? streamingData.adaptiveFormats : [])
      ].filter(f => f && typeof f.url === "string" && f.url.startsWith("https://"));

      for (const fmt of combinedFormats) {
        const mimeType = String(fmt.mimeType || "").split(";")[0].trim() || "video/mp4";
        if (mimeType.startsWith("video/")) {
          alternatives.push({
            url: fmt.url,
            mime: mimeType,
            label: fmt.qualityLabel || fmt.quality || "MP4"
          });
        }
      }

      if (typeof streamingData.hlsManifestUrl === "string" && streamingData.hlsManifestUrl.startsWith("https://")) {
        return {
          url: streamingData.hlsManifestUrl,
          mime: "application/x-mpegURL",
          headers: { "User-Agent": client.userAgent },
          subtitles: subtitles.length > 0 ? subtitles : undefined,
          audioTracks: audioTracks.length > 0 ? audioTracks : undefined,
          alternatives: alternatives.length > 0 ? alternatives.slice(0, 5) : undefined,
          expiresInSeconds: Number(streamingData.expiresInSeconds) || 21600
        };
      }

      const progressiveFormats = (Array.isArray(streamingData.formats) ? streamingData.formats : [])
        .filter(f => f && typeof f.url === "string" && f.url.startsWith("https://"))
        .sort((a, b) => (Number(b.height) || 0) - (Number(a.height) || 0));

      if (progressiveFormats.length > 0) {
        const best = progressiveFormats[0];
        return {
          url: best.url,
          mime: "video/mp4",
          headers: { "User-Agent": client.userAgent },
          subtitles: subtitles.length > 0 ? subtitles : undefined,
          audioTracks: audioTracks.length > 0 ? audioTracks : undefined,
          alternatives: progressiveFormats.slice(1).map(f => ({
            url: f.url,
            mime: "video/mp4",
            label: f.qualityLabel || "MP4"
          })),
          expiresInSeconds: Number(streamingData.expiresInSeconds) || 21600
        };
      }

      if (alternatives.length > 0) {
        return {
          url: alternatives[0].url,
          mime: alternatives[0].mime || "video/mp4",
          headers: { "User-Agent": client.userAgent },
          subtitles: subtitles.length > 0 ? subtitles : undefined,
          audioTracks: audioTracks.length > 0 ? audioTracks : undefined,
          alternatives: alternatives.slice(1, 5),
          expiresInSeconds: Number(streamingData.expiresInSeconds) || 21600
        };
      }

      await kino.sleep(100);
    } catch (err) {
      kino.log(`Aviso en cliente ${client.clientName}:`, String(err));
    }
  }

  throw new Error(`No se encontró un flujo reproducible directo para el video ${videoId}`);
}
