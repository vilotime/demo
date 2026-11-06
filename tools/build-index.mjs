#!/usr/bin/env node
/**
 * build-index.mjs
 * ---------------------------------------------------------------
 * 扫描仓库根目录下的 md/ 文件夹（支持任意层级嵌套），生成站点使用的目录清单。
 *
 * 之所以需要这一步：GitHub Pages 是纯静态托管，浏览器无法在运行时
 * 列出某个目录下有哪些文件，所以目录树必须扫描成一份索引。
 *
 * 这个文件不是给你手动跑的——
 *   - 部署时：GitHub Actions 调用它生成 md-index.json 打进产物；
 *   - 本地预览时：dev-server 直接调用它，结果只留在内存里，不写磁盘。
 * 所以仓库里不会出现任何构建产物。
 *
 * 用法（一般不需要）：
 *   node tools/build-index.mjs            # 扫描当前目录下的 md/
 *   node tools/build-index.mjs <root>     # 指定站点根目录
 *
 * 索引结构：
 *   {
 *     version: 1,
 *     generatedAt: "2024-01-01T00:00:00.000Z",
 *     root: "md",
 *     stats: { files, dirs, words },
 *     tree: [ DirNode | FileNode ]
 *   }
 *   DirNode  = { type: "dir",  name, path, children: [...] }
 *   FileNode = { type: "file", name, path, title, words, headings }
 */

import { readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const MD_FOLDER = 'md';
const MANIFEST_NAME = 'md-index.json';

const MARKDOWN_EXT = new Set(['.md', '.markdown']);
const IGNORED_DIRS = new Set([
  'node_modules',
  '.git',
  '.github',
  '.obsidian',
  '.vscode',
  '.idea',
  '.trash',
]);

/** 中文优先的“自然排序”：数字按数值比较（第2章 < 第10章） */
const collator = (() => {
  for (const locale of ['zh-Hans-CN-u-co-pinyin', 'zh-Hans-CN', 'en']) {
    try {
      return new Intl.Collator(locale, { numeric: true, sensitivity: 'base' });
    } catch {
      /* try next */
    }
  }
  return new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });
})();

const toPosix = (p) => p.split(path.sep).join('/');
const stripBom = (s) => (s.charCodeAt(0) === 0xfeff ? s.slice(1) : s);

/* ------------------------------------------------------------------ */
/* Markdown 元信息提取                                                 */
/* ------------------------------------------------------------------ */

/**
 * 兼容处理：文档开头若带了 YAML 块（被 --- 包起来）就剥掉，
 * 免得它被当成正文统计。站点不需要这种写法，标题一律取自正文。
 */
function stripFrontmatter(source) {
  const match = /^---[ \t]*\r?\n[\s\S]*?\r?\n---[ \t]*(?:\r?\n|$)/.exec(source);
  return match ? source.slice(match[0].length) : source;
}

/** 去掉行内 markdown 标记，得到适合展示的纯文本标题 */
function plainInline(text) {
  return text
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1') // 图片
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1') // 链接
    .replace(/`([^`]*)`/g, '$1') // 行内代码
    .replace(/(\*\*|__)(.*?)\1/g, '$2') // 粗体
    .replace(/(\*|_)(.*?)\1/g, '$2') // 斜体
    .replace(/~~(.*?)~~/g, '$1') // 删除线
    .replace(/<[^>]+>/g, '') // 内联 HTML
    .replace(/&nbsp;/g, ' ')
    .replace(/\\([\\`*_{}[\]()#+\-.!])/g, '$1')
    .replace(/\s+/g, ' ')
    .trim();
}

