/*
  proxy.js - the actual proxy, loaded by sw.js off the cdn for an hourly
  cache-buster. this is the only file that has to change to change the proxy,
  which is the whole reason sw.js is a bootstrap and not the proxy itself.

  for anything inside this worker's scope it does three things:

    - repairs the content type. jsdelivr serves .html as text/plain on purpose,
      which is why the hub has to fetch a game and hand it to the iframe as
      srcdoc. behind this worker the same url comes back as text/html, so a game
      can be pointed at with src=, can open its own sub-pages, and can start its
      own workers - none of which an srcdoc document can do.
    - fails over between mirrors. if the copy in front of us 404s, drops, or
      answers with an error page, the same path is retried through the other
      cdns rather than shown to the player.
    - answers ?base= if the site wants a different set of mirrors.

  it does not cache. the list is meant to change the moment you drop a game in,
  and a cache in front of games.json is exactly how that stops happening.
*/

/* global MSG */

(function () {
  "use strict";

  var VERSION = "1";
  var HOUR = (self.MSG && self.MSG.hour) || Math.floor(Date.now() / 3600000);
  var TIMEOUT = 15000;

  // our corner of whatever origin registered us
  var ROOT = new URL("./", self.location.href).href;
  var ROOT_PATH = new URL(ROOT).pathname;
  var HERE = self.location.origin;

  var BASES = (self.MSG && self.MSG.bases) || [];

  // the cdn lies about these. everything else is passed through untouched.
  var WANTED = {
    html: "text/html; charset=utf-8",
    htm: "text/html; charset=utf-8",
    js: "text/javascript; charset=utf-8",
    mjs: "text/javascript; charset=utf-8",
    json: "application/json; charset=utf-8",
    css: "text/css; charset=utf-8",
    wasm: "application/wasm",
    svg: "image/svg+xml"
  };

  var stats = {
    version: VERSION,
    hour: HOUR,
    root: ROOT,
    mirrors: BASES.length,
    served: 0,
    retyped: 0,
    fromMirror: 0,
    failedOver: 0,
    last: null
  };

  function ext(url) {
    var m = /\.([a-z0-9]+)(?:$|[?#])/i.exec(url.pathname);
    return m ? m[1].toLowerCase() : "";
  }

  function stopwatch(ms) {
    try {
      return AbortSignal.timeout(ms);
    } catch (e) {}
    try {
      var c = new AbortController();
      setTimeout(function () {
        c.abort();
      }, ms);
      return c.signal;
    } catch (e) {}
    return undefined;
  }

  function wantedFor(url) {
    return WANTED[ext(url)] || "";
  }

  // only our own files, and never the worker's own scripts: a registration that
  // goes through its own fetch handler is a good way to never be able to update.
  function mine(url, req) {
    if (url.origin !== HERE) return false;
    if (url.pathname.indexOf(ROOT_PATH) !== 0) return false;
    if (req.destination === "serviceworker") return false;
    var name = url.pathname.slice(ROOT_PATH.length);
    if (name === "sw.js" || name === "proxy.js" || name === "mirrors.js") return false;
    // ./browser/ is the proxy tab: it has its own worker, and stepping on it
    // from here would fight the scramjet engine for the same requests
    if (name.indexOf("browser/") === 0) return false;
    return true;
  }

  async function through(url, req) {
    var attempt = [];

    // no peeking at the body here, on purpose: a game's data file can be
    // hundreds of megabytes and this has to stay a stream. a missing file is a
    // real 404 on the mirrors we use, so the status is the check.
    async function ok(url) {
      var res = await fetch(url, {
        cache: "no-store",
        credentials: "omit",
        signal: stopwatch(TIMEOUT),
        redirect: "follow"
      });
      return res.ok ? res : null;
    }

    // the copy in front of us first - it is the same cdn the page came from
    try {
      var first = await ok(url.href);
      if (first) return { res: first, url: url.href, mirrored: false };
    } catch (err) {}

    var rel = url.href.slice(ROOT.length);
    for (var i = 0; i < BASES.length; i++) {
      var alt = BASES[i] + rel;
      if (alt === url.href || attempt.indexOf(alt) !== -1) continue;
      attempt.push(alt);
      try {
        var got = await ok(alt);
        if (got) {
          stats.fromMirror++;
          stats.failedOver++;
          return { res: got, url: alt, mirrored: true };
        }
      } catch (err) {}
    }

    return { res: null, url: null, mirrored: false };
  }

  function repair(hit, url) {
    var want = wantedFor(url);
    if (!want) return hit.res;
    var have = (hit.res.headers.get("content-type") || "").toLowerCase();
    if (have.indexOf(want.split(";")[0]) === 0) return hit.res;

    var headers = new Headers(hit.res.headers);
    headers.set("content-type", want);
    stats.retyped++;
    return new Response(hit.res.body, {
      status: hit.res.status,
      statusText: hit.res.statusText,
      headers: headers
    });
  }

  self.addEventListener("install", function (event) {
    event.waitUntil(self.skipWaiting());
  });

  self.addEventListener("activate", function (event) {
    event.waitUntil(self.clients.claim());
  });

  self.addEventListener("message", function (event) {
    var data = event.data || {};
    if (data.type !== "msg:status") return;
    var reply = {
      type: "msg:status",
      version: VERSION,
      root: ROOT,
      mirrors: BASES.length,
      hour: HOUR,
      served: stats.served,
      retyped: stats.retyped,
      fromMirror: stats.fromMirror,
      last: stats.last,
      page: self.MSG ? self.MSG.stats() : null
    };
    if (event.ports && event.ports[0]) event.ports[0].postMessage(reply);
    else if (event.source) event.source.postMessage(reply);
  });

  self.addEventListener("fetch", function (event) {
    var req = event.request;
    if (req.method !== "GET") return;

    var url;
    try {
      url = new URL(req.url);
    } catch (err) {
      return;
    }
    if (!mine(url, req)) return;

    event.respondWith(
      (async function () {
        var hit = await through(url, req);
        if (!hit.res) {
          stats.last = { url: url.href, ok: false };
          return new Response("the proxy could not reach any mirror for " + url.pathname, {
            status: 503,
            headers: { "content-type": "text/plain; charset=utf-8" }
          });
        }

        stats.served++;
        stats.last = { url: url.href, ok: true, mirrored: hit.mirrored, from: hit.url };
        return repair(hit, url);
      })()
    );
  });

  if (self.MSG) {
    self.MSG.worker = "proxy";
    self.MSG.proxyReason = "ok";
  }
  console.log("[proxy] v" + VERSION + " live over " + ROOT + " with " + BASES.length + " mirror(s)");
})();
