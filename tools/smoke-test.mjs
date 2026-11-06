/* 一次性冒烟测试：在 Node 里加载浏览器端脚本，验证 markdown 管线 */
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import vm from 'node:vm';

const require = createRequire(import.meta.url);
const root = process.cwd();

const sandbox = { window: {}, console };
const context = vm.createContext(sandbox);
sandbox.window.marked = require(path.join(root, 'assets/vendor/marked.min.js'));
sandbox.window.hljs = require(path.join(root, 'assets/vendor/highlight.min.js'));

const code = await readFile(path.join(root, 'assets/js/markdown.js'), 'utf8');
vm.runInContext(code, context, { filename: 'markdown.js' });

const MD = sandbox.window.MD;
let failures = 0;
const check = (name, condition, extra = '') => {
  if (condition) console.log(`  ok   ${name}`);
  else {
    failures += 1;
    console.log(`  FAIL ${name} ${extra}`);
  }
};

console.log('\n[render]');
const sample = `# 测试文档

正文 **加粗** 与 \`代码\`。

## 表格

| a | b |
|---|---|
| 1 | 2 |

- [x] done
- [ ] todo

\`\`\`js
const a = 1;
\`\`\`
`;
const out = MD.render(sample);
check('标题带 id', /<h1 id="测试文档">/.test(out.html), out.html.slice(0, 120));
check('标题从正文推导', out.title === '测试文档', out.title);
check('表格渲染', out.html.includes('<table>'));
check('任务列表渲染', out.html.includes('type="checkbox"'));
check('代码块渲染', out.html.includes('<code class="language-js">'));
check('字数统计', out.words > 5, String(out.words));
check('阅读时长', out.minutes >= 1, String(out.minutes));

const noHeading = MD.render('只有一段正文，没有任何标题。\n');
check('没有标题时 title 为空', noHeading.title === '', noHeading.title);
check('没有标题时正文照常渲染', noHeading.html.includes('<p>'));

// 兼容：文档开头带 YAML 块时不会被渲染成正文
const withYaml = MD.render('---\ntitle: 旧写法\n---\n\n# 正文标题\n');
check('开头 YAML 块被剥掉', !withYaml.html.includes('旧写法'), withYaml.html);
check('剥掉后标题仍取正文', withYaml.title === '正文标题', withYaml.title);

console.log('\n[splitSlides]');
const ruleDoc = `# 一

内容

---

## 二

内容
`;
const r1 = MD.splitSlides(ruleDoc);
check('按 --- 切分', r1.length === 2, JSON.stringify(r1));

const h2Doc = `# 总标题

引言

## 甲

内容甲

## 乙

内容乙
`;
const r2 = MD.splitSlides(h2Doc);
check('无分页符时按 h2 切分', r2.length === 2, JSON.stringify(r2));
check('第一段包含总标题', r2[0].startsWith('# 总标题'), r2[0]);

const fenceDoc = '# 一\n\n```\n---\n```\n\n内容\n';
check('代码块里的 --- 不分页', MD.splitSlides(fenceDoc).length === 1);

const commentDoc = '# 一\n\n<!-- slide -->\n\n# 二\n';
check('<!-- slide --> 分页', MD.splitSlides(commentDoc).length === 2);

const setext = '# 标题\n\n段落文字\n\n---\n\n后续\n';
check('段落后的 --- 分页', MD.splitSlides(setext).length === 2);

check('纯标题文档只有一页', MD.splitSlides('# 只有标题\n').length === 1);

console.log('\n[paths]');
const cases = [
  ['md/a/b.md', './img/x.png', 'md/a/img/x.png'],
  ['md/a/b.md', '../img/x.png', 'md/img/x.png'],
  ['md/a/b.md', 'c.md', 'md/a/c.md'],
  ['md/index.md', '指南/01-快速开始.md', 'md/指南/01-快速开始.md'],
  ['md/示例/x.md', '/md/root.png', 'md/root.png'],
];
for (const [doc, href, expected] of cases) {
  const info = MD.resolve(doc, href);
  check(`${doc} + ${href}`, info.path === expected, `got ${info.path}`);
}
check('外部链接', MD.resolve('md/a.md', 'https://github.com').kind === 'external');
check('锚点链接', MD.resolve('md/a.md', '#section').kind === 'anchor');
check('md 链接 kind', MD.resolve('md/a.md', 'b.md').kind === 'doc');
check(
  'encodePath 中文',
  MD.encodePath('md/指南/开始.md') === 'md/%E6%8C%87%E5%8D%97/%E5%BC%80%E5%A7%8B.md',
);

console.log(failures === 0 ? '\n全部通过 ✅\n' : `\n${failures} 个用例失败 ❌\n`);
process.exitCode = failures === 0 ? 0 : 1;
