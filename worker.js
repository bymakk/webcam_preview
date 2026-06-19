/* =========================================================================
 * Webcam Preview — прокси-резолвер (Cloudflare Worker)
 *
 * Зачем нужен: браузер на GitHub Pages не может напрямую вызвать API
 * Chaturbate/Stripchat (нет CORS-заголовков + у Stripchat анти-бот).
 * Этот воркер делает серверный запрос и отдаёт фронту маленький JSON
 * с CORS: { online, imageUrl, hlsUrl, page }.
 *
 * Сами потоки (HLS-сегменты с doppiocdn / mmcdn) и картинки грузятся
 * браузером напрямую с CDN — у них Access-Control-Allow-Origin: *.
 *
 * Маршруты:
 *   GET /health
 *   GET /resolve?platform=chaturbate&user=NAME
 *   GET /resolve?platform=stripchat&user=NAME
 *
 * Деплой:  npx wrangler deploy   (см. README.md)
 * ====================================================================== */

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/124.0 Safari/537.36';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': '*',
  'Cache-Control': 'no-store',
};

export default {
  async fetch(request) {
    const url = new URL(request.url);

    if (request.method === 'OPTIONS') return new Response(null, { headers: CORS });

    if (url.pathname === '/health') return json({ ok: true });

    if (url.pathname === '/resolve') {
      const platform = (url.searchParams.get('platform') || '').toLowerCase();
      const user = sanitize(url.searchParams.get('user') || '');
      if (!user) return json({ ok: false, error: 'bad user' }, 400);
      try {
        if (platform === 'chaturbate') return json(await resolveChaturbate(user));
        if (platform === 'stripchat') return json(await resolveStripchat(user));
        return json({ ok: false, error: 'unknown platform' }, 400);
      } catch (e) {
        return json({ ok: false, online: false, error: String(e && e.message || e) }, 200);
      }
    }

    return json({ ok: false, error: 'not found' }, 404);
  },
};

/* --------------------------------------------------------------------- */
function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: Object.assign({ 'Content-Type': 'application/json' }, CORS),
  });
}

// Только безопасные символы логина -> защита от SSRF/инъекции в путь.
// Дополнительно отбрасываем чисто-точечные значения ('.', '..'), чтобы нельзя
// было пройтись вверх по пути upstream-хоста (../cam и т.п.).
function sanitize(v) {
  v = String(v).trim().replace(/[^A-Za-z0-9_.\-]/g, '').slice(0, 64);
  if (!/[A-Za-z0-9]/.test(v)) return '';   // должен быть хотя бы один буквенно-цифровой символ
  return v;
}

/* ----------------------------- Chaturbate ----------------------------- */
async function resolveChaturbate(user) {
  const page = `https://chaturbate.com/${user}/`;
  const imageUrl = `https://jpeg.live.mmcdn.com/stream?room=${user}`;

  const res = await fetch('https://chaturbate.com/get_edge_hls_url_ajax/', {
    method: 'POST',
    headers: {
      'User-Agent': UA,
      'X-Requested-With': 'XMLHttpRequest',
      'Content-Type': 'application/x-www-form-urlencoded',
      'Referer': page,
    },
    body: 'room_slug=' + encodeURIComponent(user),
  });

  let data = {};
  try { data = await res.json(); } catch (e) {}

  const online = data.room_status === 'public';
  return {
    ok: true,
    platform: 'chaturbate',
    user,
    online,
    status: data.room_status || 'unknown',
    hlsUrl: online && data.url ? data.url : null,
    imageUrl,
    page,
  };
}

/* ------------------------------ Stripchat ----------------------------- */
async function resolveStripchat(user) {
  const page = `https://stripchat.com/${user}`;
  const api = `https://stripchat.com/api/front/v2/models/username/${user}/cam`;

  const res = await fetch(api, {
    headers: {
      'User-Agent': UA,
      'Accept': 'application/json, text/plain, */*',
      'Referer': page,
      'Accept-Language': 'en-US,en;q=0.9',
    },
  });

  let data = {};
  try { data = await res.json(); } catch (e) {}

  const u = (data.user && data.user.user) || {};
  const cam = data.cam || {};
  const modelId = u.id || cam.streamName || null;

  const live =
    u.status === 'public' ||
    u.isLive === true ||
    cam.isCamActive === true ||
    cam.isCamAvailable === true;
  const online = !!modelId && live && !data.isGeoBanned;

  // HLS: edge-hls.doppiocdn.com (CDN отдаёт CORS *). Stream обфусцирован
  // с авг. 2025 (Mouflon) — видео best-effort, по умолчанию для SC лучше IMG.
  const streamName = cam.streamName || modelId;
  const hlsUrl = online && streamName
    ? `https://edge-hls.doppiocdn.com/hls/${streamName}/master/${streamName}_auto.m3u8`
    : null;

  // Снимок-превью. previewUrl — полноразмерный «живой» снимок (обновляется
  // на стороне Stripchat), дальше идут уменьшенные миниатюры. Все поля —
  // абсолютные URL на static-proxy.strpst.com (проверено на живом ответе).
  const imageUrl =
    u.previewUrl || u.previewUrlThumbBig || u.previewUrlThumbSmall ||
    u.snapshotUrl || null;

  return {
    ok: true,
    platform: 'stripchat',
    user,
    modelId,
    online,
    status: u.status || (online ? 'public' : 'offline'),
    hlsUrl,
    imageUrl,
    page,
  };
}
