/* 查看某篇文档会被切成哪些幻灯片（调试用）：node tools/inspect-slides.mjs <md 路径> */
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import vm from 'node:vm';

const require = createRequire(import.meta.url);
const root = process.cwd();
const target = process.argv[2] || 'md/示例/01-演示模式示例.md';

const sandbox = { window: {}, console };
const context = vm.createContext(sandbox);
sandbox.window.marked = require(path.join(root, 'assets/vendor/marked.min.js'));
sandbox.window.hljs = require(path.join(root, 'assets/vendor/highlight.min.js'));
vm.runInContext(await readFile(path.join(root, 'assets/js/markdown.js'), 'utf8'), context);

const MD = sandbox.window.MD;
const source = await readFile(path.join(root, target), 'utf8');
const rendered = MD.render(source);
const chunks = MD.splitSlides(rendered.body);

const countBlocks = (html) =>
  html.split(/<(?:h[1-6]|p|ul|ol|pre|table|blockquote|div)[\s>]/).length - 1;

console.log(`\n${target}`);
console.log(`标题（取自正文一级标题）：${rendered.title || '（无）'}`);
console.log(`共 ${chunks.length} 页\n`);

chunks.forEach((chunk, index) => {
  const lines = chunk.split('\n').filter((line) => line.trim());
  const title = lines[0].replace(/^#+\s*/, '');
  console.log(`${String(index + 1).padStart(2)}. ${title}`);
  console.log(`    首行: ${lines[0].slice(0, 70)}`);
  console.log(`    块数: ${countBlocks(MD.render(chunk).html)}`);
});

