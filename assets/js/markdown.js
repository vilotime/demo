/*!
 * markdown.js — Markdown 渲染管线
 * ---------------------------------------------------------------
 * 依赖全局的 marked（assets/vendor/marked.min.js）与可选的 hljs。
 * 对外暴露 window.MD：
 *   MD.render(src)                      → { body, html, words, minutes, title }
 *   MD.decorate(root, ctx, options)     → 就地加工 DOM（标题锚点/图片/链接/代码块/表格）
 *   MD.extractToc(root, maxLevel)       → [{ id, level, text }]
 *   MD.splitSlides(body, meta)          → string[]  按分页规则切成若干段
 *   MD.encodePath(p) / MD.decodePath(p) / MD.dirname(p) / MD.resolve(docPath, href)
 */
(function (global) {
  'use strict';

  var lib = global.marked;
  if (!lib || !lib.Marked) {
    throw new Error('[MD] marked 未加载，请检查 assets/vendor/marked.min.js');
  }

  /* ================================================================
   * 1. 工具函数
   * ================================================================ */

  var ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };

  function decodeEntities(text) {
    return String(text).replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, function (match, entity) {
      if (entity.charAt(0) === '#') {
        var code =
          entity.charAt(1).toLowerCase() === 'x'
            ? parseInt(entity.slice(2), 16)
            : parseInt(entity.slice(1), 10);
        return isFinite(code) && code > 0 ? String.fromCodePoint(code) : match;
      }
      var named = ENTITIES[entity.toLowerCase()];
      return named === undefined ? match : named;
    });
  }

  function htmlToText(html) {
    var withBreaks = String(html)
      .replace(/<br\s*\/?>/gi, ' ')
      .replace(/<[^>]*>/g, '');
    return decodeEntities(withBreaks).replace(/\s+/g, ' ').trim();
  }

  function escapeHtml(text) {
    return String(text)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  /** 估算字数：中文按字、西文按词 */
  function countWords(text) {
    var cjk = text.match(/[\u3400-\u4dbf\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7af]/g);
    var latin = text
      .replace(/[\u3400-\u4dbf\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7af]/g, ' ')
      .match(/[A-Za-z0-9][A-Za-z0-9'’\-]*/g);
    return (cjk ? cjk.length : 0) + (latin ? latin.length : 0);
  }

  /* ================================================================
   * 2. 路径处理
   * ================================================================ */

  var MARKDOWN_RE = /\.(md|markdown)$/i;
  var EXTERNAL_RE = /^(?:[a-z][a-z0-9+.-]*:|\/\/)/i;

  function safeDecode(text) {
    try {
      return decodeURIComponent(text);
    } catch (error) {
      return text;
    }
  }

  function encodePath(path) {
    return String(path)
      .split('/')
      .map(function (segment) {
        return encodeURIComponent(segment);
      })
      .join('/');
  }

  function decodePath(path) {
    return String(path)
      .split('/')
      .map(safeDecode)
      .join('/');
  }

  function dirname(path) {
    var idx = String(path).lastIndexOf('/');
    return idx === -1 ? '' : path.slice(0, idx);
  }

  function basename(path) {
    var idx = String(path).lastIndexOf('/');
    return idx === -1 ? path : path.slice(idx + 1);
  }

  /** 把相对路径按 baseDir 归一化，返回不含前导斜杠的仓库内路径 */
  function resolveRelative(baseDir, relative) {
    var stack = baseDir ? baseDir.split('/').filter(Boolean) : [];
    var parts = String(relative).split('/');
    for (var i = 0; i < parts.length; i += 1) {
      var part = parts[i];
      if (!part || part === '.') continue;
      if (part === '..') stack.pop();
      else stack.push(part);
    }
    return stack.join('/');
  }

  /**
   * 把文档里的相对链接解析成站点内的实际路径。
   * 返回 { kind: 'external'|'anchor'|'doc'|'asset', path, href, query, hash }
   */
  function resolve(docPath, href) {
    var raw = String(href == null ? '' : href).trim();
    if (!raw) return { kind: 'external', href: raw };
    if (raw.charAt(0) === '#') {
      return { kind: 'anchor', hash: safeDecode(raw.slice(1)) };
    }
    if (EXTERNAL_RE.test(raw)) {
      return { kind: 'external', href: raw };
    }

    var working = raw;
    var hash = '';
    var query = '';
    var hashIdx = working.indexOf('#');
    if (hashIdx !== -1) {
      hash = safeDecode(working.slice(hashIdx + 1));
      working = working.slice(0, hashIdx);
    }
    var queryIdx = working.indexOf('?');
    if (queryIdx !== -1) {
      query = working.slice(queryIdx + 1);
      working = working.slice(0, queryIdx);
    }

    var decoded = decodePath(working);
    var absolute = decoded.charAt(0) === '/';
    var path = absolute
      ? decoded.replace(/^\/+/, '')
      : resolveRelative(dirname(docPath), decoded);

    if (MARKDOWN_RE.test(path)) {
      return { kind: 'doc', path: path, query: query, hash: hash };
    }
    return { kind: 'asset', path: path, query: query, hash: hash };
  }

  /* ================================================================
   * 3. 兼容：剥离开头的 YAML 块
   * ================================================================ */

  /**
   * 兼容处理：文档开头若带了 YAML 块（被 --- 包起来），把它剥掉不参与渲染。
   * 站点本身不需要这种写法，标题一律取自正文里的第一个一级标题。
   */
  function parseFrontmatter(source) {
    var text = String(source == null ? '' : source);
    if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
    text = text.replace(/\r\n?/g, '\n');

    var match = /^---[ \t]*\n([\s\S]*?)\n---[ \t]*(?:\n|$)/.exec(text);
    if (!match) return { meta: {}, body: text, raw: '' };

    var meta = {};
    var lines = match[1].split('\n');
    var currentKey = null;

    for (var i = 0; i < lines.length; i += 1) {
      var line = lines[i];
      if (!line.trim() || /^\s*#/.test(line)) continue;

      var pair = /^([A-Za-z0-9_\u4e00-\u9fff-]+)\s*:\s*(.*)$/.exec(line);
      if (pair) {
        var key = pair[1].trim().toLowerCase();
        var value = pair[2].trim();
        if (
          (value.charAt(0) === '"' && value.charAt(value.length - 1) === '"') ||
          (value.charAt(0) === "'" && value.charAt(value.length - 1) === "'")
        ) {
          value = value.slice(1, -1);
        }
        if (/^(true|yes|on)$/i.test(value)) meta[key] = true;
        else if (/^(false|no|off)$/i.test(value)) meta[key] = false;
        else meta[key] = value;
        currentKey = key;
      } else if (/^\s+-\s+/.test(line) && currentKey) {
        // 简易数组支持： list:\n  - a\n  - b
        if (!Array.isArray(meta[currentKey])) meta[currentKey] = [];
        meta[currentKey].push(line.replace(/^\s+-\s+/, '').trim());
      }
    }

    return { meta: meta, body: text.slice(match[0].length), raw: match[1] };
  }

  /* ================================================================
   * 4. marked 实例
   * ================================================================ */

  var usedIds = Object.create(null);

  function slugify(text) {
    var base = String(text)
      .trim()
      .toLowerCase()
      .replace(/[\s]+/g, '-')
      .replace(/[^\p{L}\p{N}\-_]/gu, '')
      .replace(/-{2,}/g, '-')
      .replace(/^-+|-+$/g, '');
    if (!base) base = 'section';
    if (/^[0-9]/.test(base)) base = 'h-' + base;

    var id = base;
    var counter = 2;
    while (usedIds[id]) {
      id = base + '-' + counter;
      counter += 1;
    }
    usedIds[id] = true;
    return id;
  }

  var renderer = {
    heading: function (token) {
      var inner = this.parser.parseInline(token.tokens);
      var plain = htmlToText(inner) || htmlToText(token.text || '');
      var id = slugify(plain);
      return (
        '<h' +
        token.depth +
        ' id="' +
        escapeHtml(id) +
        '">' +
        inner +
        '</h' +
        token.depth +
        '>\n'
      );
    },
  };

  var instance = new lib.Marked({
    gfm: true,
    breaks: true,
    pedantic: false,
    renderer: renderer,
  });

  /* ================================================================
   * 5. 渲染
   * ================================================================ */

  /**
   * 渲染一篇 Markdown。
   * 标题只从正文里推导（第一个一级标题），不需要在文档里写任何元信息。
   */
  function render(source) {
    var parsed = parseFrontmatter(source);
    var body = parsed.body;

    usedIds = Object.create(null);

    var html;
    try {
      html = instance.parse(body, { breaks: true, gfm: true });
    } catch (error) {
      console.error('[MD] 渲染失败', error);
      html =
        '<pre class="md-error">Markdown 渲染出错：' +
        escapeHtml(error && error.message ? error.message : String(error)) +
        '</pre>';
    }

    var plain = htmlToText(html);
    var words = countWords(plain);

    // 文档标题 = 正文里的第一个一级标题
    var headingMatch = /<h1[^>]*>([\s\S]*?)<\/h1>/.exec(html);
    var title = headingMatch ? htmlToText(headingMatch[1]) : '';

    return {
      body: body,
      html: html,
      words: words,
      minutes: Math.max(1, Math.round(words / 350)),
      title: title,
      plain: plain,
    };
  }

  /* ================================================================
   * 6. DOM 加工
   * ================================================================ */

  function decorate(root, context, options) {
    options = options || {};
    context = context || {};
    var docPath = context.docPath || '';
    var mode = options.mode || 'read';

    // ---- 标题：加锚点链接 ----
    if (mode === 'read') {
      var headings = root.querySelectorAll('h1[id], h2[id], h3[id], h4[id], h5[id], h6[id]');
      Array.prototype.forEach.call(headings, function (heading) {
        heading.classList.add('heading');
        var anchor = document.createElement('a');
        anchor.className = 'heading__anchor';
        anchor.href =
          '#/' + encodePath(docPath) + '#' + encodeURIComponent(heading.id);
        anchor.setAttribute('aria-label', '复制此章节链接');
        anchor.dataset.anchor = heading.id;
        anchor.innerHTML =
          '<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><path fill="currentColor" d="M7.775 3.275a.75.75 0 0 0 1.06 1.06l1.25-1.25a2 2 0 1 1 2.83 2.83l-2.5 2.5a2 2 0 0 1-2.83 0 .75.75 0 0 0-1.06 1.06 3.5 3.5 0 0 0 4.95 0l2.5-2.5a3.5 3.5 0 0 0-4.95-4.95l-1.25 1.25Zm-4.69 9.64a2 2 0 0 1 0-2.83l2.5-2.5a2 2 0 0 1 2.83 0 .75.75 0 0 0 1.06-1.06 3.5 3.5 0 0 0-4.95 0l-2.5 2.5a3.5 3.5 0 0 0 4.95 4.95l1.25-1.25a.75.75 0 0 0-1.06-1.06l-1.25 1.25a2 2 0 0 1-2.83 0Z"/></svg>';
        heading.appendChild(anchor);
      });
    }

    // ---- 代码块：高亮 + 语言标签 + 复制按钮 ----
    var blocks = root.querySelectorAll('pre > code');
    Array.prototype.forEach.call(blocks, function (code) {
      var pre = code.parentNode;
      if (pre.parentNode && pre.parentNode.classList.contains('code-block__body')) return;

      var className = code.className || '';
      var langMatch = /(?:language|lang)-([a-z0-9+#_-]+)/i.exec(className);
      var lang = langMatch ? langMatch[1].toLowerCase() : '';

      if (global.hljs) {
        try {
          if (lang && global.hljs.getLanguage(lang)) {
            code.innerHTML = global.hljs.highlight(code.textContent, {
              language: lang,
              ignoreIllegals: true,
            }).value;
          } else if (!lang) {
            var auto = global.hljs.highlightAuto(code.textContent);
            if (auto.relevance > 5) code.innerHTML = auto.value;
          }
        } catch (error) {
          /* 高亮失败时保留纯文本 */
        }
      }
      code.classList.add('hljs');

      var wrapper = document.createElement('div');
      wrapper.className = 'code-block';
      var bar = document.createElement('div');
      bar.className = 'code-block__bar';
      bar.innerHTML =
        '<span class="code-block__lang">' +
        escapeHtml(lang || 'text') +
        '</span>' +
        '<button type="button" class="code-block__copy" data-copy>复制</button>';
      var body = document.createElement('div');
      body.className = 'code-block__body';

      pre.parentNode.insertBefore(wrapper, pre);
      body.appendChild(pre);
      wrapper.appendChild(bar);
      wrapper.appendChild(body);
    });

    // ---- 表格：包一层可横向滚动容器 ----
    var tables = root.querySelectorAll('table');
    Array.prototype.forEach.call(tables, function (table) {
      if (table.parentNode && table.parentNode.classList.contains('table-wrap')) return;
      var wrap = document.createElement('div');
      wrap.className = 'table-wrap';
      table.parentNode.insertBefore(wrap, table);
      wrap.appendChild(table);
    });

    // ---- 任务列表 ----
    var boxes = root.querySelectorAll('li > input[type="checkbox"]');
    Array.prototype.forEach.call(boxes, function (box) {
      if (box.parentNode) box.parentNode.classList.add('task-item');
    });

    // ---- 链接 ----
    var anchors = root.querySelectorAll('a[href]');
    Array.prototype.forEach.call(anchors, function (anchor) {
      if (anchor.classList.contains('heading__anchor')) return;
      var href = anchor.getAttribute('href');
      var info = resolve(docPath, href);

      if (info.kind === 'external') {
        anchor.setAttribute('target', '_blank');
        anchor.setAttribute('rel', 'noopener noreferrer');
        anchor.classList.add('is-external');
        return;
      }
      if (info.kind === 'anchor') {
        anchor.setAttribute('href', '#/' + encodePath(docPath) + '#' + encodeURIComponent(info.hash));
        anchor.dataset.anchor = info.hash;
        anchor.classList.add('is-anchor');
        return;
      }
      if (info.kind === 'doc') {
        var url = '#/' + encodePath(info.path);
        if (info.hash) url += '#' + encodeURIComponent(info.hash);
        anchor.setAttribute('href', url);
        anchor.classList.add('is-internal-link');
        anchor.dataset.docPath = info.path;
        return;
      }
      // 资源文件
      var assetUrl = encodePath(info.path);
      if (info.query) assetUrl += '?' + info.query;
      if (info.hash) assetUrl += '#' + info.hash;
      anchor.setAttribute('href', assetUrl);
      anchor.setAttribute('target', '_blank');
      anchor.setAttribute('rel', 'noopener');
    });

    // ---- 图片 ----
    var images = root.querySelectorAll('img[src], source[src], video[src], audio[src]');
    Array.prototype.forEach.call(images, function (media) {
      var src = media.getAttribute('src');
      if (!src || src.slice(0, 5) === 'data:' || EXTERNAL_RE.test(src)) return;
      var info = resolve(docPath, src);
      if (info.kind === 'asset' || info.kind === 'doc') {
        var url = encodePath(info.path);
        if (info.query) url += '?' + info.query;
        media.setAttribute('src', url);
        if (media.tagName === 'IMG') {
          media.loading = 'lazy';
          media.decoding = 'async';
          media.classList.add('zoomable');
        }
      }
    });
  }

  /* ================================================================
   * 7. 大纲
   * ================================================================ */

  function extractToc(root, maxLevel) {
    var limit = maxLevel || 3;
    var nodes = root.querySelectorAll('h1[id], h2[id], h3[id], h4[id], h5[id], h6[id]');
    var toc = [];
    Array.prototype.forEach.call(nodes, function (node) {
      var level = Number(node.tagName.slice(1));
      if (level > limit) return;
      var clone = node.cloneNode(true);
      var anchor = clone.querySelector('.heading__anchor');
      if (anchor) anchor.remove();
      var text = (clone.textContent || '').trim();
      if (!text) return;
      toc.push({ id: node.id, level: level, text: text });
    });
    return toc;
  }

  /* ================================================================
   * 8. 演示模式分页
   * ================================================================ */

  // 没有分页符时，依次尝试用二级标题、一级标题分页
  var LEVELS = [2, 1];

  var RULE_RE = /^\s*(?:-{3,}|\*{3,}|_{3,})\s*$/;
  var COMMENT_RE = /^\s*<!--\s*(?:slide|page|break|next|分页)\s*-->\s*$/i;

  function isBlank(line) {
    return line === undefined || /^\s*$/.test(line);
  }

  /** 标记哪些行位于围栏代码块内部（这些行不参与分页识别） */
  function computeFenceMask(lines) {
    var mask = new Array(lines.length);
    var fence = null;
    for (var i = 0; i < lines.length; i += 1) {
      var line = lines[i];
      var match = /^\s{0,3}(`{3,}|~{3,})/.exec(line);
      if (match) {
        if (!fence) {
          fence = match[1].charAt(0);
          mask[i] = true;
          continue;
        }
        if (match[1].charAt(0) === fence) {
          fence = null;
          mask[i] = true;
          continue;
        }
      }
      mask[i] = Boolean(fence);
    }
    return mask;
  }

  function headingLevelOf(line) {
    var match = /^\s{0,3}(#{1,6})\s+/.exec(line);
    return match ? match[1].length : 0;
  }

  function splitByHeadingLevel(lines, mask, level) {
    var positions = [];
    for (var i = 0; i < lines.length; i += 1) {
      if (mask[i]) continue;
      if (headingLevelOf(lines[i]) === level) positions.push(i);
    }
    if (positions.length < 2) return [];

    var chunks = [];
    var preamble = lines.slice(0, positions[0]).join('\n').trim();
    for (var p = 0; p < positions.length; p += 1) {
      var start = positions[p];
      var end = p + 1 < positions.length ? positions[p + 1] : lines.length;
      var chunk = lines.slice(start, end).join('\n').trim();
      if (p === 0 && preamble) chunk = preamble + '\n\n' + chunk;
      if (chunk) chunks.push(chunk);
    }
    return chunks;
  }

  /**
   * 把一篇文档切成若干张幻灯片。
   * 规则（全部基于正文本身，不需要任何配置）：
   *   1. 独立成行的分隔线 / `<!-- slide -->` → 分页；
   *   2. 一个分页符都没有时，退化为按 `##` 二级标题分页，再退化为 `#`；
   *   3. 都没有就整篇算一页。
   */
  function splitSlides(markdown) {
    var text = String(markdown == null ? '' : markdown).replace(/\r\n?/g, '\n');
    if (!text.trim()) return [];

    var lines = text.split('\n');
    var mask = computeFenceMask(lines);

    var chunks = [];
    var current = [];

    for (var i = 0; i < lines.length; i += 1) {
      var line = lines[i];

      if (!mask[i]) {
        if (COMMENT_RE.test(line)) {
          chunks.push(current);
          current = [];
          continue;
        }
        if (
          RULE_RE.test(line) &&
          isBlank(lines[i - 1]) &&
          (isBlank(lines[i + 1]) || i === lines.length - 1)
        ) {
          chunks.push(current);
          current = [];
          continue;
        }
      }
      current.push(line);
    }
    chunks.push(current);

    var result = chunks
      .map(function (chunk) {
        return chunk.join('\n').trim();
      })
      .filter(Boolean);

    if (result.length > 1) return result;

    for (var l = 0; l < LEVELS.length; l += 1) {
      var byHeading = splitByHeadingLevel(lines, mask, LEVELS[l]);
      if (byHeading.length > 1) return byHeading;
    }

    return result.length ? result : [text.trim()];
  }

  /* ================================================================
   * 导出
   * ================================================================ */

  global.MD = {
    render: render,
    decorate: decorate,
    extractToc: extractToc,
    splitSlides: splitSlides,
    parseFrontmatter: parseFrontmatter,
    countWords: countWords,
    encodePath: encodePath,
    decodePath: decodePath,
    dirname: dirname,
    basename: basename,
    resolve: resolve,
    escapeHtml: escapeHtml,
    htmlToText: htmlToText,
  };
})(window);



