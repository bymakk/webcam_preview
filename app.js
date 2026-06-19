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
        models: Array.isArray(data.models) ? data.models : []
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
  // URL встроенного плеера-виджета (без прокси). Виджет принимает ЛОГИН напрямую,
  // сам резолвит модель и проигрывает (для Stripchat — расшифровывает поток).
  function embedUrl(platform, user, mode) {
    var u = encodeURIComponent(user);
    if (platform === 'stripchat') {
      // strict=1 -> показывать ТОЛЬКО эту модель (без подмены на «промо» модель).
      // autoplay=all -> видео; autoplay=none -> постер (режим «картинка»).
      var ap = mode === 'video' ? 'all' : 'none';
      return 'https://creative.mavrtracktor.com/widgets/Player?modelName=' + u +
             '&strict=1&autoplay=' + ap + '&volumeControl=0&fullscreen=0&muted=1';
    }
    // Chaturbate: официальный встраиваемый плеер (видео).
    return 'https://chaturbate.com/embed/' + u + '/?disable_sound=1&mobileRedirect=never&campaign=';
  }
  function livePageUrl(platform, user) {
    return platform === 'chaturbate'
      ? 'https://chaturbate.com/' + encodeURIComponent(user) + '/'
      : 'https://stripchat.com/' + encodeURIComponent(user);
  }

  // Разнос загрузки iframe-виджетов во времени (анти-всплеск для сервера виджета).
  var _embedBurst = 0, _embedBurstTimer = null;
  function embedStaggerDelay() {
    _embedBurst++;
    if (_embedBurstTimer) clearTimeout(_embedBurstTimer);
    _embedBurstTimer = setTimeout(function () { _embedBurst = 0; }, 1200);
    return Math.min((_embedBurst - 1) * 200, 3000);
  }

  /* =======================================================================
   *  Preview controller — управляет одним превью внутри плитки
   * ==================================================================== */
  function Preview(model, refs) {
    this.model = model;
    this.media = refs.media;
    this.stateEl = refs.state;
    this.dot = refs.dot;
    this.note = refs.note;
    this.gen = 0;
    this.timer = null;
    this.embed = null;
    this.frameSeq = 0;
  }
  Preview.prototype.setModel = function (m) { this.model = m; };
  Preview.prototype.platform = function () {
    var m = this.model;
    if (m.primary && m[m.primary]) return m.primary;
    return m.chaturbate ? 'chaturbate' : 'stripchat';
  };
  Preview.prototype.user = function () { return this.model[this.platform()]; };

  Preview.prototype.start = function () {
    this.gen++;
    var g = this.gen;
    this.clearTimer();
    this.teardownEmbed();
    this.setNote('');
    this.setLive(''); // сброс индикатора
    // CB-картинка -> наш <img> (быстрый поток jpeg.live). Всё остальное (видео,
    // любой Stripchat) -> встроенный плеер-виджет в <iframe>: он сам резолвит
    // логин и расшифровывает/проигрывает поток. Прокси не нужен.
    if (this.platform() === 'chaturbate' && this.model.mode === 'image') this.runImage(g);
    else this.mountEmbed();
  };
  Preview.prototype.stop = function () {
    this.gen++;
    this.clearTimer();
    this.teardownEmbed();
  };
  Preview.prototype.clearTimer = function () { if (this.timer) { clearTimeout(this.timer); this.timer = null; } };
  Preview.prototype.teardownEmbed = function () {
    var f = this.media.querySelector('iframe');
    if (f) { try { f.src = 'about:blank'; } catch (e) {} f.remove(); }
    this.embed = null;
  };
  // Встроенный плеер-виджет (iframe). В CSS у него pointer-events:none — поэтому
  // наши hover/контекстное меню/drag работают поверх, а видео играет под ними.
  Preview.prototype.mountEmbed = function () {
    var self = this;
    var src = embedUrl(this.platform(), this.user(), this.model.mode);
    this.media.innerHTML = '';
    var f = document.createElement('iframe');
    f.className = 'tile-embed';
    f.setAttribute('allow', 'autoplay; encrypted-media; fullscreen');
    f.setAttribute('scrolling', 'no');
    f.addEventListener('load', function () { if (self.embed === f) self.hideState(); });
    this.media.appendChild(f);
    this.embed = f;
    this.showState('loading');
    // Грузим с небольшим разносом во времени: при множестве плиток не бомбим
    // сервер виджета одновременно (это вызывало редкие 500).
    this.clearTimer();
    this.timer = setTimeout(function () { if (self.embed === f) f.src = src; }, embedStaggerDelay());
  };

  /* ---- картинка Chaturbate: фиксированная частота опроса jpeg.live (~2+/сек) ---- */
  Preview.prototype.runImage = function (g) {
    this.lastShown = 0;   // seq последнего показанного кадра
    this.tick(g);
  };
  Preview.prototype.tick = function (g) {
    var self = this;
    // Следующий опрос — строго через intervalMs, НЕ дожидаясь загрузки кадра.
    // Частота держится ~1/intervalMs независимо от времени загрузки.
    this.clearTimer();
    this.timer = setTimeout(function () { if (self.gen === g) self.tick(g); }, settings.intervalMs || 500);
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
  Preview.prototype.setLive = function (status) {
    var d = this.dot;
    d.classList.remove('online', 'offline');
    if (status === 'online') { d.classList.add('online'); d.textContent = 'LIVE'; d.style.display = ''; }
    else if (status === 'offline') { d.classList.add('offline'); d.textContent = 'OFF'; d.style.display = ''; }
    else { d.textContent = ''; d.style.display = 'none'; } // неизвестно/загрузка -> скрываем
  };
  Preview.prototype.setNote = function (text) {
    this.note.textContent = text || '';
    this.note.style.display = text ? '' : 'none';
  };

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
    if (m.primary && m[m.primary]) return m.primary;
    return m.chaturbate ? 'chaturbate' : 'stripchat';
  }
  function sigOf(m) { return m.mode + '|' + (m.primary || '') + '|' + (m.chaturbate || '') + '|' + (m.stripchat || ''); }

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
        '<span class="badge plat"></span>' +
        '<span class="badge note" style="display:none"></span>' +
        '<span class="spacer"></span>' +
        '<span class="live-dot" style="display:none"></span>' +
      '</div>' +
      '<div class="tile-overlay">' +
        '<div class="tile-logins"></div>' +
        '<div class="overlay-actions">' +
          '<button class="overlay-btn" data-act="edit" title="Редактировать">' + svg(ICON.edit) + '</button>' +
        '</div>' +
      '</div>';

    var refs = {
      media: $('.tile-media', el),
      state: $('.tile-state', el),
      dot: $('.live-dot', el),
      note: $('.badge.note', el)
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
    var ap = activePlatform(m);
    var modeEl = $('.badge.mode', entry.el);
    modeEl.innerHTML = (m.mode === 'video' ? svg(ICON.video) + 'LIVE' : svg(ICON.img) + 'IMG');
    modeEl.style.gap = '5px';
    var platEl = $('.badge.plat', entry.el);
    platEl.textContent = ap === 'chaturbate' ? 'CB' : 'SC';
    platEl.style.color = ap === 'chaturbate' ? '#111' : '#fff';
    platEl.style.background = ap === 'chaturbate' ? 'var(--cb)' : 'var(--sc)';
    platEl.style.borderColor = 'transparent';
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

    var items = [];
    items.push({ label: 'Режим', header: true });
    items.push({ icon: ICON.img, label: 'Картинка', check: m.mode === 'image', act: function () { setMode(id, 'image'); } });
    items.push({ icon: ICON.video, label: 'Видео', check: m.mode === 'video', act: function () { setMode(id, 'video'); } });

    var plats = platformList(m);
    if (plats.length > 1) {
      items.push({ sep: true });
      items.push({ label: 'Показывать превью', header: true });
      plats.forEach(function (it) {
        items.push({
          icon: ICON.swap, label: it.p === 'chaturbate' ? 'Chaturbate' : 'Stripchat',
          check: activePlatform(m) === it.p, act: function () { setPrimary(id, it.p); }
        });
      });
    }

    var idx = state.models.findIndex(function (mm) { return mm.id === id; });
    var last = state.models.length - 1;
    items.push({ sep: true });
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
    m.mode = mode; save();
    updateTile(tiles.get(id), m);
  }
  function setPrimary(id, p) {
    var m = getModel(id); if (!m) return;
    m.primary = p; save();
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
  var inPrimary = $('#in-primary');
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
    inPrimary.value = m ? activePlatform(m) : 'chaturbate';
    formError.hidden = true;
    updateModalDynamics();
    modalBackdrop.hidden = false;
    setTimeout(function () { inCb.focus(); }, 30);
  }
  function closeModal() { modalBackdrop.hidden = true; editingId = null; }

  // Выбор режима/площадки — только при двух площадках. Для одной площадки
  // режим определяется автоматически: Chaturbate → картинка, Stripchat → видео.
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
  // при выборе площадки подставляем её режим по умолчанию (можно переопределить)
  inPrimary.addEventListener('change', function () {
    inMode.value = inPrimary.value === 'stripchat' ? 'video' : 'image';
  });

  form.addEventListener('submit', function (e) {
    e.preventDefault();
    var cb = cleanLogin(inCb.value);
    var sc = cleanLogin(inSc.value);
    if (!cb && !sc) {
      formError.textContent = 'Укажите логин хотя бы на одной площадке.';
      formError.hidden = false;
      return;
    }
    var m0 = editingId ? getModel(editingId) : null;
    var mode, primary;
    if (cb && sc) {
      // обе площадки — выбор пользователя
      primary = inPrimary.value === 'stripchat' ? 'stripchat' : 'chaturbate';
      mode = inMode.value === 'video' ? 'video' : 'image';
    } else {
      // одна площадка: CB → картинка, SC → видео.
      // При редактировании той же одиночной площадки сохраняем текущий режим
      // (чтобы не сбрасывать выбор, сделанный через контекстное меню).
      primary = cb ? 'chaturbate' : 'stripchat';
      var hadBoth = m0 && m0.chaturbate && m0.stripchat;
      var hadSame = m0 && !hadBoth && ((cb && m0.chaturbate) || (sc && m0.stripchat));
      mode = hadSame ? m0.mode : (cb ? 'image' : 'video');
    }

    if (editingId) {
      var m = getModel(editingId);
      if (m) {
        m.chaturbate = cb || null;
        m.stripchat = sc || null;
        m.mode = mode;
        m.primary = primary;
        save();
        updateTile(tiles.get(editingId), m);
      }
      toast('Сохранено');
    } else {
      state.models.push({
        id: uid(), chaturbate: cb || null, stripchat: sc || null,
        mode: mode, primary: primary
      });
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
