/**
 * audit.mjs — 没有浏览器时的静态体检
 * ---------------------------------------------------------------
 * 1. 用 css-tree 严格解析 site.css，报告语法错误；
 * 2. 检查 CSS 里用到但没有定义的变量；
 * 3. 检查 JS 里 $('#id') / qs('#id') 引用的元素是否都在 index.html 里；
 * 4. 检查 index.html 里的 id 是否重复。
 *
 * 运行：node tools/audit.mjs
 */
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import * as csstree from 'css-tree';

const root = process.cwd();
const problems = [];
const notes = [];

const css = await readFile(path.join(root, 'assets/css/site.css'), 'utf8');
const html = await readFile(path.join(root, 'index.html'), 'utf8');
const jsFiles = ['assets/js/app.js', 'assets/js/presenter.js', 'assets/js/markdown.js'];
const js = (
  await Promise.all(jsFiles.map((file) => readFile(path.join(root, file), 'utf8')))
).join('\n');

/* ---------------- 1. CSS 语法 ---------------- */
let ast = null;
try {
  ast = csstree.parse(css, {
    positions: true,
    onParseError(error) {
      const line = error.line ? `:${error.line}:${error.column}` : '';
      problems.push(`CSS 语法错误${line} ${error.message}`);
    },
  });
  console.log(`[css] 解析通过，共 ${ast.children.size} 条顶层规则`);
} catch (error) {
  problems.push('CSS 无法解析：' + error.message);
}

/* ---------------- 2. CSS 变量 ---------------- */
if (ast) {
  const defined = new Set();
  const used = new Map();

  csstree.walk(ast, {
    visit: 'Declaration',
    enter(node) {
      if (node.property.startsWith('--')) defined.add(node.property);
    },
  });

  csstree.walk(ast, {
    visit: 'Function',
    enter(node) {
      if (node.name !== 'var') return;
      const first = node.children.first;
      if (first && first.type === 'Identifier') {
        const count = used.get(first.name) || 0;
        used.set(first.name, count + 1);
      }
    },
  });

  const fallbackOnly = new Set(['--slide-scale']);
  for (const [name, count] of used) {
    if (!defined.has(name) && !fallbackOnly.has(name)) {
      problems.push(`CSS 变量未定义：${name}（被引用 ${count} 次）`);
    }
  }
  console.log(`[css] 变量定义 ${defined.size} 个，引用 ${used.size} 个`);
}

/* ---------------- 3. JS 引用的 id ---------------- */
const htmlIds = new Set();
for (const match of html.matchAll(/\sid="([^"]+)"/g)) {
  if (htmlIds.has(match[1])) problems.push(`HTML 中 id 重复：${match[1]}`);
  htmlIds.add(match[1]);
}

const referenced = new Set();
for (const match of js.matchAll(/\$\(\s*['"]#([A-Za-z0-9_-]+)['"]/g)) referenced.add(match[1]);
for (const match of js.matchAll(/getElementById\(\s*['"]([A-Za-z0-9_-]+)['"]/g)) referenced.add(match[1]);
for (const match of js.matchAll(/qs\(\s*['"]#([A-Za-z0-9_-]+)['"]/g)) referenced.add(match[1]);

for (const id of referenced) {
  if (!htmlIds.has(id)) problems.push(`JS 引用了不存在的 id：#${id}`);
}
console.log(`[dom] HTML 共有 ${htmlIds.size} 个 id，JS 引用 ${referenced.size} 个`);

/* ---------------- 4. 类名抽样检查 ---------------- */
const classUse = new Set();
for (const match of js.matchAll(/(?:querySelector(?:All)?|classList\.(?:add|remove|toggle|contains)|closest)\(\s*['"]([^'"]+)['"]/g)) {
  for (const token of match[1].split(/[\s,>]+/)) {
    const cls = /^\.([A-Za-z0-9_-]+)$/.exec(token);
    if (cls) classUse.add(cls[1]);
  }
}

const cssClassNames = new Set();
if (ast) {
  csstree.walk(ast, {
    visit: 'ClassSelector',
    enter(node) {
      cssClassNames.add(node.name);
    },
  });
}

// JS 里动态生成的类名可能没有样式（仅提示，不算错误）
const unstyled = [...classUse].filter(
  (name) =>
    !cssClassNames.has(name) &&
    !['is-hidden', 'is-filtering', 'is-open', 'is-active', 'is-empty'].includes(name),
);
if (unstyled.length) notes.push('这些类名在 CSS 里没有对应样式（可能是纯标记类）：' + unstyled.join(', '));

/* ---------------- 5. 文件是否存在 ---------------- */
const referencedFiles = new Set();
for (const match of html.matchAll(/(?:src|href)="(assets\/[^"]+)"/g)) referencedFiles.add(match[1]);
for (const file of referencedFiles) {
  try {
    await readFile(path.join(root, file));
  } catch {
    problems.push(`index.html 引用的资源不存在：${file}`);
  }
}
console.log(`[assets] index.html 引用了 ${referencedFiles.size} 个本地资源`);

/* ---------------- 输出 ---------------- */
console.log('');
for (const note of notes) console.log('提示：' + note);
if (problems.length) {
  problems.forEach((p) => console.log('✗ ' + p));
  console.log(`\n发现 ${problems.length} 个问题 ❌\n`);
  process.exitCode = 1;
} else {
  console.log('静态体检通过 ✅\n');
}
