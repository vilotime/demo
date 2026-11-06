/*!
 * app.js — 站点主逻辑
 * ---------------------------------------------------------------
 * 职责：
 *   1. 读取 md-index.json，把 md/ 的目录结构渲染成资源管理器式的树；
 *   2. 哈希路由（#/md/xxx.md?mode=ppt&slide=3），支持深链接与刷新；
 *   3. 阅读模式：正文渲染、大纲滚动高亮、上一篇 / 下一篇；
 *   4. 演示模式：交给 Deck（presenter.js）；
 *   5. 主题、搜索过滤、快捷键、图片放大等交互。
 */
(function () {
  'use strict';

  var MD = window.MD;
  var INDEX_URL = 'md-index.json';
  var STORE = {
    theme: 'mdpages:theme',
    expanded: 'mdpages:expanded',
    sidebar: 'mdpages:sidebar',
  };

  /* ================================================================
   * 状态与 DOM
   * ================================================================ */

  var state = {
    manifest: null,
    files: [],
    fileMap: Object.create(null),
    expanded: new Set(),
    cache: new Map(),
    scrollMemory: new Map(),
    current: null,
    renderedPath: null,
    toc: [],
    filter: '',
    activeHeading: null,
  };

  var deck = null;

  function $(selector, scope) {
    return (scope || document).querySelector(selector);
  }

  var el = {
    app: $('#app'),
    sidebar: $('#sidebar'),
    scrim: $('#scrim'),
    tree: $('#tree'),
    search: $('#search'),
    searchClear: $('#search-clear'),
    stats: $('#stats'),
    themeToggle: $('#theme-toggle'),
    crumbs: $('#crumbs'),
    reader: $('#reader'),
    doc: $('#doc'),
    toc: $('#toc'),
    tocList: $('#toc-list'),
    welcome: $('#welcome'),
    toTop: $('#to-top'),
    rawLink: $('#raw-link'),
    copyLink: $('#copy-link'),
    printBtn: $('#print-btn'),
    modeToggle: $('#mode-toggle'),
    menuBtn: $('#menu-btn'),
    sidebarClose: $('#sidebar-close'),
    brand: $('#brand'),
    lightbox: $('#lightbox'),
    lightboxImg: $('#lightbox-img'),
    toast: $('#toast'),
  };

  /* ================================================================
   * 小工具
   * ================================================================ */

  var toastTimer = null;
  function toast(message) {
    el.toast.textContent = message;
    el.toast.classList.add('is-visible');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () {
      el.toast.classList.remove('is-visible');
    }, 1900);
  }

  function store(key, value) {
    try {
      if (value === undefined) return localStorage.getItem(key);
      if (value === null) localStorage.removeItem(key);
      else localStorage.setItem(key, value);
    } catch (error) {
      /* 隐私模式下 localStorage 可能不可用，忽略 */
    }
    return null;
  }

  function icons() {
    return {
      folder:
        '<svg class="tree__icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round"><path d="M3 7.5A1.5 1.5 0 0 1 4.5 6h4l2 2.5h7A1.5 1.5 0 0 1 19 10v7.5A1.5 1.5 0 0 1 17.5 19h-13A1.5 1.5 0 0 1 3 17.5z"/></svg>',
      file:
        '<svg class="tree__icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M6 3.5h7l5 5v12a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1v-16a1 1 0 0 1 1-1Z"/><path d="M13 3.5v5h5M8.5 13h7M8.5 16.5h4.5"/></svg>',
      chevron:
        '<svg class="tree__chevron" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 6l6 6-6 6"/></svg>',
    };
  }

  /* ================================================================
   * 目录索引
   * ================================================================ */

  function flatten(nodes, out) {
    out = out || [];
    nodes.forEach(function (node) {
      if (node.type === 'dir') {
        flatten(node.children, out);
      } else {
        out.push(node);
      }
    });
    return out;
  }

  function siblingsOf(path) {
    var index = state.files.findIndex(function (file) {
      return file.path === path;
    });
    return {
      prev: index > 0 ? state.files[index - 1] : null,
      next: index >= 0 && index < state.files.length - 1 ? state.files[index + 1] : null,
    };
  }

  async function loadManifest() {
    var response = await fetch(INDEX_URL, { cache: 'no-cache' });
    if (!response.ok) {
      throw new Error(
        '无法读取 ' + INDEX_URL + '（HTTP ' + response.status + '）。请先运行 npm run build 生成索引。',
      );
    }
    return response.json();
  }

  /* ================================================================
   * 目录树渲染
   * ================================================================ */

  function countFiles(node) {
    if (node.type !== 'dir') return 1;
    return node.children.reduce(function (sum, child) {
      return sum + countFiles(child);
    }, 0);
  }

  function buildTreeNode(node, iconsSet) {
    if (node.type === 'dir') {
      var li = document.createElement('li');
      li.className = 'tree__item tree__item--dir';
      li.dataset.path = node.path;

      var button = document.createElement('button');
      button.type = 'button';
      button.className = 'tree__row tree__row--dir';
      button.innerHTML =
        iconsSet.chevron +
        iconsSet.folder +
        '<span class="tree__label"></span>' +
        '<span class="tree__count">' +
        countFiles(node) +
        '</span>';
      button.querySelector('.tree__label').textContent = node.name;

      var childList = document.createElement('ul');
      childList.className = 'tree__children';
      node.children.forEach(function (child) {
        childList.appendChild(buildTreeNode(child, iconsSet));
      });

      li.appendChild(button);
      li.appendChild(childList);
      return li;
    }

    var fileLi = document.createElement('li');
    fileLi.className = 'tree__item tree__item--file';
    fileLi.dataset.path = node.path;

    var link = document.createElement('a');
    link.className = 'tree__row tree__row--file';
    link.href = '#/' + MD.encodePath(node.path);
    link.dataset.path = node.path;
    link.dataset.search = [node.name, node.title, node.path].join(' ').toLowerCase();
    link.title = node.title + '\n' + node.path;
    link.innerHTML = iconsSet.file + '<span class="tree__label"></span>';
    link.querySelector('.tree__label').textContent = node.name.replace(/\.(md|markdown)$/i, '');
    fileLi.appendChild(link);
    return fileLi;
  }

  function buildTree() {
    var iconsSet = icons();
    el.tree.innerHTML = '';

    if (!state.manifest.tree.length) {
      el.tree.innerHTML =
        '<p class="tree__placeholder">md/ 目录里还没有 Markdown 文件。</p>';
      return;
    }

    var rootList = document.createElement('ul');
    rootList.className = 'tree__list';
    state.manifest.tree.forEach(function (node) {
      rootList.appendChild(buildTreeNode(node, iconsSet));
    });
    el.tree.appendChild(rootList);

    // 目录折叠
    el.tree.addEventListener('click', function (event) {
      var row = event.target.closest('.tree__row--dir');
      if (!row) return;
      var item = row.parentNode;
      toggleDir(item);
    });

    restoreExpanded();
  }

  function toggleDir(item) {
    var path = item.dataset.path;
    var open = !item.classList.contains('is-open');
    item.classList.toggle('is-open', open);
    item.querySelector('.tree__row--dir').setAttribute('aria-expanded', String(open));
    if (open) state.expanded.add(path);
    else state.expanded.delete(path);
    store(STORE.expanded, JSON.stringify(Array.from(state.expanded)));
  }

  function setDirOpen(item, open) {
    item.classList.toggle('is-open', open);
    var row = item.querySelector('.tree__row--dir');
    if (row) row.setAttribute('aria-expanded', String(open));
    if (open) state.expanded.add(item.dataset.path);
    else state.expanded.delete(item.dataset.path);
  }

  function restoreExpanded() {
    var raw = store(STORE.expanded);
    var saved = null;
    if (raw) {
      try {
        saved = new Set(JSON.parse(raw));
      } catch (error) {
        saved = null;
      }
    }

    if (saved) {
      state.expanded = saved;
    } else {
      state.expanded = new Set();
      var topLevelDirs = el.tree.querySelectorAll('.tree__list > .tree__item--dir');
      Array.prototype.forEach.call(topLevelDirs, function (item) {
        state.expanded.add(item.dataset.path);
      });
    }

    var dirs = el.tree.querySelectorAll('.tree__item--dir');
    Array.prototype.forEach.call(dirs, function (item) {
      var open = state.expanded.has(item.dataset.path);
      item.classList.toggle('is-open', open);
      var row = item.querySelector('.tree__row--dir');
      if (row) row.setAttribute('aria-expanded', String(open));
    });
  }

  function expandAncestors(path) {
    var row = el.tree.querySelector('.tree__row--file[data-path="' + cssEscape(path) + '"]');
    if (!row) return;
    var node = row.parentNode.parentNode; // ul.tree__children
    while (node && !node.classList || !node.classList.contains('tree__list')) {
      if (node.classList && node.classList.contains('tree__item--dir')) {
        setDirOpen(node, true);
      }
      node = node.parentNode;
    }
  }

  function cssEscape(value) {
    if (window.CSS && CSS.escape) return CSS.escape(value);
    return String(value).replace(/["\\]/g, '\\$&');
  }

  function setActiveFile(path) {
    var rows = el.tree.querySelectorAll('.tree__row--file');
    Array.prototype.forEach.call(rows, function (row) {
      row.classList.toggle('is-active', row.dataset.path === path);
      if (row.dataset.path === path) {
        row.setAttribute('aria-current', 'page');
      } else {
        row.removeAttribute('aria-current');
      }
    });
    expandAncestors(path);
  }

  /* ================================================================
   * 搜索过滤
   * ================================================================ */

  function applyFilter(rawQuery) {
    var query = String(rawQuery || '').trim().toLowerCase();
    state.filter = query;
    el.searchClear.hidden = !query;
    el.tree.classList.toggle('is-filtering', Boolean(query));

    if (!query) {
      var hidden = el.tree.querySelectorAll('.is-hidden');
      Array.prototype.forEach.call(hidden, function (node) {
        node.classList.remove('is-hidden');
      });
      return;
    }

    var rows = el.tree.querySelectorAll('.tree__row--file');
    Array.prototype.forEach.call(rows, function (row) {
      var haystack = row.dataset.search || '';
      row.parentNode.classList.toggle('is-hidden', haystack.indexOf(query) === -1);
    });

    var dirs = el.tree.querySelectorAll('.tree__item--dir');
    // 从深层往上算，保证父目录看到子目录的结果
    var list = Array.prototype.slice.call(dirs).reverse();
    list.forEach(function (dir) {
      var hasVisible = dir.querySelector('.tree__item--file:not(.is-hidden)');
      dir.classList.toggle('is-hidden', !hasVisible);
    });
  }

  /* ================================================================
   * 路由
   * ================================================================ */

  function buildHash(route) {
    var hash = '#/' + MD.encodePath(route.path || '');
    var params = [];
    if (route.mode === 'ppt' || route.mode === 'read') params.push('mode=' + route.mode);
    if (route.slide && Number(route.slide) > 1) params.push('slide=' + Number(route.slide));
    if (params.length) hash += '?' + params.join('&');
    if (route.anchor) hash += '#' + encodeURIComponent(route.anchor);
    return hash;
  }

  function parseHash() {
    var raw = window.location.hash;
    if (!raw || raw === '#' || raw === '#/') return null;
    raw = raw.slice(1);
    if (raw.charAt(0) === '/') raw = raw.slice(1);

    // 先取小节锚点（最后一个 #），再取查询串，这样 `#/a.md?mode=ppt#anchor`
    // 和 `#/a.md#anchor` 两种写法都能正确解析
    var anchor = '';
    var anchorIndex = raw.lastIndexOf('#');
    if (anchorIndex !== -1) {
      anchor = MD.decodePath(raw.slice(anchorIndex + 1));
      raw = raw.slice(0, anchorIndex);
    }

    var query = '';
    var queryIndex = raw.indexOf('?');
    if (queryIndex !== -1) {
      query = raw.slice(queryIndex + 1);
      raw = raw.slice(0, queryIndex);
    }

    var params = {};
    query.split('&').forEach(function (pair) {
      if (!pair) return;
      var eq = pair.indexOf('=');
      if (eq === -1) params[pair] = '1';
      else params[pair.slice(0, eq)] = decodeURIComponent(pair.slice(eq + 1));
    });

    return {
      path: MD.decodePath(raw),
      mode: params.mode || '',
      slide: Number(params.slide) || 0,
      anchor: anchor,
    };
  }

  function syncHash(route, replace) {
    var hash = buildHash(route);
    if (window.location.hash === hash) return;
    try {
      if (replace) {
        window.history.replaceState(null, '', hash);
      } else {
        window.location.hash = hash;
      }
    } catch (error) {
      /* 某些环境（如 file://）不允许改地址栏，忽略即可 */
    }
  }

  /* ================================================================
   * 文档加载与阅读模式
   * ================================================================ */

  async function fetchDoc(path) {
    if (state.cache.has(path)) return state.cache.get(path);
    var response = await fetch(MD.encodePath(path), { cache: 'no-cache' });
    if (!response.ok) {
      throw new Error('无法读取 ' + path + '（HTTP ' + response.status + '）');
    }
    var source = await response.text();
    state.cache.set(path, source);
    return source;
  }

  async function ensureDoc(path) {
    if (state.current && state.current.path === path) return state.current;
    var node = state.fileMap[path];
    var source = await fetchDoc(path);
    var rendered = MD.render(source);
    state.current = { path: path, node: node, source: source, rendered: rendered };
    return state.current;
  }

  function renderReading(doc) {
    var previousPath = state.renderedPath;
    if (previousPath && previousPath !== doc.path) {
      state.scrollMemory.set(previousPath, el.reader.scrollTop);
    }

    var prose = document.createElement('div');
    prose.className = 'prose';
    prose.innerHTML = doc.rendered.html;

    el.doc.innerHTML = '';
    el.doc.appendChild(prose);

    MD.decorate(prose, { docPath: doc.path }, { mode: 'read' });

    // 文档页脚：字数 / 阅读时长 / 上一篇、下一篇
    el.doc.appendChild(buildDocFooter(doc));

    state.renderedPath = doc.path;
    state.activeHeading = null;
    state.toc = MD.extractToc(prose, 3);
    renderToc();
    renderCrumbs(doc);

    el.rawLink.href = MD.encodePath(doc.path);
    var title = doc.rendered.title || doc.node.title || MD.basename(doc.path);
    document.title = title + ' · 文档';

    var remembered = state.scrollMemory.get(doc.path);
    el.reader.scrollTop = typeof remembered === 'number' ? remembered : 0;
    updateToTop();

    requestAnimationFrame(function () {
      updateActiveHeading();
    });
  }

  function buildDocFooter(doc) {
    var footer = document.createElement('div');
    footer.className = 'doc-footer';

    var pager = siblingsOf(doc.path);

    var meta = document.createElement('div');
    meta.className = 'doc-footer__meta';
    meta.innerHTML =
      '<span>' +
      doc.rendered.words +
      ' 字</span><span>约 ' +
      doc.rendered.minutes +
      ' 分钟读完</span>';
    footer.appendChild(meta);

    var nav = document.createElement('nav');
    nav.className = 'pager';
    nav.appendChild(pagerLink(pager.prev, '上一篇', 'prev'));
    nav.appendChild(pagerLink(pager.next, '下一篇', 'next'));
    footer.appendChild(nav);

    return footer;
  }

  function pagerLink(node, label, direction) {
    if (!node) {
      var span = document.createElement('span');
      span.className = 'pager__link pager__link--' + direction + ' is-disabled';
      span.innerHTML = '<small>' + label + '</small><strong>已经到头了</strong>';
      return span;
    }
    var link = document.createElement('a');
    link.className = 'pager__link pager__link--' + direction;
    link.href = '#/' + MD.encodePath(node.path);
    link.innerHTML = '<small>' + label + '</small><strong></strong>';
    link.querySelector('strong').textContent = node.title || MD.basename(node.path);
    return link;
  }

  function renderCrumbs(doc) {
    el.crumbs.innerHTML = '';
    var segments = doc.path.split('/');
    segments.pop();

    var home = document.createElement('a');
    home.className = 'crumbs__item crumbs__item--home';
    home.href = '#/';
    home.textContent = state.manifest && state.manifest.root ? state.manifest.root : 'md';
    home.title = '回到首页';
    el.crumbs.appendChild(home);

    segments.slice(1).forEach(function (segment) {
      var sep = document.createElement('span');
      sep.className = 'crumbs__sep';
      sep.textContent = '/';
      el.crumbs.appendChild(sep);

      var item = document.createElement('span');
      item.className = 'crumbs__item';
      item.textContent = segment;
      el.crumbs.appendChild(item);
    });

    var sep = document.createElement('span');
    sep.className = 'crumbs__sep';
    sep.textContent = '/';
    el.crumbs.appendChild(sep);

    var current = document.createElement('span');
    current.className = 'crumbs__item crumbs__item--current';
    current.textContent = doc.rendered.title || doc.node.title || MD.basename(doc.path);
    el.crumbs.appendChild(current);
  }

  /* ================================================================
   * 大纲（TOC）
   * ================================================================ */

  function renderToc() {
    el.tocList.innerHTML = '';
    var toc = state.toc || [];
    el.toc.classList.toggle('is-empty', toc.length < 2);

    toc.forEach(function (item) {
      var link = document.createElement('a');
      link.className = 'toc__link toc__link--l' + item.level;
      link.href =
        '#/' + MD.encodePath(state.current.path) + '#' + encodeURIComponent(item.id);
      link.dataset.anchor = item.id;
      link.textContent = item.text;
      el.tocList.appendChild(link);
    });
  }

  function scrollToAnchor(anchorId, behavior) {
    if (!anchorId) return false;
    var target = document.getElementById(anchorId);
    if (!target) return false;
    var offset = 18;
    var top = target.getBoundingClientRect().top - el.reader.getBoundingClientRect().top + el.reader.scrollTop - offset;
    el.reader.scrollTo({ top: Math.max(0, top), behavior: behavior || 'smooth' });
    return true;
  }

  function updateActiveHeading() {
    if (!state.toc || !state.toc.length) return;
    var readerTop = el.reader.getBoundingClientRect().top;
    var active = state.toc[0].id;

    for (var i = 0; i < state.toc.length; i += 1) {
      var node = document.getElementById(state.toc[i].id);
      if (!node) continue;
      if (node.getBoundingClientRect().top - readerTop <= 90) active = state.toc[i].id;
      else break;
    }

    if (active === state.activeHeading) return;
    state.activeHeading = active;

    var links = el.tocList.querySelectorAll('.toc__link');
    Array.prototype.forEach.call(links, function (link) {
      var isActive = link.dataset.anchor === active;
      link.classList.toggle('is-active', isActive);
      if (isActive) {
        var listRect = el.tocList.getBoundingClientRect();
        var linkRect = link.getBoundingClientRect();
        if (linkRect.top < listRect.top || linkRect.bottom > listRect.bottom) {
          el.tocList.scrollTop += linkRect.top - listRect.top - 24;
        }
      }
    });
  }

  /* ================================================================
   * 欢迎页 / 错误提示
   * ================================================================ */

  function showWelcome(title, message) {
    el.doc.innerHTML = '';
    el.toc.classList.add('is-empty');
    el.welcome.hidden = false;
    el.welcome.innerHTML =
      '<div class="welcome__card">' +
      '<h1>' + MD.escapeHtml(title || 'MD Pages') + '</h1>' +
      '<p>' + MD.escapeHtml(message || '从左侧目录里选择一篇文档开始阅读。') + '</p>' +
      (state.manifest
        ? '<p class="welcome__stats">' +
          state.manifest.stats.files +
          ' 篇文档 · ' +
          state.manifest.stats.dirs +
          ' 个目录</p>'
        : '') +
      '</div>';
    el.crumbs.innerHTML = '';
    el.rawLink.href = '#';
  }

  function hideWelcome() {
    el.welcome.hidden = true;
    el.welcome.innerHTML = '';
  }

  /* ================================================================
   * 演示模式
   * ================================================================ */

  function openDeck(doc, slideIndex) {
    if (!deck) {
      deck = new window.Deck({
        onSlideChange: function (index) {
          syncHash({ path: state.current.path, mode: 'ppt', slide: index }, true);
        },
        onExit: function () {
          syncHash({ path: state.current ? state.current.path : '' }, true);
        },
      });
    }
    deck.open(
      { path: doc.path, body: doc.rendered.body },
      { slide: slideIndex || 1 },
    );
    document.body.classList.add('is-presenting');
  }

  function closeDeck() {
    if (deck && deck.isOpen) deck.close();
    document.body.classList.remove('is-presenting');
  }

  function setMode(mode) {
    if (!state.current) return;
    if (mode === 'read') {
      closeDeck();
      syncHash({ path: state.current.path }, true);
    } else {
      openDeck(state.current, 1);
      syncHash({ path: state.current.path, mode: 'ppt', slide: 1 }, true);
    }
  }

  /* ================================================================
   * 路由应用
   * ================================================================ */

  async function applyRoute(options) {
    options = options || {};
    var route = parseHash();

    if (!route || !route.path) {
      showWelcome('MD Pages', '从左侧目录里选择一篇文档开始阅读。');
      return;
    }

    var node = state.fileMap[route.path];
    if (!node) {
      showWelcome('找不到这篇文档', '目录索引里没有 ' + route.path + '，可能文件已被移动或重命名。');
      return;
    }

    hideWelcome();
    setActiveFile(route.path);

    var doc;
    try {
      doc = await ensureDoc(route.path);
    } catch (error) {
      showWelcome('加载失败', error.message);
      return;
    }

    if (state.renderedPath !== route.path) {
      renderReading(doc);
    } else {
      renderCrumbs(doc);
    }

    var mode = route.mode === 'ppt' ? 'ppt' : 'read';

    if (mode === 'ppt') {
      if (!deck || !deck.isOpen || !deck.doc || deck.doc.path !== doc.path) {
        openDeck(doc, route.slide || 1);
      } else if (route.slide) {
        deck.goTo(route.slide - 1);
      }
    } else {
      closeDeck();
      if (route.anchor) {
        setTimeout(function () {
          scrollToAnchor(route.anchor, options.smooth === false ? 'auto' : 'smooth');
        }, 30);
      }
    }

    closeSidebarOnMobile();
  }

  /* ================================================================
   * 主题
   * ================================================================ */

  function currentTheme() {
    return document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light';
  }

  function applyTheme(theme, persist) {
    document.documentElement.dataset.theme = theme;
    if (persist !== false) store(STORE.theme, theme);
  }

  /** 未手动选择过主题时，跟随系统的深浅色变化 */
  function watchSystemTheme() {
    if (!window.matchMedia) return;
    var query = window.matchMedia('(prefers-color-scheme: dark)');
    var listener = function (event) {
      if (store(STORE.theme)) return;
      applyTheme(event.matches ? 'dark' : 'light', false);
    };
    if (query.addEventListener) query.addEventListener('change', listener);
    else if (query.addListener) query.addListener(listener);
  }

  function toggleTheme() {
    applyTheme(currentTheme() === 'dark' ? 'light' : 'dark');
  }

  /* ================================================================
   * 侧边栏（移动端抽屉）
   * ================================================================ */

  function openSidebar() {
    el.sidebar.classList.add('is-open');
    el.scrim.hidden = false;
    document.body.classList.add('sidebar-open');
  }

  function closeSidebar() {
    el.sidebar.classList.remove('is-open');
    el.scrim.hidden = true;
    document.body.classList.remove('sidebar-open');
  }

  function closeSidebarOnMobile() {
    if (window.matchMedia('(max-width: 900px)').matches) closeSidebar();
  }

  /* ================================================================
   * 事件绑定
   * ================================================================ */

  function bindEvents() {
    el.search.addEventListener('input', function () {
      applyFilter(el.search.value);
    });

    el.search.addEventListener('keydown', function (event) {
      if (event.key === 'Escape') {
        el.search.value = '';
        applyFilter('');
        el.search.blur();
      }
      if (event.key === 'Enter') {
        var first = el.tree.querySelector('.tree__row--file:not(.is-hidden)');
        if (first) {
          event.preventDefault();
          first.click();
        }
      }
    });

    el.searchClear.addEventListener('click', function () {
      el.search.value = '';
      applyFilter('');
      el.search.focus();
    });

    el.themeToggle.addEventListener('click', toggleTheme);
    el.copyLink.addEventListener('click', copyCurrentLink);
    el.printBtn.addEventListener('click', function () {
      window.print();
    });

    el.modeToggle.addEventListener('click', function () {
      setMode(deck && deck.isOpen ? 'read' : 'ppt');
    });

    el.menuBtn.addEventListener('click', openSidebar);
    el.sidebarClose.addEventListener('click', closeSidebar);
    el.scrim.addEventListener('click', closeSidebar);

    el.brand.addEventListener('click', function (event) {
      event.preventDefault();
      var home = state.fileMap[docRoot() + '/index.md'] || state.files[0];
      if (home) window.location.hash = '#/' + MD.encodePath(home.path);
    });

    // 大纲点击：滚动 + 同步地址
    el.tocList.addEventListener('click', function (event) {
      var link = event.target.closest('.toc__link');
      if (!link) return;
      event.preventDefault();
      var anchor = link.dataset.anchor;
      scrollToAnchor(anchor, 'smooth');
      syncHash({ path: state.current.path, anchor: anchor }, true);
    });

    // 正文内锚点：标题旁的链接会同时把深链接复制到剪贴板
    el.doc.addEventListener('click', function (event) {
      var anchorLink = event.target.closest('.heading__anchor, .is-anchor');
      if (anchorLink) {
        var target = anchorLink.dataset.anchor;
        if (target) {
          event.preventDefault();
          scrollToAnchor(target, 'smooth');
          syncHash({ path: state.current.path, anchor: target }, true);
          if (anchorLink.classList.contains('heading__anchor')) {
            copyText(window.location.href).then(function () {
              toast('章节链接已复制');
            });
          }
          return;
        }
      }

      var image = event.target.closest('img.zoomable');
      if (image) {
        openLightbox(image.src, image.alt);
        return;
      }

      var copyButton = event.target.closest('[data-copy]');
      if (copyButton) {
        var block = copyButton.closest('.code-block');
        var code = block && block.querySelector('code');
        if (code) {
          copyText(code.textContent).then(function () {
            copyButton.textContent = '已复制';
            setTimeout(function () {
              copyButton.textContent = '复制';
            }, 1400);
          });
        }
      }
    });

    el.reader.addEventListener(
      'scroll',
      function () {
        updateToTop();
        if (window.requestAnimationFrame) {
          if (el.reader._raf) return;
          el.reader._raf = requestAnimationFrame(function () {
            el.reader._raf = null;
            updateActiveHeading();
          });
        } else {
          updateActiveHeading();
        }
      },
      { passive: true },
    );

    el.toTop.addEventListener('click', function () {
      el.reader.scrollTo({ top: 0, behavior: 'smooth' });
    });

    el.lightbox.addEventListener('click', closeLightbox);

    window.addEventListener('hashchange', function () {
      applyRoute();
    });

    document.addEventListener('keydown', onGlobalKey);

    window.addEventListener('resize', function () {
      if (el.reader._raf) return;
      el.reader._raf = requestAnimationFrame(function () {
        el.reader._raf = null;
        updateActiveHeading();
      });
    });
  }

  function docRoot() {
    return (state.manifest && state.manifest.root) || 'md';
  }

  function onGlobalKey(event) {
    var target = event.target;
    var isTyping = /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName || '') || target.isContentEditable;

    if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') {
      event.preventDefault();
      setMode(deck && deck.isOpen ? 'read' : 'ppt');
      return;
    }

    if (isTyping) return;

    // 演示模式下，键盘交互交给 Deck 处理
    if (deck && deck.isOpen) return;

    if (event.key === '/' && !event.ctrlKey && !event.metaKey) {
      event.preventDefault();
      if (window.matchMedia('(max-width: 900px)').matches) openSidebar();
      el.search.focus();
      el.search.select();
      return;
    }

    if (event.key === 'Escape') {
      closeLightbox();
      return;
    }

    var current = state.current;
    if (!current) return;
    var pager = siblingsOf(current.path);
    if (event.key === 'j' && pager.next) {
      window.location.hash = '#/' + MD.encodePath(pager.next.path);
    } else if (event.key === 'k' && pager.prev) {
      window.location.hash = '#/' + MD.encodePath(pager.prev.path);
    }
  }

  function updateToTop() {
    el.toTop.hidden = el.reader.scrollTop < 600;
  }

  /* ================================================================
   * 图片放大
   * ================================================================ */

  function openLightbox(src, alt) {
    el.lightboxImg.src = src;
    el.lightboxImg.alt = alt || '';
    el.lightbox.hidden = false;
  }

  function closeLightbox() {
    if (el.lightbox.hidden) return;
    el.lightbox.hidden = true;
    el.lightboxImg.src = '';
  }

  /* ================================================================
   * 复制
   * ================================================================ */

  function copyText(text) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      return navigator.clipboard.writeText(text).catch(function () {
        return legacyCopy(text);
      });
    }
    return Promise.resolve(legacyCopy(text));
  }

  function legacyCopy(text) {
    try {
      var area = document.createElement('textarea');
      area.value = text;
      area.style.position = 'fixed';
      area.style.opacity = '0';
      document.body.appendChild(area);
      area.select();
      document.execCommand('copy');
      document.body.removeChild(area);
    } catch (error) {
      /* 忽略 */
    }
  }

  function copyCurrentLink() {
    copyText(window.location.href).then(function () {
      toast('链接已复制');
    });
  }

  /* ================================================================
   * 启动
   * ================================================================ */

  async function boot() {
    bindEvents();
    watchSystemTheme();

    // 静态服务器下随机刷新会 404 的提示
    try {
      state.manifest = await loadManifest();
    } catch (error) {
      el.tree.innerHTML = '<p class="tree__placeholder">目录读取失败</p>';
      showWelcome(
        '目录索引读取失败',
        error.message + ' 如果是在本地打开，请用 node tools/dev-server.mjs 启动本地服务器。',
      );
      return;
    }

    if (!state.manifest || !Array.isArray(state.manifest.tree)) {
      showWelcome('索引格式不正确', 'md-index.json 的结构不对，请重新运行 npm run build。');
      return;
    }

    state.files = flatten(state.manifest.tree);
    state.files.forEach(function (file) {
      state.fileMap[file.path] = file;
    });

    if (state.manifest.stats) {
      el.stats.textContent =
        state.manifest.stats.files +
        ' 篇文档 · ' +
        state.manifest.stats.dirs +
        ' 个目录';
    }

    document.querySelector('#brand-sub').textContent = state.manifest.root + '/ · ' + state.files.length + ' 篇';

    buildTree();

    var route = parseHash();
    if (!route || !route.path) {
      var home = state.fileMap[docRoot() + '/index.md'];
      if (home) {
        syncHash({ path: home.path }, true);
        await applyRoute({ smooth: false });
      } else if (state.files.length) {
        showWelcome('MD Pages', '从左侧目录里选择一篇文档开始阅读。');
      } else {
        showWelcome('还没有文档', '在 md/ 目录里放一些 .md 文件，然后运行 npm run build。');
      }
      return;
    }

    await applyRoute({ smooth: false });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();





