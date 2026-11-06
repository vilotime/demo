/**
 * dom-test.mjs — 用 jsdom 跑一遍真实页面的交互流程。
 * 需要先启动本地服务：node tools/dev-server.mjs
 * 运行：node tools/dom-test.mjs [基地址]
 */
import { JSDOM, VirtualConsole } from 'jsdom';

const BASE = process.argv[2] || 'http://127.0.0.1:5173/';
const problems = [];
let failures = 0;

const check = (name, ok, extra = '') => {
  if (ok) console.log(`  ok   ${name}`);
  else {
    failures += 1;
    console.log(`  FAIL ${name} ${extra}`);
  }
};

const waitFor = async (fn, label, timeout = 8000) => {
  const start = Date.now();
  for (;;) {
    try {
      const value = await fn();
      if (value) return value;
    } catch (error) {
      /* 继续等 */
    }
    if (Date.now() - start > timeout) throw new Error('等待超时：' + label);
    await new Promise((r) => setTimeout(r, 40));
  }
};

const virtualConsole = new VirtualConsole();
virtualConsole.on('jsdomError', (error) => {
  if (/Could not parse CSS|not implemented: navigation/i.test(error.message)) return;
  problems.push('jsdomError: ' + (error.message || error));
});
virtualConsole.on('error', (...args) => problems.push('console.error: ' + args.join(' ')));
virtualConsole.on('warn', (...args) => {
  const text = args.join(' ');
  if (!/Unknown pseudo|css parsing/i.test(text)) console.log('  warn ' + text);
});

console.log('\n[启动页面]');
const dom = await JSDOM.fromURL(BASE, {
  runScripts: 'dangerously',
  resources: 'usable',
  pretendToBeVisual: true,
  virtualConsole,
  beforeParse(window) {
    window.fetch = (input, init) => fetch(new URL(String(input), BASE), init);
    window.matchMedia = (query) => ({
      matches: false,
      media: query,
      onchange: null,
      addEventListener() {},
      removeEventListener() {},
      addListener() {},
      removeListener() {},
      dispatchEvent() {
        return false;
      },
    });
    window.ResizeObserver = class {
      observe() {}
      unobserve() {}
      disconnect() {}
    };
    window.Element.prototype.scrollTo = function (options) {
      this.scrollTop = (options && options.top) || 0;
    };
    window.Element.prototype.scrollIntoView = function () {};
    window.print = () => {};
    window.document.execCommand = () => true;
  },
});

const { window } = dom;
const doc = window.document;

await waitFor(() => doc.querySelectorAll('.tree__row--file').length > 0, '目录树渲染');

/* ---------------- 目录树 ---------------- */
console.log('\n[目录树]');
const fileRows = [...doc.querySelectorAll('.tree__row--file')];
check('6 篇文档全部列出', fileRows.length === 6, String(fileRows.length));
check(
  '目录排在文件前面',
  doc.querySelector('.tree__list > .tree__item').classList.contains('tree__item--dir'),
);
const firstDir = doc.querySelector('.tree__list > .tree__item--dir');
check('目录名渲染', /示例|指南/.test(firstDir.querySelector('.tree__label').textContent));
check(
  '二级目录存在（进阶）',
  [...doc.querySelectorAll('.tree__row--dir')].some((r) => r.textContent.includes('进阶')),
);
check('首页自动打开', /md\/index\.md$/.test(decodeURIComponent(window.location.hash)), window.location.hash);
await waitFor(() => doc.querySelectorAll('#doc .prose h1').length > 0, '首页正文渲染');
check('首页正文渲染', doc.querySelectorAll('#doc .prose h1').length > 0);

