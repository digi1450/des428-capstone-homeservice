import http from 'node:http';
export function request(gateway, path, { method = 'GET', headers = {}, body = '' } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ hostname: gateway, port: 8080, path, method, headers }, res => {
      let raw = '';
      res.setEncoding('utf8');
      res.on('data', chunk => { raw += chunk; });
      res.on('end', () => {
        let data;
        try { data = JSON.parse(raw); } catch { /* nginx error HTML */ }
        resolve({ status: res.statusCode, headers: res.headers, rawHeaders: res.rawHeaders, data, raw });
      });
    });
    req.setTimeout(5000, () => req.destroy(new Error('fixture request timeout')));
    req.on('error', reject);
    req.end(body);
  });
}
export async function waitFor(check) {
  const deadline = Date.now() + 25000;
  while (Date.now() < deadline) {
    try { if (await check()) return; } catch { /* fixture/Docker DNS startup */ }
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  throw new Error('fixture readiness/recovery deadline exceeded');
}
