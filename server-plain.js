const http = require('http'); const fs = require('fs'); const path = require('path');

const PORT = process.env.PORT || 3000; const publicDir = path.join(__dirname, 'public');

function sendFile(res, filePath) { const ext = path.extname(filePath).toLowerCase(); const types = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml', '.ico': 'image/x-icon' }; const contentType = types[ext] || 'application/octet-stream';

fs.readFile(filePath, function (err, data) { if (err) { res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }); res.end('404 Not Found'); return; } res.writeHead(200, { 'Content-Type': contentType }); res.end(data); }); }

const server = http.createServer(function (req, res) { let urlPath = req.url.split('?')[0];

if (urlPath === '/') urlPath = '/index.html'; if (urlPath === '/tv') urlPath = '/tv.html'; if (urlPath === '/join') urlPath = '/join.html';

const filePath = path.join(publicDir, urlPath);

fs.stat(filePath, function (err, stats) { if (err || !stats.isFile()) { res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }); res.end('404 Not Found'); return; } sendFile(res, filePath); }); });

server.listen(PORT, '0.0.0.0', function () { console.log("Serveur minimal demarre sur http://localhost:" + PORT); });