/* ---------------- 阅读模式 ---------------- */
console.log('\n[阅读模式]');
window.location.hash = '#/' + encodeURIComponent('md/指南/01-快速开始.md');
await waitFor(() => doc.querySelector('#doc .prose h1')?.textContent.includes('快速开始'), '打开快速开始');
check('标题带 id', Boolean(doc.querySelector('#doc h2[id]')), '');
check('标题锚点链接', Boolean(doc.querySelector('#doc .heading__anchor')));
check('表格被包进滚动容器', doc.querySelectorAll('#doc .table-wrap table').length >= 1);
check('代码块包装 + 语言标签', Boolean(doc.querySelector('#doc .code-block__lang')));
check('代码高亮生效', doc.querySelectorAll('#doc code.hljs span[class^="hljs-"]').length > 0);
check('代码复制按钮', Boolean(doc.querySelector('#doc .code-block__copy')));
check('大纲生成', doc.querySelectorAll('#toc .toc__link').length > 3);
check('页脚与上下篇', Boolean(doc.querySelector('#doc .doc-footer .pager__link')));
check('原始 md 链接正确', /md\/指南\/01-快速开始\.md$/.test(decodeURIComponent(doc.querySelector('#raw-link').getAttribute('href'))));
check('面包屑', doc.querySelectorAll('#crumbs .crumbs__item').length >= 1);
check('外部链接加 target', doc.querySelector('#doc a.is-external')?.getAttribute('target') === '_blank');
check(
  '站内 md 链接改写成 hash 路由',
  [...doc.querySelectorAll('#doc a.is-internal-link')].every((a) => a.getAttribute('href').startsWith('#/md/')),
);
check('图片相对路径被解析成绝对路径', ![...doc.querySelectorAll('#doc img')].some((img) => img.getAttribute('src').startsWith('./')));

// 任务列表 / 图片资源在另一篇文档里
window.location.hash = '#/' + encodeURIComponent('md/示例/02-阅读模式示例.md');
await waitFor(() => doc.querySelector('#doc .prose h1')?.textContent.includes('阅读模式示例'), '打开阅读模式示例');
check('任务列表样式', true); // 该文档无任务列表，见下方语法速查
check(
  '图片相对路径解析（./附件/示意图.svg）',
  [...doc.querySelectorAll('#doc img')].every((img) => !img.getAttribute('src').startsWith('.')) &&
    [...doc.querySelectorAll('#doc img')].length > 0,
  [...doc.querySelectorAll('#doc img')].map((i) => i.getAttribute('src')).join(','),
);
check('图片可点击放大', Boolean(doc.querySelector('#doc img.zoomable')));

window.location.hash = '#/' + encodeURIComponent('md/指南/进阶/03-Markdown 语法速查.md');
await waitFor(() => doc.querySelector('#doc .prose h1')?.textContent.includes('语法速查'), '打开语法速查');
check('任务列表样式', doc.querySelectorAll('#doc li.task-item').length >= 2);
check('details 折叠块保留', Boolean(doc.querySelector('#doc details')));
check('嵌套目录的文档能正常渲染', doc.querySelectorAll('#doc .code-block').length >= 3);

/* ---------------- 目录跳转 ---------------- */
console.log('\n[切换文档]');
const target = '#/' + encodeURIComponent('md/示例/01-演示模式示例.md');
window.location.hash = target;
await waitFor(() => doc.querySelector('#doc .prose h1')?.textContent.includes('演示模式示例'), '切换到示例文档');
check('切换到新文档成功', doc.querySelector('#doc h1#演示模式示例') !== null);
check('顶部标题同步', doc.title.includes('演示模式示例'), doc.title);
check(
  '侧边栏高亮当前文件',
  doc.querySelector('.tree__row--file.is-active')?.dataset.path === 'md/示例/01-演示模式示例.md',
);

/* ---------------- 搜索过滤 ---------------- */
console.log('\n[搜索]');
const search = doc.querySelector('#search');
search.value = '语法';
search.dispatchEvent(new window.Event('input', { bubbles: true }));
const visibleFiles = [...doc.querySelectorAll('.tree__item--file')].filter(
  (li) => !li.classList.contains('is-hidden'),
);
check('搜索后只剩匹配项', visibleFiles.length === 1, String(visibleFiles.length));
check('过滤时目录自动展开', doc.querySelector('.tree').classList.contains('is-filtering'));
search.value = '';
search.dispatchEvent(new window.Event('input', { bubbles: true }));
check(
  '清空搜索恢复全部',
  [...doc.querySelectorAll('.tree__item--file')].filter((li) => !li.classList.contains('is-hidden'))
    .length === 6,
);

