/**
 * A tiny local reverse proxy for a hosted-mode development run:  npm run dev:proxy
 * Hosted mode needs X-Forwarded-For from a proxy you control (MERGEPORT_TRUST_PROXY=true). This listens on 127.0.0.1:3100 (DEV_PROXY_PORT),
 * forwards to `next dev` on 127.0.0.1:3101 (DEV_PROXY_TARGET_PORT) with the Host header unchanged, and appends the client address to
 * X-Forwarded-For (replacing anything the client sent, as a proxy facing the internet would). Websockets (hot reload) are piped through.
 * Development only: see docs/dev-github-fake.md.
 */
import http from "node:http";
import net from "node:net";

const listen = Number(process.env.DEV_PROXY_PORT ?? 3100);
const target = Number(process.env.DEV_PROXY_TARGET_PORT ?? 3101);
const client = (s: net.Socket) => (s.remoteAddress ?? "127.0.0.1").replace(/^::ffff:/, "");

const server = http.createServer((req, res) => {
  const up = http.request({ host: "127.0.0.1", port: target, method: req.method, path: req.url, headers: { ...req.headers, "x-forwarded-for": client(req.socket) } }, (r) => {
    res.writeHead(r.statusCode ?? 502, r.headers);
    r.pipe(res);
  });
  up.on("error", () => {
    if (!res.headersSent) res.writeHead(502, { "content-type": "text/plain" });
    res.end(`Nothing is listening on 127.0.0.1:${target}: start next dev first.`);
  });
  req.pipe(up);
});
server.on("upgrade", (req, socket, head) => {
  const up = net.connect(target, "127.0.0.1", () => {
    const lines = Object.entries({ ...req.headers, "x-forwarded-for": client(req.socket) }).map(([k, v]) => `${k}: ${v}`);
    up.write(`${req.method} ${req.url} HTTP/1.1\r\n${lines.join("\r\n")}\r\n\r\n`);
    if (head.length) up.write(head);
    socket.pipe(up).pipe(socket);
  });
  up.on("error", () => socket.destroy());
  socket.on("error", () => up.destroy());
});
server.listen(listen, "127.0.0.1", () => console.log(`Dev proxy http://127.0.0.1:${listen} -> http://127.0.0.1:${target} (adds X-Forwarded-For). Ctrl+C stops it.`));
const stop = () => server.close(() => process.exit(0));
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
