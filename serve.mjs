// Dev-only static server so the built file can be exercised over http://
// (localStorage, IndexedDB and the File System Access API need a real origin).
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join, normalize } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 4173);

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
};

createServer(async (req, res) => {
  let path = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  if (path === '/') path = '/dist/Markdown Viewer.html';
  const file = normalize(join(here, path));
  if (!file.startsWith(here)) { res.writeHead(403).end('forbidden'); return; }
  try {
    const body = await readFile(file);
    const ext = file.slice(file.lastIndexOf('.')).toLowerCase();
    res.writeHead(200, { 'content-type': TYPES[ext] || 'application/octet-stream', 'cache-control': 'no-store' });
    res.end(body);
  } catch {
    res.writeHead(404).end('not found');
  }
}).listen(PORT, () => console.log(`serving markdown-viewer on http://localhost:${PORT}`));