/** 跳过代码块，收集 ATX 标题 */
function collectHeadings(body) {
  const headings = [];
  let inFence = false;
  let fenceMarker = '';
  for (const line of body.split(/\r?\n/)) {
    const fence = /^\s{0,3}(`{3,}|~{3,})/.exec(line);
    if (fence) {
      if (!inFence) {
        inFence = true;
        fenceMarker = fence[1][0];
      } else if (fence[1][0] === fenceMarker) {
        inFence = false;
      }
      continue;
    }
    if (inFence) continue;
    const heading = /^\s{0,3}(#{1,6})\s+(.*?)\s*#*\s*$/.exec(line);
    if (heading) {
      const text = plainInline(heading[2]);
      if (text) headings.push({ level: heading[1].length, text });
    }
  }
  return headings;
}

/** 粗略统计字数：CJK 按字计，其它按词计 */
function countWords(body) {
  const withoutCode = body.replace(/```[\s\S]*?```/g, ' ');
  const cjk = withoutCode.match(/[\u3400-\u4dbf\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7af]/g);
  const latin = withoutCode
    .replace(/[\u3400-\u4dbf\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7af]/g, ' ')
    .match(/[A-Za-z0-9][A-Za-z0-9'’\-]*/g);
  return (cjk ? cjk.length : 0) + (latin ? latin.length : 0);
}

/** 读取一个 md 文件并提取索引所需信息 */
async function describeFile(absPath, relPath) {
  let source = '';
  try {
    source = stripBom(await readFile(absPath, 'utf8'));
  } catch (error) {
    console.warn(`[build-index] 无法读取 ${relPath}: ${error.message}`);
    return null;
  }

  const body = stripFrontmatter(source);
  const headings = collectHeadings(body);

  const fileName = path.basename(relPath);
  const fallbackTitle = fileName.replace(/\.(md|markdown)$/i, '');
  // 目录里显示的名字：正文第一个一级标题，没有就用文件名
  const h1 = headings.find((h) => h.level === 1);
  const title = (h1 && h1.text) || fallbackTitle;

  return {
    type: 'file',
    name: fileName,
    path: relPath,
    title,
    words: countWords(body),
    headings: headings.slice(0, 40),
  };
}

/* ------------------------------------------------------------------ */
/* 目录遍历                                                            */
/* ------------------------------------------------------------------ */

async function walk(absDir, relDir) {
  let entries;
  try {
    entries = await readdir(absDir, { withFileTypes: true });
  } catch (error) {
    console.warn(`[build-index] 无法读取目录 ${relDir}: ${error.message}`);
    return [];
  }

  const dirs = [];
  const files = [];

  for (const entry of entries) {
    const name = entry.name;
    if (name.startsWith('.')) continue;

    const absPath = path.join(absDir, name);
    const relPath = toPosix(path.join(relDir, name));

    if (entry.isDirectory()) {
      if (IGNORED_DIRS.has(name)) continue;
      dirs.push({ name, absPath, relPath });
    } else if (entry.isFile()) {
      const ext = path.extname(name).toLowerCase();
      if (!MARKDOWN_EXT.has(ext)) continue;
      files.push({ name, absPath, relPath });
    }
  }

  dirs.sort((a, b) => collator.compare(a.name, b.name));
  files.sort((a, b) => collator.compare(a.name, b.name));

  const tree = [];

  for (const dir of dirs) {
    const children = await walk(dir.absPath, dir.relPath);
    // 目录里（含子孙目录）没有任何 markdown 文件时，不显示该目录
    if (children.length === 0) continue;
    tree.push({ type: 'dir', name: dir.name, path: dir.relPath, children });
  }

  for (const file of files) {
    const node = await describeFile(file.absPath, file.relPath);
    if (node) tree.push(node);
  }

  return tree;
}

/* ------------------------------------------------------------------ */

function countNode(nodes) {
  let files = 0;
  let dirs = 0;
  let words = 0;
  for (const node of nodes) {
    if (node.type === 'dir') {
      dirs += 1;
      const inner = countNode(node.children);
      files += inner.files;
      dirs += inner.dirs;
      words += inner.words;
    } else {
      files += 1;
      words += node.words;
    }
  }
  return { files, dirs, words };
}

async function main(options = {}) {
  const siteRoot = path.resolve(options.root || process.argv[2] || process.cwd());
  const mdAbs = path.join(siteRoot, MD_FOLDER);
  const outFile = path.join(siteRoot, MANIFEST_NAME);

  const tree = await walk(mdAbs, MD_FOLDER);
  const stats = countNode(tree);

  if (stats.files === 0) {
    console.warn(`[build-index] 警告：在 ${mdAbs} 下没有找到任何 .md 文件。`);
  }

  const manifest = {
    version: 1,
    generatedAt: new Date().toISOString(),
    root: MD_FOLDER,
    stats,
    tree,
  };

  // write: false 时不落盘，只把结果返回给调用方（本地预览用，仓库里不留产物）
  if (options.write !== false) {
    await writeFile(outFile, JSON.stringify(manifest, null, 2) + '\n', 'utf8');
    if (!options.quiet) {
      console.log(
        `[build-index] 已生成 ${toPosix(path.relative(process.cwd(), outFile))}：` +
          `${stats.files} 个文件 / ${stats.dirs} 个目录 / 约 ${stats.words} 字`,
      );
    }
  }

  return manifest;
}

/* 既可以直接 `node tools/build-index.mjs` 运行，也可以被 dev-server 直接 import 复用 */
export { walk, countNode, main as buildIndex };

const isEntry =
  process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isEntry) {
  main().catch((error) => {
    console.error('[build-index] 构建失败：', error);
    process.exitCode = 1;
  });
}

