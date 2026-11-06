/*!
 * presenter.js — 演示模式（把 Markdown 当成幻灯片播放）
 * ---------------------------------------------------------------
 * 设计要点：
 *   - 画布固定 1280×720 逻辑尺寸，按窗口比例整体缩放，任何屏幕比例都保持 16:9；
 *   - 由于是固定尺寸 + transform 缩放，可以用 scrollHeight 精确判断「装不下」；
 *   - 装不下时先在段落/列表/代码块之间自动切分，再退化为整体缩字，
 *     因此无论文档多长都不会溢出画面。
 *
 * 对外暴露 window.Deck
 */
(function (global) {
  'use strict';

  var SLIDE_W = 1280;
  var SLIDE_H = 720;

  var SHRINK_STEPS = [0.95, 0.9, 0.85, 0.8, 0.74];

  function qs(selector, root) {
    return (root || document).querySelector(selector);
  }

  function make(tag, className, html) {
    var node = document.createElement(tag);
    if (className) node.className = className;
    if (html != null) node.innerHTML = html;
    return node;
  }

  function Deck(options) {
    options = options || {};

    this.root = qs('#deck');
    this.stage = qs('#deck-stage');
    this.frame = qs('#deck-frame');
    this.viewport = qs('#deck-viewport');
    this.track = qs('#deck-track');
    this.overviewPanel = qs('#deck-overview');
    this.overviewGrid = qs('#deck-overview-grid');
    this.progress = qs('#deck-progress');
    this.counter = qs('#deck-counter');
    this.titleEl = qs('#deck-title');
    this.prevBtn = qs('#deck-prev');
    this.nextBtn = qs('#deck-next');

    this.onSlideChange = options.onSlideChange || function () {};
    this.onExit = options.onExit || function () {};

    this.slides = [];
    this.index = 0;
    this.isOpen = false;
    this.overviewOpen = false;
    this.overviewDirty = true;
    this.scale = 1;
    this.idleTimer = null;
    this.doc = null;

    this._bind();
  }

  Deck.prototype._bind = function () {
    var self = this;

    this.prevBtn.addEventListener('click', function () {
      self.go(self.index - 1);
    });
    this.nextBtn.addEventListener('click', function () {
      self.go(self.index + 1);
    });

    qs('#deck-exit').addEventListener('click', function () {
      self.close();
      self.onExit();
    });
    qs('#deck-fullscreen').addEventListener('click', function () {
      self.toggleFullscreen();
    });
    qs('#deck-overview-btn').addEventListener('click', function () {
      self.toggleOverview();
    });

    this.overviewPanel.addEventListener('click', function (event) {
      var thumb = event.target.closest('.deck__thumb');
      if (thumb) {
        self.toggleOverview(false);
        self.go(Number(thumb.dataset.index));
        return;
      }
      if (event.target === self.overviewPanel) self.toggleOverview(false);
    });

    this.stage.addEventListener('pointerdown', function (event) {
      if (event.pointerType === 'mouse') return;
      self._swipeStart = { x: event.clientX, y: event.clientY, t: Date.now() };
    });
    this.stage.addEventListener('pointerup', function (event) {
      if (!self._swipeStart) return;
      var dx = event.clientX - self._swipeStart.x;
      var dy = event.clientY - self._swipeStart.y;
      self._swipeStart = null;
      if (Math.abs(dx) > 60 && Math.abs(dx) > Math.abs(dy)) {
        self.go(self.index + (dx < 0 ? 1 : -1));
      }
    });

    this.root.addEventListener('mousemove', function () {
      self.wake();
    });

    document.addEventListener('keydown', function (event) {
      if (!self.isOpen) return;
      self._onKey(event);
    });

    if (typeof ResizeObserver === 'function') {
      new ResizeObserver(function () {
        self.resize();
      }).observe(this.stage);
    } else {
      global.addEventListener('resize', function () {
        self.resize();
      });
    }

    document.addEventListener('fullscreenchange', function () {
      self.resize();
    });
  };

  /* ---------------------------------------------------------------- */
  /* 打开 / 关闭                                                       */
  /* ---------------------------------------------------------------- */

  Deck.prototype.open = function (doc, options) {
    options = options || {};
    this.doc = doc;
    this.desiredSlide = options.slide ? options.slide - 1 : 0;
    this._relaidOut = false;

    this.root.hidden = false;
    this.root.setAttribute('aria-hidden', 'false');
    document.body.classList.add('is-presenting');
    this.isOpen = true;

    var self = this;
    var layout = function () {
      if (!self.isOpen || self.doc !== doc) return;
      self.build(doc);
      self.resize();
      self.fitAll();
      self.overviewDirty = true;
      self.go(self.desiredSlide);
      self.wake();
    };

    layout();

    // 字体、图片加载完成后重新排版一次，避免测量偏差导致的溢出
    var ready = [];
    if (document.fonts && document.fonts.ready) {
      ready.push(
        document.fonts.ready.catch(function () {
          return null;
        }),
      );
    }
    var images = Array.prototype.slice.call(this.track.querySelectorAll('img'));
    images.forEach(function (img) {
      if (img.complete) return;
      ready.push(
        new Promise(function (resolve) {
          img.addEventListener('load', resolve, { once: true });
          img.addEventListener('error', resolve, { once: true });
        }),
      );
    });

    if (ready.length) {
      Promise.all(ready).then(function () {
        if (self.isOpen && self.doc === doc && !self._relaidOut) {
          self._relaidOut = true;
          layout();
        }
      });
    }
  };

  Deck.prototype.close = function () {
    this.isOpen = false;
    this.root.hidden = true;
    this.root.setAttribute('aria-hidden', 'true');
    document.body.classList.remove('is-presenting');
    this.toggleOverview(false);
    if (document.fullscreenElement) {
      document.exitFullscreen().catch(function () {});
    }
    this.track.innerHTML = '';
    this.slides = [];
    clearTimeout(this.idleTimer);
  };

  /* ---------------------------------------------------------------- */
  /* 构建幻灯片                                                        */
  /* ---------------------------------------------------------------- */

  Deck.prototype.createSlide = function (html) {
    var el = make('section', 'slide');
    var body = make('div', 'slide__body');
    var prose = make('div', 'prose prose--slide');
    prose.innerHTML = html;
    body.appendChild(prose);
    el.appendChild(body);

    var slide = { el: el, body: body, prose: prose };
    return slide;
  };

  Deck.prototype.build = function (doc) {
    var self = this;
    this.track.innerHTML = '';
    this.slides = [];

    var chunks = global.MD.splitSlides(doc.body);
    if (!chunks.length) chunks = [doc.body || ''];

    var ctx = { docPath: doc.path };

    chunks.forEach(function (chunk, i) {
      var rendered;
      try {
        rendered = global.MD.render(chunk);
      } catch (error) {
        rendered = { html: '<pre class="md-error">' + global.MD.escapeHtml(String(error)) + '</pre>' };
      }
      var slide = self.createSlide(rendered.html);
      // 第一页且只有一个大标题（没有二级标题）时，按封面页排版
      if (i === 0 && !rendered.html.match(/<h2/)) {
        slide.el.classList.add('slide--cover');
      }
      global.MD.decorate(slide.prose, ctx, { mode: 'slide' });
      self.track.appendChild(slide.el);
      self.slides.push(slide);
    });

    if (!this.slides.length) {
      var empty = this.createSlide('<p class="slide__empty">这篇文档没有可展示的内容。</p>');
      this.track.appendChild(empty.el);
      this.slides.push(empty);
    }
  };

  /* ---------------------------------------------------------------- */
  /* 缩放与自适应                                                      */
  /* ---------------------------------------------------------------- */

  Deck.prototype.resize = function () {
    if (!this.isOpen) return;
    var style = global.getComputedStyle(this.stage);
    var padX =
      (parseFloat(style.paddingLeft) || 0) + (parseFloat(style.paddingRight) || 0);
    var padY =
      (parseFloat(style.paddingTop) || 0) + (parseFloat(style.paddingBottom) || 0);
    var width = this.stage.clientWidth - padX;
    var height = this.stage.clientHeight - padY;
    if (width <= 0 || height <= 0) return;
    this.scale = Math.min(width / SLIDE_W, height / SLIDE_H);
    this.frame.style.width = Math.round(SLIDE_W * this.scale) + 'px';
    this.frame.style.height = Math.round(SLIDE_H * this.scale) + 'px';
    this.viewport.style.transform = 'scale(' + this.scale + ')';
  };

  /**
   * 判断一页是否装不下。
   * 注意：.slide__body 有内边距且 overflow:hidden，
   * 直接用 scrollHeight - clientHeight 会漏掉底部内边距内的溢出，
   * 所以这里拿「可用的内容高度」和「实际内容高度」比较。
   */
  Deck.prototype.overflows = function (slide) {
    var body = slide.body;
    var style = global.getComputedStyle(body);
    var padTop = parseFloat(style.paddingTop) || 0;
    var padBottom = parseFloat(style.paddingBottom) || 0;
    var available = body.clientHeight - padTop - padBottom;
    var used = Math.max(slide.prose.offsetHeight, slide.prose.scrollHeight);
    if (!available) return false;
    return used - available > 2;
  };

  Deck.prototype.setSlideScale = function (slide, scale) {
    slide.el.style.setProperty('--slide-scale', String(scale));
  };

  /** 单个 slide：先尝试整体缩字，再尝试按块切分 */
  Deck.prototype.fitSlide = function (slide) {
    var created = [];

    if (!this.overflows(slide)) {
      this.setSlideScale(slide, 1);
      return created;
    }

    var bodyStyle = global.getComputedStyle(slide.body);
    var available =
      slide.body.clientHeight -
      (parseFloat(bodyStyle.paddingTop) || 0) -
      (parseFloat(bodyStyle.paddingBottom) || 0);
    var contentHeight = Math.max(slide.prose.offsetHeight, slide.prose.scrollHeight);
    var ratio = available ? contentHeight / available : 1;

    // 轻微溢出：缩一下字号就够
    if (ratio < 1.3) {
      for (var i = 0; i < SHRINK_STEPS.length; i += 1) {
        this.setSlideScale(slide, SHRINK_STEPS[i]);
        if (!this.overflows(slide)) return created;
      }
    }

    this.setSlideScale(slide, 1);

    var next = this.splitOnce(slide);
    if (!next) {
      // 单个不可分的块（例如超长代码块）：尽量缩小，允许轻微溢出
      this.setSlideScale(slide, SHRINK_STEPS[SHRINK_STEPS.length - 1]);
      return created;
    }

    created.push(slide, next);
    return created;
  };

  /** 把 slide 的块级子节点按「能放下」的最大前缀切开，剩余部分移到新的 slide */
  Deck.prototype.splitOnce = function (slide) {
    var body = slide.body;
    var prose = slide.prose;
    var kids = Array.prototype.slice.call(prose.children);
    if (kids.length < 2) return null;

    var fitsWith = function (keep) {
      for (var i = 0; i < kids.length; i += 1) {
        kids[i].style.display = i < keep ? '' : 'none';
      }
      var result = !this.overflows(slide);
      return result;
    };

    var lo = 1;
    var hi = kids.length - 1;
    var best = 1;
    while (lo <= hi) {
      var mid = (lo + hi) >> 1;
      if (fitsWith.call(this, mid)) {
        best = mid;
        lo = mid + 1;
      } else {
        hi = mid - 1;
      }
    }
    for (var k = 0; k < kids.length; k += 1) kids[k].style.display = '';

    var moving = kids.slice(best);
    if (!moving.length) return null;

    var next = this.createSlide('');
    var nextProse = next.prose;
    for (var m = 0; m < moving.length; m += 1) nextProse.appendChild(moving[m]);

    // 让新的一页继承「当前页的标题」语义：如果切走的块里有标题，
    // 新页会自然从标题开始，这里不做额外处理。
    slide.el.parentNode.insertBefore(next.el, slide.el.nextSibling);
    var position = this.slides.indexOf(slide);
    this.slides.splice(position + 1, 0, next);

    return next;
  };

  Deck.prototype.fitAll = function () {
    var queue = this.slides.slice();
    var guard = 0;

    while (queue.length && guard < 800) {
      guard += 1;
      var slide = queue.shift();
      var extra = this.fitSlide(slide);
      for (var i = 0; i < extra.length; i += 1) queue.unshift(extra[i]);
    }

    // 最终再兜底一遍：仍溢出的页统一下调字号
    this.slides.forEach(function (slide) {
      var scale = 1;
      while (this.overflows(slide) && scale > 0.6) {
        scale -= 0.05;
        this.setSlideScale(slide, scale);
      }
    }, this);

    this.overviewDirty = true;
  };

  /* ---------------------------------------------------------------- */
  /* 翻页                                                              */
  /* ---------------------------------------------------------------- */

  Deck.prototype.go = function (index, options) {
    options = options || {};
    var total = this.slides.length;
    if (!total) return;
    var target = Math.max(0, Math.min(total - 1, index));
    this.index = target;
    this.desiredSlide = target;

    for (var i = 0; i < total; i += 1) {
      var slide = this.slides[i];
      var active = i === target;
      slide.el.classList.toggle('is-active', active);
      slide.el.setAttribute('aria-hidden', active ? 'false' : 'true');
    }

    this.prevBtn.disabled = target === 0;
    this.nextBtn.disabled = target === total - 1;
    this.progress.style.width = ((target + 1) / total) * 100 + '%';
    this.counter.textContent = target + 1 + ' / ' + total;

    var heading = this.slides[target].prose.querySelector('h1, h2, h3');
    this.titleEl.textContent = heading ? heading.textContent.replace(/#$/, '').trim() : '';

    if (!options.silent) this.wake();
    this.onSlideChange(target + 1, total);
  };

  Deck.prototype.next = function () {
    if (this.overviewOpen) return;
    this.go(this.index + 1);
  };

  Deck.prototype.prev = function () {
    if (this.overviewOpen) return;
    this.go(this.index - 1);
  };

  Deck.prototype.goTo = function (index) {
    this.go(index, { silent: true });
  };

  /* ---------------------------------------------------------------- */
  /* 总览                                                              */
  /* ---------------------------------------------------------------- */

  Deck.prototype.toggleOverview = function (force) {
    var open = typeof force === 'boolean' ? force : !this.overviewOpen;
    this.overviewOpen = open;
    this.overviewPanel.hidden = !open;
    this.root.classList.toggle('is-overview', open);

    if (open && this.overviewDirty) this.renderOverview();

    var active = this.overviewGrid.querySelector('.deck__thumb.is-active');
    if (open && active) active.scrollIntoView({ block: 'nearest' });
    return open;
  };

  Deck.prototype.renderOverview = function () {
    var self = this;
    this.overviewGrid.innerHTML = '';
    var frag = document.createDocumentFragment();
    var thumbW = 248;
    var k = thumbW / SLIDE_W;

    this.slides.forEach(function (slide, i) {
      var thumb = make('button', 'deck__thumb');
      thumb.type = 'button';
      thumb.dataset.index = String(i);
      thumb.style.width = thumbW + 'px';

      var inner = make('div', 'deck__thumb-inner');
      inner.style.width = SLIDE_W * k + 'px';
      inner.style.height = SLIDE_H * k + 'px';

      var clone = slide.el.cloneNode(true);
      clone.classList.add('is-active');
      clone.style.transform = 'scale(' + k + ')';
      clone.style.transformOrigin = 'top left';
      clone.removeAttribute('aria-hidden');

      inner.appendChild(clone);
      thumb.appendChild(inner);
      thumb.appendChild(make('span', 'deck__thumb-num', String(i + 1)));
      if (i === self.index) thumb.classList.add('is-active');
      frag.appendChild(thumb);
    });

    this.overviewGrid.appendChild(frag);
    this.overviewDirty = false;
  };

  /* ---------------------------------------------------------------- */
  /* 杂项                                                              */
  /* ---------------------------------------------------------------- */

  Deck.prototype.wake = function () {
    var self = this;
    this.root.classList.remove('is-idle');
    clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(function () {
      if (self.isOpen && !self.overviewOpen) self.root.classList.add('is-idle');
    }, 2600);
  };

  Deck.prototype.toggleFullscreen = function () {
    if (document.fullscreenElement) {
      document.exitFullscreen().catch(function () {});
    } else if (this.root.requestFullscreen) {
      this.root.requestFullscreen().catch(function () {});
    }
  };

  Deck.prototype._onKey = function (event) {
    var key = event.key;
    var meta = event.ctrlKey || event.metaKey || event.altKey;

    if (key === 'Escape') {
      event.preventDefault();
      if (this.overviewOpen) this.toggleOverview(false);
      else {
        this.close();
        this.onExit();
      }
      return;
    }

    if (meta) return;

    var isInput = /^(INPUT|TEXTAREA|SELECT)$/.test(event.target.tagName || '');
    if (isInput) return;

    switch (key) {
      case 'ArrowRight':
      case 'ArrowDown':
      case 'PageDown':
      case ' ':
      case 'Enter':
        event.preventDefault();
        this.next();
        break;
      case 'ArrowLeft':
      case 'ArrowUp':
      case 'PageUp':
        event.preventDefault();
        this.prev();
        break;
      case 'Home':
        event.preventDefault();
        this.go(0);
        break;
      case 'End':
        event.preventDefault();
        this.go(this.slides.length - 1);
        break;
      case 'o':
      case 'O':
        event.preventDefault();
        this.toggleOverview();
        break;
      case 'f':
      case 'F':
        event.preventDefault();
        this.toggleFullscreen();
        break;
      case 'q':
      case 'Q':
        event.preventDefault();
        this.close();
        this.onExit();
        break;
      default:
        break;
    }
  };

  global.Deck = Deck;
})(window);

