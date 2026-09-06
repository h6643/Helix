// Echo server v2: capture codex request bodies to /v1/responses, file per request.
const http = require('http');
const fs = require('fs');
let n = 0;
http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    const file = 'D:/tmp/cap/req-' + (++n) + '.json';
    fs.mkdirSync('D:/tmp/cap', { recursive: true });
    try { fs.writeFileSync(file, body); console.log('captured', req.url, body.length, '->', file); } catch (e) { console.log('write failed', e.message); }
    res.writeHead(500, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: { message: 'probe', type: 'server_error' } }));
  });
}).listen(17321, '127.0.0.1', () => console.log('listening 17321'));
