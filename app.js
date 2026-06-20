/* =========================================================================
 * Webcam Preview — статический дашборд мониторинга превью Chaturbate/Stripchat
 *
 *  • Chaturbate картинка  -> напрямую (jpeg.live.mmcdn.com, CORS: *)
 *  • Всё остальное (видео, Stripchat) -> через опциональный прокси
 *    (Cloudflare Worker), который резолвит логин -> {online, imageUrl, hlsUrl}.
 *
 * Без прокси Chaturbate-картинки работают сразу. Прокси включает видео и
 * Stripchat. Всё деградирует мягко.
 * ====================================================================== */
(function () {
  'use strict';

  /* ----------------------------- Константы ------------------------------ */
  var STORAGE_KEY = 'webcam_preview_v1';
  var CB_VIDEO_INTERVAL_MS = 150;   // «видео» Chaturbate = частый опрос кадров (~6-7 fps)

  var DEFAULTS = {
    settings: { cols: 4, intervalMs: 500, defaultMode: 'image' },
    models: []
  };

  /* ------------------------------- DOM ---------------------------------- */
  var $ = function (s, r) { return (r || document).querySelector(s); };
  var grid = $('#grid');
  var emptyEl = $('#empty');
  var countEl = $('#model-count');
  var ctxMenu = $('#context-menu');
  var toastEl = $('#toast');

  /* ------------------------------ Состояние ----------------------------- */
  var state = load();
  var settings = state.settings;
  var tiles = new Map();          // id -> { el, ctrl, sig }
  var dragId = null;
  var ctxModelId = null;
  var editingId = null;           // null => режим добавления

  /* =======================================================================
   *  Хранилище
   * ==================================================================== */
  function load() {
    try {
      var raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return clone(DEFAULTS);
      var data = JSON.parse(raw);
      return {
        settings: Object.assign({}, DEFAULTS.settings, data.settings || {}),
        models: (Array.isArray(data.models) ? data.models : []).map(normalizeModel)
      };
    } catch (e) { return clone(DEFAULTS); }
  }
  function save() {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(state)); } catch (e) {}
  }
  function clone(o) { return JSON.parse(JSON.stringify(o)); }
  function uid() { return 'm' + Math.random().toString(36).slice(2, 9) + (tiles.size); }

  /* =======================================================================
   *  Провайдеры превью
   * ==================================================================== */
  // Живой кадр Chaturbate. jpeg.live/stream отдаёт ОДИН свежий JPEG на запрос
  // (online -> 200, offline -> 204). Опрашиваем часто (~2+/сек) с инкрементом c.
  function cbStreamUrl(user, seq) {
    return 'https://jpeg.live.mmcdn.com/stream?room=' + encodeURIComponent(user) + '&c=' + seq;
  }
  function livePageUrl(platform, user) {
    return platform === 'chaturbate'
      ? 'https://chaturbate.com/' + encodeURIComponent(user) + '/'
      : 'https://stripchat.com/' + encodeURIComponent(user);
  }

  /* ===================== Stripchat: свой плеер, без прокси/виджета =====================
   * 1) логин -> id + превью (go.xxxiijmp.com, CORS открыт)
   * 2) мастер-плейлист doppiocdn (CORS *) -> pkey
   * 3) вариант + ?psch=v2&pkey -> живой плейлист; реальные сегменты в
   *    строках #EXT-X-MOUFLON:URI (видимые .mp4 — обманки)
   * 4) играем в hls.js с кастомным загрузчиком (подмена сегментов; при
   *    зашифрованном URI — расшифровка ключом pdkey из публичного кэша)
   * ================================================================================== */
  var SC_RESOLVE = 'https://go.xxxiijmp.com/api/models?modelsList=';
  // Публичные CORS-прокси: пробуем по очереди, если прямой резолвер забанил IP.
  var SC_PROXIES = ['https://corsproxy.io/?url=', 'https://api.allorigins.win/raw?url='];
  var SC_MASTER = 'https://edge-hls.doppiocdn.com/hls/'; // + {id}/master/{id}_auto.m3u8
  var SC_KEYS_URL = 'https://raw.githubusercontent.com/kesamom/stripchat_mouflon/main/stripchat_mouflon_keys.json';

  var scCache = new Map();          // username -> { t, v:{online,id,previewUrl} }
  var mfKeys = null, mfKeysT = 0;   // кэш pkey->pdkey

  // Резолв логин->id. Партнёрский резолвер go.xxxiijmp.com части IP отдаёт 500
  // (бан сети). Тогда повторяем через публичный CORS-прокси — его IP не забанен.
  function scFetchModels(username) {
    var target = SC_RESOLVE + encodeURIComponent(username) + '&strict=1';
    var urls = [target].concat(SC_PROXIES.map(function (p) { return p + encodeURIComponent(target); }));
    return (function tryAt(i) {
      return fetch(urls[i], { cache: 'no-store' })
        .then(function (r) { if (!r.ok) throw new Error('s ' + r.status); return r.json(); })
        .catch(function (e) { if (i + 1 < urls.length) return tryAt(i + 1); throw e; });
    })(0);
  }
  function scResolve(username) {
    var c = scCache.get(username);
    if (c && Date.now() - c.t < 10000) return Promise.resolve(c.v);
    return scFetchModels(username).then(function (j) {
      var m = (j.models || [])[0];
      var v = m
        ? { online: true, id: m.id, previewUrl: m.previewUrl || m.snapshotUrl || m.previewUrlThumbBig }
        : { online: false };
      scCache.set(username, { t: Date.now(), v: v });
      return v;
    });
  }
  function getMouflonKeys() {
    if (mfKeys && Date.now() - mfKeysT < 600000) return Promise.resolve(mfKeys);
    return fetch(SC_KEYS_URL, { cache: 'no-store' }).then(function (r) { return r.json(); })
      .then(function (k) { mfKeys = k; mfKeysT = Date.now(); return k; })
      .catch(function () { return mfKeys || {}; });
  }
  // SHA256(pdkey) кэшируем (один ключ на весь поток) — не считаем на каждый сегмент.
  var mfHashCache = {};
  function sha256Bytes(key) {
    if (mfHashCache[key]) return Promise.resolve(mfHashCache[key]);
    return crypto.subtle.digest('SHA-256', new TextEncoder().encode(key)).then(function (b) {
      var h = new Uint8Array(b); mfHashCache[key] = h; return h;
    });
  }
  // base64 -> XOR с SHA256(pdkey) -> utf8
  function mouflonDecrypt(b64, pdkey) {
    return sha256Bytes(pdkey).then(function (hash) {
      var s = String(b64).replace(/=+$/, ''); while (s.length % 4) s += '=';
      var bin = atob(s), out = new Uint8Array(bin.length);
      for (var i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i) ^ hash[i % hash.length];
      return new TextDecoder().decode(out);
    });
  }
  // Реальный URL сегмента: предпоследний компонент (между '_') в #EXT-X-MOUFLON:URI
  // реверсим и расшифровываем (base64 + XOR SHA256(pdkey)), подставляем обратно.
  function decodeMouflonUri(uri, pdkey) {
    if (!pdkey) return Promise.resolve(uri);
    var parts = uri.split('_');
    if (parts.length < 2) return Promise.resolve(uri);
    var enc = parts[parts.length - 2];
    return mouflonDecrypt(enc.split('').reverse().join(''), pdkey)
      .then(function (dec) { return dec ? uri.replace(enc, dec) : uri; })
      .catch(function () { return uri; });
  }
  // Подменяем строки-обманки (media.mp4) реальными расшифрованными URL сегментов.
  function rewriteMediaPlaylist(text, pdkey) {
    var lines = text.split('\n'), idx = [];
    for (var i = 0; i < lines.length; i++) {
      var m = lines[i].match(/^#EXT-X-MOUFLON:URI:(.*)$/);
      if (m) idx.push({ i: i, uri: m[1].trim() });
    }
    var real = {}, p = Promise.resolve();
    idx.forEach(function (it) {
      p = p.then(function () { return decodeMouflonUri(it.uri, pdkey).then(function (u) { real[it.i] = u; }); });
    });
    return p.then(function () {
      var out = [], pending = null;
      for (var i = 0; i < lines.length; i++) {
        var line = lines[i];
        if (/^#EXT-X-MOUFLON:URI:/.test(line)) { pending = real[i] || null; continue; }
        if (pending && /^https?:\/\//.test(line.trim())) { out.push(pending); pending = null; continue; }
        out.push(line);
      }
      return out.join('\n');
    });
  }
  // Кастомный загрузчик плейлистов для hls.js: добавляет psch/pkey к медиа-плейлистам
  // и переписывает сегменты. pkey берём из мастера, pdkey — из кэша.
  function makeScPLoader(shared, keys) {
    var Base = window.Hls.DefaultConfig.loader;
    function ScPLoader(cfg) { this.base = new Base(cfg); }
    ScPLoader.prototype.load = function (context, config, callbacks) {
      if (context.type === 'level' && shared.pkey && context.url.indexOf('psch=') < 0) {
        context.url += (context.url.indexOf('?') >= 0 ? '&' : '?') + 'psch=v2&pkey=' + encodeURIComponent(shared.pkey);
      }
      var onSuccess = callbacks.onSuccess;
      callbacks.onSuccess = function (response, stats, ctx, net) {
        var d = response.data;
        if (typeof d === 'string' && d.indexOf('#EXT-X-STREAM-INF') >= 0) {
          var found = (d.match(/PSCH:v2:([A-Za-z0-9]+)/g) || []).map(function (s) { return s.split(':').pop(); });
          shared.pkey = found.filter(function (k) { return keys[k]; })[0] || found[0] || shared.pkey;
          shared.pdkey = shared.pkey ? keys[shared.pkey] : null;
        }
        if (typeof d === 'string' && d.indexOf('#EXT-X-MOUFLON:URI:') >= 0) {
          rewriteMediaPlaylist(d, shared.pdkey).then(function (fixed) {
            response.data = fixed; onSuccess(response, stats, ctx, net);
          });
          return;
        }
        onSuccess(response, stats, ctx, net);
      };
      this.base.load(context, config, callbacks);
    };
    ScPLoader.prototype.abort = function () { this.base.abort(); };
    ScPLoader.prototype.destroy = function () { this.base.destroy(); };
    Object.defineProperty(ScPLoader.prototype, 'stats', { get: function () { return this.base.stats; } });
    Object.defineProperty(ScPLoader.prototype, 'context', { get: function () { return this.base.context; } });
    return ScPLoader;
  }

  /* =======================================================================
   *  Preview controller — управляет одним превью внутри плитки
   * ==================================================================== */
  function Preview(model, refs) {
    this.model = model;
    this.media = refs.media;
    this.stateEl = refs.state;
    this.gen = 0;
    this.timer = null;
    this.embed = null;
    this.frameSeq = 0;
  }
  Preview.prototype.setModel = function (m) { this.model = m; };
  // Режим однозначно задаёт площадку: КАРТИНКА = Chaturbate (jpeg.live),
  // ВИДЕО = Stripchat (hls). Картинка без CB и видео без SC невозможны.
  Preview.prototype.platform = function () {
    return this.model.mode === 'video' ? 'stripchat' : 'chaturbate';
  };
  Preview.prototype.user = function () { return this.model[this.platform()]; };

  Preview.prototype.start = function () {
    this.gen++;
    var g = this.gen;
    this.clearTimer();
    this.destroyHls();
    this.setNote('');
    this.setLive(''); // сброс индикатора
    // Видео -> Stripchat (свой hls.js плеер с расшифровкой Mouflon).
    // Картинка -> Chaturbate (поток JPEG-кадров jpeg.live). Всё без прокси.
    if (this.model.mode === 'video') this.runScVideo(g);
    else this.runImage(g);
  };
  Preview.prototype.stop = function () {
    this.gen++;
    this.clearTimer();
    this.destroyHls();
  };
  Preview.prototype.clearTimer = function () { if (this.timer) { clearTimeout(this.timer); this.timer = null; } };
  Preview.prototype.destroyHls = function () {
    if (this.hls) { try { this.hls.destroy(); } catch (e) {} this.hls = null; }
    // Удаляем сам видеоэлемент, иначе при переключении видео->картинка он
    // остаётся чёрным поверх новой картинки.
    var v = this.media.querySelector('video');
    if (v) { try { v.pause(); v.removeAttribute('src'); v.load(); } catch (e) {} v.remove(); }
  };

  /* ---- Stripchat видео: свой hls.js плеер ---- */
  Preview.prototype.runScVideo = function (g) {
    var self = this, user = this.user();
    this.showState('loading');
    scResolve(user).then(function (d) {
      if (self.gen !== g) return;
      if (!d.online || !d.id) { self.setLive('offline'); self.showState('offline'); return; }
      self.setLive('online');
      getMouflonKeys().then(function (keys) { if (self.gen === g) self.mountHls(g, d.id, keys); });
    }).catch(function () { if (self.gen === g) { self.setLive('offline'); self.showState('error'); } });
  };
  Preview.prototype.mountHls = function (g, id, keys) {
    var self = this;
    if (!window.Hls || !window.Hls.isSupported()) { // iOS Safari и т.п. -> картинка
      this.setNote('видео не поддерживается — картинка'); this.runScImage(g); return;
    }
    this.media.innerHTML = '';
    var video = document.createElement('video');
    video.muted = true; video.autoplay = true; video.playsInline = true;
    video.setAttribute('playsinline', ''); video.draggable = false;
    video.addEventListener('canplay', function () { video.play().catch(function () {}); });
    this.media.appendChild(video);
    var shared = { pkey: null, pdkey: null };
    var hls = new window.Hls({
      pLoader: makeScPLoader(shared, keys),
      capLevelToPlayerSize: true,
      // У Stripchat длина сегментов разная (2-8с), окно плейлиста маленькое.
      // Отставание задаём в СЕКУНДАХ (не в сегментах!): держимся ~8с позади
      // края — в пределах окна, поэтому сегменты грузятся строго по порядку,
      // без перескоков. Перескок мимо окна = разрыв = двоение кадров на стыке.
      liveSyncDuration: 8,
      liveMaxLatencyDuration: 20,
      maxLiveSyncPlaybackRate: 1,    // не ускоряемся, чтобы «догнать край» (без рывков)
      maxBufferLength: 24,
      backBufferLength: 30,
      maxBufferHole: 0.5,            // мостим крошечные дыры, не делая полный сик
      nudgeMaxRetry: 8,              // мелкие застревания подталкиваем, а не прыгаем
      manifestLoadingMaxRetry: 4,
      fragLoadingMaxRetry: 6
    });
    this.hls = hls;
    // _auto = ABR-лестница транскодированных пресетов (1080p/720p/480p/240p),
    // а не сырой «source» (он у части моделей нестабилен -> дёрганье). hls.js
    // с capLevelToPlayerSize выберет качество под размер плитки.
    hls.loadSource(SC_MASTER + id + '/master/' + id + '_auto.m3u8');
    hls.attachMedia(video);
    hls.on(window.Hls.Events.MANIFEST_PARSED, function () {
      if (self.gen === g) { self.hideState(); video.play().catch(function () {}); }
    });
    hls.on(window.Hls.Events.ERROR, function (e, data) {
      if (!data || !data.fatal) return;
      if (data.type === window.Hls.ErrorTypes.NETWORK_ERROR) { try { hls.startLoad(); } catch (x) {} }
      else if (data.type === window.Hls.ErrorTypes.MEDIA_ERROR) { try { hls.recoverMediaError(); } catch (x) {} }
      else { self.destroyHls(); if (self.gen === g) { self.setNote('видео недоступно — картинка'); self.runScImage(g); } }
    });
  };

  /* ---- Stripchat картинка: снимок previewUrl (без прокси) ---- */
  Preview.prototype.runScImage = function (g) {
    var self = this, user = this.user();
    scResolve(user).then(function (d) {
      if (self.gen !== g) return;
      self.setLive(d.online ? 'online' : 'offline');
      if (d.online && d.previewUrl) {
        var url = d.previewUrl + (d.previewUrl.indexOf('?') >= 0 ? '&' : '?') + 'c=' + Date.now();
        var img = new Image(); img.draggable = false; img.alt = '';
        img.onload = function () { if (self.gen === g) { self.swapFrame(img); self.scheduleSc(g); } };
        img.onerror = function () { if (self.gen === g) self.scheduleSc(g); };
        img.src = url;
      } else { self.showState('offline'); self.scheduleSc(g); }
    }).catch(function () { if (self.gen === g) { self.showState('error'); self.scheduleSc(g); } });
  };
  Preview.prototype.scheduleSc = function (g) {
    var self = this; this.clearTimer();
    this.timer = setTimeout(function () { if (self.gen === g) self.runScImage(g); }, Math.max(4000, settings.intervalMs || 500));
  };

  /* ---- картинка Chaturbate: фиксированная частота опроса jpeg.live (~2+/сек) ---- */
  Preview.prototype.runImage = function (g) {
    this.lastShown = 0;   // seq последнего показанного кадра
    this.tick(g);
  };
  Preview.prototype.tick = function (g) {
    var self = this;
    // Следующий опрос — строго через интервал, НЕ дожидаясь загрузки кадра.
    // «Видео» = высокий fps, «картинка» = настраиваемый период.
    this.clearTimer();
    var ms = this.model.mode === 'video' ? CB_VIDEO_INTERVAL_MS : (settings.intervalMs || 500);
    this.timer = setTimeout(function () { if (self.gen === g) self.tick(g); }, ms);
    var seq = ++this.frameSeq;
    var img = new Image();
    img.draggable = false; img.alt = '';
    img.onload = function () {
      if (self.gen !== g || seq <= self.lastShown) return; // не показываем устаревший кадр
      self.lastShown = seq;
      self.swapFrame(img);
      self.setLive('online');
    };
    img.onerror = function () {            // offline -> jpeg.live отдаёт 204 (пусто)
      if (self.gen !== g || seq <= self.lastShown) return;
      self.lastShown = seq;
      self.setLive('offline');
      if (!self.media.querySelector('img')) self.showState('offline');
    };
    img.src = cbStreamUrl(this.user(), seq);
  };
  // Двойная буферизация: новый кадр уже декодирован (сработал onload),
  // вставляем его и убираем предыдущий — переключение без мигания/недокадров.
  Preview.prototype.swapFrame = function (img) {
    var olds = this.media.querySelectorAll('img');
    this.media.appendChild(img);
    for (var i = 0; i < olds.length; i++) olds[i].remove();
    this.hideState();
  };

  /* ---- отрисовка состояния ---- */
  Preview.prototype.setImg = function (src) {
    var img = this.media.querySelector('img');
    if (!img) {
      this.media.innerHTML = '';
      img = document.createElement('img');
      img.draggable = false; img.alt = '';
      this.media.appendChild(img);
    }
    img.src = src;
    this.hideState();
  };
  Preview.prototype.hideState = function () { this.stateEl.classList.add('hidden'); };
  Preview.prototype.showState = function (kind) {
    var map = {
      loading: { html: '<div class="spinner"></div><span>Загрузка…</span>' },
      offline: { html: '<div class="state-emoji">🌙</div><span>Не в эфире</span>' },
      error:   { html: '<div class="state-emoji">⚠️</div><span>Ошибка загрузки</span>' },
      noimg:   { html: '<div class="state-emoji">🖼️</div><span>Нет превью</span>' },
    };
    var s = map[kind] || map.error;
    this.stateEl.innerHTML = s.html;
    this.stateEl.classList.remove('hidden');
  };
  Preview.prototype.setLive = function () {}; // индикатор LIVE/OFF убран
  Preview.prototype.setNote = function () {}; // плашка-заметка убрана

  /* =======================================================================
   *  Плитки / рендер
   * ==================================================================== */
  function svg(path) {
    return '<svg viewBox="0 0 24 24" class="icon">' + path + '</svg>';
  }
  var ICON = {
    edit: '<path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.1 2.1 0 0 1 3 3L12 15l-4 1 1-4z"/>',
    img:  '<rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><path d="M21 15l-5-5L5 21"/>',
    video:'<path d="M23 7l-7 5 7 5V7z"/><rect x="1" y="5" width="15" height="14" rx="2"/>',
    swap: '<path d="M17 1l4 4-4 4"/><path d="M3 11V9a4 4 0 0 1 4-4h14"/><path d="M7 23l-4-4 4-4"/><path d="M21 13v2a4 4 0 0 1-4 4H3"/>',
    open: '<path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><path d="M15 3h6v6"/><path d="M10 14L21 3"/>',
    left: '<path d="M19 12H5"/><path d="M12 19l-7-7 7-7"/>',
    right:'<path d="M5 12h14"/><path d="M12 5l7 7-7 7"/>',
    trash:'<path d="M3 6h18"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6M14 11v6"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>'
  };

  function platformList(m) {
    var arr = [];
    if (m.chaturbate) arr.push({ p: 'chaturbate', tag: 'CB', cls: 'cb', user: m.chaturbate });
    if (m.stripchat) arr.push({ p: 'stripchat', tag: 'SC', cls: 'sc', user: m.stripchat });
    return arr;
  }
  function activePlatform(m) {
    return m.mode === 'video' ? 'stripchat' : 'chaturbate'; // картинка=CB, видео=SC
  }
  // Режим должен соответствовать логинам: нет SC -> картинка, нет CB -> видео.
  function normalizeModel(m) {
    if (!m.stripchat) m.mode = 'image';
    else if (!m.chaturbate) m.mode = 'video';
    else if (m.mode !== 'video' && m.mode !== 'image') m.mode = 'image';
    m.primary = m.mode === 'video' ? 'stripchat' : 'chaturbate';
    return m;
  }
  function sigOf(m) { return m.mode + '|' + (m.chaturbate || '') + '|' + (m.stripchat || ''); }

  function createTile(m) {
    var el = document.createElement('div');
    el.className = 'tile';
    el.dataset.id = m.id;
    el.draggable = true;
    el.tabIndex = 0;                       // фокусируемость с клавиатуры
    el.setAttribute('role', 'group');
    el.innerHTML =
      '<div class="tile-media"></div>' +
      '<div class="tile-state"></div>' +
      '<div class="tile-top">' +
        '<span class="badge mode"></span>' +
      '</div>' +
      '<div class="tile-overlay">' +
        '<div class="tile-logins"></div>' +
        '<div class="overlay-actions">' +
          '<button class="overlay-btn" data-act="edit" title="Редактировать">' + svg(ICON.edit) + '</button>' +
        '</div>' +
      '</div>';

    var refs = {
      media: $('.tile-media', el),
      state: $('.tile-state', el)
    };
    var ctrl = new Preview(m, refs);
    var entry = { el: el, ctrl: ctrl, sig: sigOf(m) };

    wireTileEvents(el, m.id);
    buildBadges(entry, m);
    buildOverlay(entry, m);
    ctrl.start();
    return entry;
  }

  function buildBadges(entry, m) {
    var modeEl = $('.badge.mode', entry.el); // только индикатор режима (видео/фото)
    modeEl.innerHTML = (m.mode === 'video' ? svg(ICON.video) + 'Видео' : svg(ICON.img) + 'Фото');
    modeEl.style.gap = '5px';
  }

  function buildOverlay(entry, m) {
    var box = $('.tile-logins', entry.el);
    box.innerHTML = '';
    entry.el.setAttribute('aria-label',
      'Модель: ' + platformList(m).map(function (it) { return it.tag + ' ' + it.user; }).join(', ') +
      '. ' + (m.mode === 'video' ? 'видео' : 'картинка') + '. Меню — клавиша контекста или Enter.');
    platformList(m).forEach(function (it) {
      var a = document.createElement('a');
      a.className = 'login-link';
      a.href = livePageUrl(it.p, it.user);
      a.target = '_blank'; a.rel = 'noopener noreferrer';
      a.draggable = false;
      a.innerHTML = '<span class="platform-badge ' + it.cls + '">' + it.tag + '</span>' +
                    '<span class="name">' + escapeHtml(it.user) + '</span>';
      box.appendChild(a);
    });
  }

  function updateTile(entry, m) {
    entry.ctrl.setModel(m);
    buildBadges(entry, m);
    buildOverlay(entry, m);
    var sig = sigOf(m);
    if (entry.sig !== sig) { entry.sig = sig; entry.ctrl.start(); }
  }

  function render() {
    var has = state.models.length > 0;
    emptyEl.classList.toggle('show', !has);
    grid.style.display = has ? 'grid' : 'none';
    countEl.textContent = state.models.length;
    document.documentElement.style.setProperty('--cols', settings.cols);

    var seen = new Set();
    state.models.forEach(function (m) {
      seen.add(m.id);
      var entry = tiles.get(m.id);
      if (!entry) { entry = createTile(m); tiles.set(m.id, entry); }
      else { updateTile(entry, m); }
      grid.appendChild(entry.el); // переупорядочивает существующие узлы
    });
    tiles.forEach(function (entry, id) {
      if (!seen.has(id)) { entry.ctrl.stop(); entry.el.remove(); tiles.delete(id); }
    });
  }

  function refreshAll() {
    tiles.forEach(function (entry) { entry.ctrl.start(); });
    toast('Превью обновлены');
  }

  /* =======================================================================
   *  Drag & drop (нативный HTML5) — перетаскивание плиток
   * ==================================================================== */
  function wireTileEvents(el, id) {
    el.addEventListener('dragstart', function (e) {
      dragId = id;
      el.classList.add('dragging');
      e.dataTransfer.effectAllowed = 'move';
      try { e.dataTransfer.setData('text/plain', id); } catch (x) {}
    });
    el.addEventListener('dragend', function () {
      dragId = null;
      el.classList.remove('dragging');
      clearDragOver();
    });
    el.addEventListener('dragover', function (e) {
      if (dragId == null || dragId === id) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      clearDragOver();
      el.classList.add('drag-over');
    });
    el.addEventListener('drop', function (e) {
      if (dragId == null || dragId === id) return;
      e.preventDefault();
      var rect = el.getBoundingClientRect();
      var after = (e.clientX - rect.left) > rect.width / 2;
      reorder(dragId, id, after);
      clearDragOver();
    });

    // contextmenu
    el.addEventListener('contextmenu', function (e) {
      e.preventDefault();
      openContextMenu(id, e.clientX, e.clientY);
    });

    // кнопка-карандаш в оверлее
    el.addEventListener('click', function (e) {
      var btn = e.target.closest('[data-act="edit"]');
      if (btn) { e.preventDefault(); openModal(id); }
    });

    // клавиатура: ContextMenu / Shift+F10 / Enter — открыть меню у плитки
    el.addEventListener('keydown', function (e) {
      if (e.target !== el) return; // не перехватываем ввод в ссылках/кнопках
      var open = e.key === 'ContextMenu' || (e.shiftKey && e.key === 'F10') ||
                 e.key === 'Enter' || e.key === ' ';
      if (open) {
        e.preventDefault();
        var r = el.getBoundingClientRect();
        openContextMenu(id, r.left + 24, r.top + 36);
      }
    });
  }
  function clearDragOver() {
    var nodes = grid.querySelectorAll('.drag-over');
    for (var i = 0; i < nodes.length; i++) nodes[i].classList.remove('drag-over');
  }
  // Перемещение плитки на ±1 — путь без drag (тач/клавиатура).
  function moveModel(id, dir) {
    var i = state.models.findIndex(function (m) { return m.id === id; });
    var j = i + dir;
    if (i < 0 || j < 0 || j >= state.models.length) return;
    var tmp = state.models[i]; state.models[i] = state.models[j]; state.models[j] = tmp;
    save();
    render();
  }

  function reorder(srcId, targetId, after) {
    var models = state.models;
    var from = models.findIndex(function (m) { return m.id === srcId; });
    if (from < 0) return;
    var moved = models.splice(from, 1)[0];
    var to = models.findIndex(function (m) { return m.id === targetId; });
    if (to < 0) { models.push(moved); }
    else { models.splice(after ? to + 1 : to, 0, moved); }
    save();
    render();
  }

  /* =======================================================================
   *  Контекстное меню
   * ==================================================================== */
  function openContextMenu(id, x, y) {
    var m = getModel(id);
    if (!m) return;
    ctxModelId = id;
    markMenuOpen(id, true);

    var plats = platformList(m);
    var items = [];
    // Картинка доступна только при логине Chaturbate, видео — только при Stripchat.
    if (m.chaturbate && m.stripchat) {
      items.push({ label: 'Режим', header: true });
      items.push({ icon: ICON.img, label: 'Картинка (CB)', check: m.mode === 'image', act: function () { setMode(id, 'image'); } });
      items.push({ icon: ICON.video, label: 'Видео (SC)', check: m.mode === 'video', act: function () { setMode(id, 'video'); } });
      items.push({ sep: true });
    }

    var idx = state.models.findIndex(function (mm) { return mm.id === id; });
    var last = state.models.length - 1;
    items.push({ icon: ICON.left, label: 'Сдвинуть влево', disabled: idx <= 0, act: function () { moveModel(id, -1); } });
    items.push({ icon: ICON.right, label: 'Сдвинуть вправо', disabled: idx >= last, act: function () { moveModel(id, 1); } });

    items.push({ sep: true });
    items.push({ icon: ICON.edit, label: 'Редактировать', act: function () { openModal(id); } });
    plats.forEach(function (it) {
      items.push({
        icon: ICON.open, label: 'Открыть ' + (it.p === 'chaturbate' ? 'Chaturbate' : 'Stripchat'),
        act: function () { window.open(livePageUrl(it.p, it.user), '_blank', 'noopener'); }
      });
    });
    items.push({ sep: true });
    items.push({ icon: ICON.trash, label: 'Удалить', danger: true, act: function () { removeModel(id); } });

    ctxMenu.innerHTML = '';
    items.forEach(function (it) {
      if (it.sep) { ctxMenu.appendChild(div('ctx-sep')); return; }
      if (it.header) { var h = div('ctx-label'); h.textContent = it.label; ctxMenu.appendChild(h); return; }
      var row = div('ctx-item' + (it.danger ? ' danger' : '') + (it.disabled ? ' disabled' : ''));
      row.innerHTML = (it.icon ? svg(it.icon) : '<span class="icon"></span>') +
        '<span>' + escapeHtml(it.label) + '</span>' +
        (it.check ? '<span class="check">✓</span>' : '');
      if (!it.disabled) { row.tabIndex = -1; row.addEventListener('click', function () { closeContextMenu(); it.act(); }); }
      ctxMenu.appendChild(row);
    });

    ctxMenu.hidden = false;
    // позиционирование в пределах экрана
    var w = ctxMenu.offsetWidth, h = ctxMenu.offsetHeight;
    var px = Math.min(x, window.innerWidth - w - 8);
    var py = Math.min(y, window.innerHeight - h - 8);
    ctxMenu.style.left = Math.max(8, px) + 'px';
    ctxMenu.style.top = Math.max(8, py) + 'px';
    var first = ctxMenu.querySelector('.ctx-item:not(.disabled)');
    if (first) first.focus(); // фокус в меню для клавиатуры
  }
  function closeContextMenu() {
    if (ctxMenu.hidden) return;
    var hadFocus = ctxMenu.contains(document.activeElement);
    ctxMenu.hidden = true;
    if (ctxModelId != null) {
      markMenuOpen(ctxModelId, false);
      var entry = tiles.get(ctxModelId);
      if (entry && hadFocus) entry.el.focus(); // вернуть фокус на плитку
    }
    ctxModelId = null;
  }
  // навигация по меню стрелками / Enter
  ctxMenu.addEventListener('keydown', function (e) {
    var items = [].slice.call(ctxMenu.querySelectorAll('.ctx-item:not(.disabled)'));
    if (!items.length) return;
    var i = items.indexOf(document.activeElement);
    if (e.key === 'ArrowDown') { e.preventDefault(); items[(i + 1) % items.length].focus(); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); items[(i - 1 + items.length) % items.length].focus(); }
    else if (e.key === 'Enter' || e.key === ' ') {
      if (document.activeElement && document.activeElement.classList.contains('ctx-item')) {
        e.preventDefault(); document.activeElement.click();
      }
    }
  });
  function markMenuOpen(id, on) {
    var entry = tiles.get(id);
    if (entry) entry.el.classList.toggle('menu-open', on);
  }

  /* =======================================================================
   *  Мутации модели
   * ==================================================================== */
  function getModel(id) { return state.models.find(function (m) { return m.id === id; }); }
  function setMode(id, mode) {
    var m = getModel(id); if (!m) return;
    // картинка возможна только с CB, видео — только с SC
    if (mode === 'image' && !m.chaturbate) return;
    if (mode === 'video' && !m.stripchat) return;
    m.mode = mode;
    normalizeModel(m);
    save();
    updateTile(tiles.get(id), m);
  }
  function removeModel(id) {
    var i = state.models.findIndex(function (m) { return m.id === id; });
    if (i < 0) return;
    state.models.splice(i, 1);
    save();
    render();
    toast('Модель удалена');
  }

  /* =======================================================================
   *  Модалка добавления / редактирования
   * ==================================================================== */
  var modalBackdrop = $('#modal-backdrop');
  var form = $('#model-form');
  var inCb = $('#in-chaturbate');
  var inSc = $('#in-stripchat');
  var inMode = $('#in-mode');
  var choiceRow = $('#choice-row');
  var modeHint = $('#mode-hint');
  var formError = $('#form-error');

  function openModal(id) {
    editingId = id || null;
    var m = id ? getModel(id) : null;
    $('#modal-title').textContent = m ? 'Редактировать модель' : 'Добавить модель';
    $('#modal-save').textContent = m ? 'Сохранить' : 'Добавить';
    inCb.value = m ? (m.chaturbate || '') : '';
    inSc.value = m ? (m.stripchat || '') : '';
    inMode.value = m ? m.mode : 'image';
    formError.hidden = true;
    updateModalDynamics();
    modalBackdrop.hidden = false;
    setTimeout(function () { inCb.focus(); }, 30);
  }
  function closeModal() { modalBackdrop.hidden = true; editingId = null; }

  // Выбор режима — только при ДВУХ площадках (картинка = CB, видео = SC).
  // Для одной площадки режим определяется автоматически.
  function updateModalDynamics() {
    var cb = cleanLogin(inCb.value), sc = cleanLogin(inSc.value);
    var both = cb && sc;
    choiceRow.hidden = !both;
    if (both) {
      modeHint.hidden = true;
    } else if (cb || sc) {
      modeHint.hidden = false;
      modeHint.textContent = cb ? 'Chaturbate → картинка' : 'Stripchat → видео';
    } else {
      modeHint.hidden = true;
    }
  }
  inCb.addEventListener('input', updateModalDynamics);
  inSc.addEventListener('input', updateModalDynamics);

  form.addEventListener('submit', function (e) {
    e.preventDefault();
    var cb = cleanLogin(inCb.value);
    var sc = cleanLogin(inSc.value);
    if (!cb && !sc) {
      formError.textContent = 'Укажите логин хотя бы на одной площадке.';
      formError.hidden = false;
      return;
    }
    // Картинка = CB, Видео = SC. При двух площадках режим выбирает пользователь,
    // при одной — определяется автоматически (гарантирует normalizeModel).
    var mode = (cb && sc) ? (inMode.value === 'video' ? 'video' : 'image') : (cb ? 'image' : 'video');

    if (editingId) {
      var m = getModel(editingId);
      if (m) {
        m.chaturbate = cb || null;
        m.stripchat = sc || null;
        m.mode = mode;
        normalizeModel(m);
        save();
        updateTile(tiles.get(editingId), m);
      }
      toast('Сохранено');
    } else {
      state.models.push(normalizeModel({
        id: uid(), chaturbate: cb || null, stripchat: sc || null, mode: mode
      }));
      save();
      render();
      toast('Модель добавлена');
    }
    closeModal();
  });

  // нормализуем ввод: вырезаем URL, пробелы, @
  function cleanLogin(v) {
    if (!v) return '';
    v = v.trim();
    if (!v) return '';
    // если вставили ссылку — берём последний сегмент пути
    var mm = v.match(/(?:chaturbate\.com|stripchat\.com)\/([A-Za-z0-9_\-.]+)/i);
    if (mm) v = mm[1];
    v = v.replace(/^@+/, '').replace(/[/?#].*$/, '');
    return v.replace(/[^A-Za-z0-9_\-.]/g, '');
  }

  /* =======================================================================
   *  Настройки
   * ==================================================================== */
  var settingsBackdrop = $('#settings-backdrop');
  var setCols = $('#set-cols');
  var setColsVal = $('#set-cols-val');
  var setInterval = $('#set-interval');
  var colsRange = $('#cols-range');
  var colsValue = $('#cols-value');

  function openSettings() {
    setCols.value = settings.cols;
    setColsVal.textContent = settings.cols;
    setInterval.value = settings.intervalMs;
    settingsBackdrop.hidden = false;
  }
  function closeSettings() { settingsBackdrop.hidden = true; }

  setCols.addEventListener('input', function () { setColsVal.textContent = setCols.value; });

  $('#settings-form').addEventListener('submit', function (e) {
    e.preventDefault();
    settings.cols = clamp(parseInt(setCols.value, 10) || 4, 1, 8);
    settings.intervalMs = clamp(parseInt(setInterval.value, 10) || 500, 100, 10000);
    save();
    syncColsControls();
    render();
    // мягко перезапустим превью, чтобы применить новый интервал
    tiles.forEach(function (entry) { entry.ctrl.start(); });
    closeSettings();
    toast('Настройки сохранены');
  });

  // toolbar cols range
  colsRange.addEventListener('input', function () {
    settings.cols = clamp(parseInt(colsRange.value, 10) || 4, 1, 8);
    colsValue.textContent = settings.cols;
    document.documentElement.style.setProperty('--cols', settings.cols);
  });
  colsRange.addEventListener('change', function () { save(); });
  function syncColsControls() {
    colsRange.value = settings.cols;
    colsValue.textContent = settings.cols;
  }

  // экспорт / импорт / очистка
  $('#set-export').addEventListener('click', function () {
    var blob = new Blob([JSON.stringify(state, null, 2)], { type: 'application/json' });
    var a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'webcam-preview-config.json';
    a.click();
    setTimeout(function () { URL.revokeObjectURL(a.href); }, 1000);
  });
  var importFile = $('#import-file');
  $('#set-import').addEventListener('click', function () { importFile.click(); });
  importFile.addEventListener('change', function () {
    var f = importFile.files[0];
    if (!f) return;
    var rd = new FileReader();
    rd.onload = function () {
      try {
        var data = JSON.parse(rd.result);
        state.models = Array.isArray(data.models) ? data.models : state.models;
        state.settings = Object.assign({}, DEFAULTS.settings, data.settings || {});
        settings = state.settings;
        save();
        teardownAll();
        syncColsControls();
        render();
        closeSettings();
        toast('Импортировано');
      } catch (e) { toast('Не удалось прочитать файл', true); }
    };
    rd.readAsText(f);
    importFile.value = '';
  });
  $('#set-clear').addEventListener('click', function () {
    if (!confirm('Удалить все модели и настройки?')) return;
    teardownAll();
    state = clone(DEFAULTS);
    settings = state.settings;
    save();
    syncColsControls();
    render();
    closeSettings();
    toast('Очищено');
  });
  function teardownAll() {
    tiles.forEach(function (entry) { entry.ctrl.stop(); entry.el.remove(); });
    tiles.clear();
  }

  /* =======================================================================
   *  Тулбар / глобальные события
   * ==================================================================== */
  $('#btn-add').addEventListener('click', function () { openModal(null); });
  $('#add-plus').addEventListener('click', function () { openModal(null); });
  $('#btn-settings').addEventListener('click', openSettings);
  $('#btn-refresh').addEventListener('click', refreshAll);
  $('#modal-close').addEventListener('click', closeModal);
  $('#modal-cancel').addEventListener('click', closeModal);
  $('#settings-close').addEventListener('click', closeSettings);
  $('#settings-cancel').addEventListener('click', closeSettings);

  modalBackdrop.addEventListener('mousedown', function (e) { if (e.target === modalBackdrop) closeModal(); });
  settingsBackdrop.addEventListener('mousedown', function (e) { if (e.target === settingsBackdrop) closeSettings(); });

  document.addEventListener('click', function (e) {
    if (!ctxMenu.hidden && !ctxMenu.contains(e.target)) closeContextMenu();
  });
  document.addEventListener('scroll', closeContextMenu, true);
  window.addEventListener('resize', closeContextMenu);
  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape') { closeContextMenu(); closeModal(); closeSettings(); }
  });

  /* =======================================================================
   *  Утилиты
   * ==================================================================== */
  function div(cls) { var d = document.createElement('div'); d.className = cls; return d; }
  function clamp(n, a, b) { return Math.max(a, Math.min(b, n)); }
  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  var toastTimer = null;
  function toast(msg, isErr) {
    toastEl.textContent = msg;
    toastEl.className = 'toast' + (isErr ? ' err' : '');
    toastEl.hidden = false;
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { toastEl.hidden = true; }, 2600);
  }

  /* =======================================================================
   *  Старт
   * ==================================================================== */
  syncColsControls();
  document.documentElement.style.setProperty('--cols', settings.cols);
  render();

})();
