# vendor/

这里放的是站点运行时需要的第三方脚本，**已经下载到仓库里**，页面不依赖任何 CDN。
这样可以离线预览，也避免 CDN 被墙 / 挂掉导致站点打不开。

| 文件 | 项目 | 版本 | 许可 |
| --- | --- | --- | --- |
| `marked.min.js` | [marked](https://github.com/markedjs/marked) | 15.0.7 | MIT |
| `highlight.min.js` | [highlight.js](https://github.com/highlightjs/highlight.js)（common 语言包） | 11.11.1 | BSD-3-Clause |

升级方式（需要联网）：

```bash
curl -o assets/vendor/marked.min.js \
  https://cdn.jsdelivr.net/npm/marked@15.0.7/marked.min.js
curl -o assets/vendor/highlight.min.js \
  https://cdn.jsdelivr.net/npm/@highlightjs/cdn-assets@11.11.1/highlight.min.js
```

代码高亮的配色没有使用 highlight.js 自带的主题 CSS，
而是在 `assets/css/site.css` 里用 CSS 变量自定义，以便同时适配深色 / 浅色主题。
