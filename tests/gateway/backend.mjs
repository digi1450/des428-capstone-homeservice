// Test echo servers only: no business implementation or authentication guarantee.
import http from 'node:http';
const counts = new Map();
http.createServer(async (req, res) => {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const url = new URL(req.url, 'http://fixture');
  if (url.searchParams.has('count')) {
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ count: counts.get(url.pathname) || 0 }));
    return;
  }
  counts.set(url.pathname, (counts.get(url.pathname) || 0) + 1);
  if (url.searchParams.has('drop')) { req.socket.destroy(); return; }
  res.statusCode = Number(url.searchParams.get('status') || 200);
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('X-Request-Id', 'upstream-must-not-duplicate');
  res.setHeader('Set-Cookie', 'fixture=session; HttpOnly; Path=/');
  res.setHeader('Retry-After', '7');
  if (res.statusCode === 302) res.setHeader('Location', '/login?next=%2Fnotifications');
  res.end(JSON.stringify({ backend: process.env.BACKEND, method: req.method,
    url: req.url, headers: req.headers, body: Buffer.concat(chunks).toString() }));
}).listen(Number(process.env.PORT), '0.0.0.0');
