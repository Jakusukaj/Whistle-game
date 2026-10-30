"use strict";
// Web server: serves the phone screens from /public and runs the game over a
// WebSocket at /ws. All game rules live in game.js.

var http = require("http");
var fs = require("fs");
var path = require("path");
var WebSocketServer = require("ws").WebSocketServer;
var RoomManager = require("./game.js").RoomManager;

var PUBLIC_DIR = path.join(__dirname, "public");
var TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".json": "application/json; charset=utf-8",
  ".webmanifest": "application/manifest+json"
};

function createServer(options) {
  var manager = new RoomManager(options);

  var server = http.createServer(function (req, res) {
    var urlPath = decodeURIComponent((req.url || "/").split("?")[0]);
    if (urlPath === "/healthz") {
      res.writeHead(200, { "Content-Type": "text/plain" });
      return res.end("ok");
    }
    if (urlPath === "/stats") {
      var q = (req.url.split("?")[1] || "").match(/(?:^|&)key=([^&]*)/), key = q ? decodeURIComponent(q[1]) : "";
      if (key.trim().toLowerCase() !== String(manager.opts.adminPassword).toLowerCase()) { res.writeHead(401, { "Content-Type": "text/plain" }); return res.end("Nope"); }
      res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" });
      return res.end(JSON.stringify(require("./analytics.js").summary(), null, 2));
    }
    if (urlPath === "/") { urlPath = "/index.html"; }
    var file = path.normalize(path.join(PUBLIC_DIR, urlPath));
    if (file.indexOf(PUBLIC_DIR) !== 0) {
      res.writeHead(403); return res.end("Forbidden");
    }
    fs.readFile(file, function (e, data) {
      if (e) { res.writeHead(404, { "Content-Type": "text/plain" }); return res.end("Not found"); }
      res.writeHead(200, {
        "Content-Type": TYPES[path.extname(file)] || "application/octet-stream",
        "Cache-Control": "no-cache"
      });
      res.end(data);
    });
  });

  var wss = new WebSocketServer({ server: server, path: "/ws", maxPayload: 4096 });

  wss.on("connection", function (ws) {
    var conn = {
      roomCode: null,
      playerId: null,
      send: function (obj) {
        if (ws.readyState === 1) { ws.send(JSON.stringify(obj)); }
      }
    };
    ws.isAlive = true;
    ws.on("pong", function () { ws.isAlive = true; });
    ws.on("message", function (data) {
      var msg;
      try { msg = JSON.parse(data.toString()); } catch (e) { return; }
      try { manager.handle(conn, msg); }
      catch (e) { console.error("handler error", e); conn.send({ t: "error", code: "server", message: "Something went wrong." }); }
    });
    ws.on("close", function () { manager.disconnect(conn); });
    ws.on("error", function () { /* close handler cleans up */ });
  });

  // Keep connections alive through hosting proxies, drop dead ones.
  var beat = setInterval(function () {
    wss.clients.forEach(function (ws) {
      if (!ws.isAlive) { return ws.terminate(); }
      ws.isAlive = false;
      try { ws.ping(); } catch (e) {}
    });
  }, 25000);
  var sweeper = setInterval(function () { manager.sweep(); }, 60000);
  beat.unref(); sweeper.unref();

  server.on("close", function () { clearInterval(beat); clearInterval(sweeper); });
  return { server: server, manager: manager, wss: wss };
}

module.exports = { createServer: createServer };

if (require.main === module) {
  var port = parseInt(process.env.PORT, 10) || 3000;
  createServer().server.listen(port, function () {
    console.log("Whistle is running on port " + port);
  });
}