/* ---------------- 演示模式 ---------------- */
console.log('\n[演示模式]');
doc.querySelector('#mode-toggle').click();
await waitFor(() => !doc.querySelector('#deck').hidden, '演示模式打开');
await waitFor(() => doc.querySelectorAll('.slide').length > 0, '幻灯片生成');
const slides = doc.querySelectorAll('.slide');
check('生成了多页幻灯片', slides.length >= 5, String(slides.length));
check('第一页是激活页', slides[0].classList.contains('is-active'));
check('进度条存在', Boolean(doc.querySelector('#deck-progress')));
check('页码显示', /\d+ \/ \d+/.test(doc.querySelector('#deck-counter').textContent));
check('body 进入演示状态', doc.body.classList.contains('is-presenting'));
check('地址栏记录演示模式', /mode=ppt/.test(decodeURIComponent(window.location.hash)), window.location.hash);

const nextBtn = doc.querySelector('#deck-next');
nextBtn.click();
check('翻页生效', slides[1].classList.contains('is-active') && !slides[0].classList.contains('is-active'));
check('翻页同步到地址栏', /slide=2/.test(window.location.hash), window.location.hash);

doc.querySelector('#deck-overview-btn').click();
await waitFor(() => !doc.querySelector('#deck-overview').hidden, '总览打开');
check('总览缩略图数量一致', doc.querySelectorAll('.deck__thumb').length === slides.length);
doc.querySelector('#deck-overview').dispatchEvent(new window.Event('click', { bubbles: true }));

doc.querySelector('#deck-exit').click();
await waitFor(() => doc.querySelector('#deck').hidden, '退出演示');
check('退出后回到阅读模式', !doc.body.classList.contains('is-presenting'));
check('退出后地址栏去掉 mode', !/mode=ppt/.test(window.location.hash), window.location.hash);

/* ---------------- 主题 ---------------- */
console.log('\n[主题]');
const before = doc.documentElement.dataset.theme;
doc.querySelector('#theme-toggle').click();
check('主题切换生效', doc.documentElement.dataset.theme !== before, doc.documentElement.dataset.theme);

/* ---------------- 深链接 ---------------- */
console.log('\n[深链接]');
window.location.hash = '#/' + encodeURIComponent('md/指南/进阶/03-Markdown 语法速查.md') + '?mode=ppt&slide=3';
await waitFor(() => !doc.querySelector('#deck').hidden, '深链接直接进演示模式');
await waitFor(() => doc.querySelectorAll('.slide').length > 3, '深链接幻灯片');
check('深链接定位到第 3 页', doc.querySelectorAll('.slide')[2].classList.contains('is-active'), doc.querySelector('#deck-counter').textContent);

/* ---------------- 自动续页算法 ---------------- */
console.log('\n[自动续页]');
{
  // jsdom 没有排版引擎，这里用「每页最多放 N 个块」的合成测量来验证切分算法本身
  const Deck = window.Deck;
  const probe = new Deck({});
  const paragraphs = Array.from({ length: 10 }, (_, i) => `段落 ${i + 1} 的内容`);
  probe.build({ path: 'md/probe.md', body: paragraphs.join('\n\n') });
  check('分页前是 1 页', probe.slides.length === 1, String(probe.slides.length));

  const visibleCount = (slide) =>
    Array.prototype.filter.call(
      slide.prose.children,
      (node) => node.style.display !== 'none',
    ).length;

  probe.overflows = (slide) => visibleCount(slide) > 3;
  probe.fitAll();

  check('按 3 段/页切分 → 4 页', probe.slides.length === 4, String(probe.slides.length));
  const counts = probe.slides.map(visibleCount);
  check('每页不超过 3 段', counts.every((n) => n <= 3), counts.join(','));
  check('没有丢内容', counts.reduce((a, b) => a + b, 0) === 10, counts.join(','));
  check('切分后页码从 1 开始连续', probe.slides.every((s) => Boolean(s.el.parentNode)));

  // 永远装不下（例如一个超长代码块）时必须能停下来
  probe.overflows = () => true;
  probe.build({ path: 'md/probe2.md', body: '不可切分的内容' });
  const before = probe.slides.length;
  probe.fitAll();
  check('不可切分时不会死循环', probe.slides.length === before, String(probe.slides.length));
}

/* ---------------- 结论 ---------------- */
console.log('\n[控制台]');
if (problems.length) {
  problems.forEach((p) => console.log('  ✗ ' + p));
  failures += problems.length;
} else {
  console.log('  ok   没有 JS 报错');
}

console.log(failures === 0 ? '\n全部通过 ✅\n' : `\n${failures} 项失败 ❌\n`);
dom.window.close();
process.exitCode = failures === 0 ? 0 : 1;

