#!/usr/bin/env node
/**
 * dev-server.mjs
 * ---------------------------------------------------------------
 * 零依赖的本地静态服务器，尽量模拟 GitHub Pages 的行为：
 *   - 以仓库根目录作为站点根；
 *   - 每次请求 md-index.json 时现场扫描 md/，结果直接返回给浏览器，
 *     不在磁盘上写任何构建产物（跑起来不需要构建，仓库里也不留文件）；
 *   - 监听 md/ 的变化并重建索引。
 *
 * 用法：node tools/dev-server.mjs [--port 5173] [--host 127.0.0.1]
 */

import { createServer } from 'node:http';
import { createReadStream, watch } from 'node:fs';
import { stat, readFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import { buildIndex } from './build-index.mjs';

const SITE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const args = process.argv.slice(2);
const readFlag = (name, fallback) => {
  const idx = args.indexOf(`--${name}`);
  return idx !== -1 && args[idx + 1] ? args[idx + 1] : fallback;
};
const PORT = Number(readFlag('port', process.env.PORT || 5173));
const HOST = readFlag('host', '127.0.0.1');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.markdown': 'text/markdown; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.pdf': 'application/pdf',
  '.yml': 'text/yaml; charset=utf-8',
  '.yaml': 'text/yaml; charset=utf-8',
};

let building = null;

/** 重建索引（同一个时刻只跑一次） */
function rebuild(options = {}) {
  if (building) return building;
  building = buildIndex({ root: SITE_ROOT, quiet: true, write: false })
    .catch((error) => {
      console.error('[dev] 索引重建失败：', error.message);
      return null;
    })
    .finally(() => {
      building = null;
    });
  return building;
}

function send(res, status, body, headers = {}) {
  res.writeHead(status, { 'Cache-Control': 'no-store', ...headers });
  res.end(body);
}

const server = createServer(async (req, res) => {
  let pathname;
  try {
    pathname = decodeURIComponent(
      new URL(req.url, `http://${req.headers.host || 'localhost'}`).pathname,
    );
  } catch {
    return send(res, 400, 'Bad Request', { 'Content-Type': 'text/plain; charset=utf-8' });
  }

  if (pathname === '/') pathname = '/index.html';

  // 目录清单：每次请求实时生成，直接返回给浏览器，不写任何文件到磁盘
  if (pathname === '/md-index.json') {
    const manifest = await rebuild();
    if (!manifest) {
      return send(res, 500, '{"error":"index build failed"}', {
        'Content-Type': MIME['.json'],
      });
    }
    return send(res, 200, JSON.stringify(manifest, null, 2), {
      'Content-Type': MIME['.json'],
    });
  }

  const target = path.resolve(SITE_ROOT, '.' + pathname.replace(/\\/g, '/'));
  if (target !== SITE_ROOT && !target.startsWith(SITE_ROOT + path.sep)) {
    return send(res, 403, 'Forbidden', { 'Content-Type': 'text/plain; charset=utf-8' });
  }

  let info;
  try {
    info = await stat(target);
  } catch {
    return send(res, 404, `404 Not Found: ${pathname}`, {
      'Content-Type': 'text/plain; charset=utf-8',
    });
  }

  if (info.isDirectory()) {
    if (!pathname.endsWith('/')) {
      res.writeHead(301, { Location: encodeURI(pathname) + '/' });
      return res.end();
    }
    try {
      const html = await readFile(path.join(target, 'index.html'));
      return send(res, 200, html, { 'Content-Type': MIME['.html'] });
    } catch {
      return send(res, 404, 'Not Found', { 'Content-Type': 'text/plain; charset=utf-8' });
    }
  }

  const type = MIME[path.extname(target).toLowerCase()] || 'application/octet-stream';
  res.writeHead(200, {
    'Content-Type': type,
    'Content-Length': info.size,
    'Cache-Control': 'no-store',
  });
  createReadStream(target).pipe(res);
});

await rebuild({});

try {
  let timer = null;
  watch(path.join(SITE_ROOT, 'md'), { recursive: true }, () => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      console.log('[dev] md/ 有变化，已重建目录索引');
      rebuild();
    }, 150);
  });
} catch {
  console.warn('[dev] 无法监听 md/ 目录变化，索引将在每次请求时重建。');
}

server.on('error', (error) => {
  if (error.code === 'EADDRINUSE') {
    console.error(`[dev] 端口 ${PORT} 已被占用，试试 --port 5174`);
  } else {
    console.error('[dev] 服务启动失败：', error);
  }
  process.exitCode = 1;
});

server.listen(PORT, HOST, () => {
  console.log(`\n  本地预览已启动：http://${HOST}:${PORT}/`);
  console.log(`  站点根目录：${SITE_ROOT}`);
  console.log('  按 Ctrl+C 退出\n');
});
