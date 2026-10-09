/*
  browser/sw.js - the service worker behind "m's proxy".

  it is registered at ./browser/, so its scope is the proxy and nothing else -
  the hub's own worker (../sw.js, the cdn failover one) is left alone.

  the rewriting engine is scramjet (the "jet" build) and the transport is
  libcurl.js over WISP. both are megabytes, so they are loaded from a cdn into
  this worker instead of being vendored here.

  the worker itself is thin on purpose. jet/jet.sw.js is the whole engine: it
  forwards any request whose path starts with the prefix the page registered and
  hands the reply back. everything below that is resilience - finding a mirror
  for the engine, and answering with something usable instead of a 404 when a
  navigation arrives before the page has had a chance to register.
*/

var ENGINE = "TongSherbet/storage";

// the engine is a third-party build, so it is fetched through the same trick as
// everything else: one repo, many cdn edges, first one that answers wins.
var TEMPLATES = [
  "https://cdn.jsdelivr.net/gh/{r}@main/",
  "https://fastly.jsdelivr.net/gh/{r}@main/",
  "https://gcore.jsdelivr.net/gh/{r}@main/",
  "https://testingcf.jsdelivr.net/gh/{r}@main/",
  "https://originfastly.jsdelivr.net/gh/{r}@main/",
  "https://quantil.jsdelivr.net/gh/{r}@main/",
  "https://rawcdn.githack.com/{r}/main/",
  "https://raw.githack.com/{r}/main/"
];

var HOUR = Math.floor(Date.now() / 3600000);
var PREFIX = new URL("./~/", self.location.href).pathname; // "/browser/~/"

var engineBase = null;
for (var i = 0; i < TEMPLATES.length && !engineBase; i++) {
  var base = TEMPLATES[i].split("{r}").join(ENGINE);
  try {
    importScripts(base + "jet/jet.sw.js?" + HOUR + "&raw");
    engineBase = base;
  } catch (err) {
    console.warn("[m's proxy] engine mirror down:", base, err && err.message);
  }
}

if (engineBase) {
  console.log("[m's proxy] engine loaded from", engineBase);
} else {
  // with no engine there is nothing to route with, but it still installs so the
  // page can see a controller, find out why, and retry
  console.error("[m's proxy] no engine mirror answered - installing as a no-op worker");
}

/*
  these are registered here rather than left to the engine on purpose. relying
  on it meant a new worker sat in "waiting" while the old one kept serving, so a
  fixed worker never actually took over - which is a miserable way to debug.
*/
self.addEventListener("install", function (event) {
  event.waitUntil(self.skipWaiting());
});

self.addEventListener("activate", function (event) {
  event.waitUntil(self.clients.claim());
});

// a page controlled by a worker that is already waiting can ask it to step in
self.addEventListener("message", function (event) {
  if (event.data && event.data.type === "SKIP_WAITING") self.skipWaiting();
});

function holding(message) {
  return new Response(
    '<!doctype html><meta charset="utf-8"><meta http-equiv="refresh" content="1">' +
      '<body style="margin:0;height:100vh;display:grid;place-items:center;background:#050507;' +
      'color:#8b8b99;font:14px \'Comic Sans MS\',\'Comic Sans\',cursive">' +
      message +
      "</body>",
    {
      status: 503,
      headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" }
    }
  );
}

self.addEventListener("fetch", function (event) {
  var url;
  try {
    url = new URL(event.request.url);
  } catch (err) {
    return;
  }
  if (url.origin !== self.location.origin) return;

  // the page uses these to tell "the worker is up and answering" from "the
  // worker is up but its engine never loaded" - which otherwise look identical
  // from the outside, and the second one hangs the controller forever
  if (url.pathname.slice(-11) === "/__sw_alive") {
    event.respondWith(
      new Response(engineBase ? "true" : "no-engine", {
        headers: { "content-type": "text/plain", "cache-control": "no-store" }
      })
    );
    return;
  }

  if (url.pathname.slice(-13) === "/__proxy_info") {
    event.respondWith(
      new Response(
        JSON.stringify(
          {
            engine: !!self.$jetController,
            engineBase: engineBase,
            hour: HOUR,
            prefix: PREFIX,
            hasRoute: !!(self.$jetController && self.$jetController.route),
            hasShouldRoute: !!(self.$jetController && self.$jetController.shouldRoute)
          },
          null,
          2
        ),
        { headers: { "content-type": "application/json", "cache-control": "no-store" } }
      )
    );
    return;
  }

  if (self.$jetController && self.$jetController.shouldRoute(event)) {
    event.respondWith(self.$jetController.route(event));
    return;
  }

  // a navigation landed on the proxy before the page registered its prefix.
  // nudge every page to re-register its port, then ask the browser to come back.
  if (url.pathname.indexOf(PREFIX) === 0) {
    event.respondWith(
      (async function () {
        var pages = await self.clients.matchAll({ includeUncontrolled: true, type: "window" });
        for (var i = 0; i < pages.length; i++) pages[i].postMessage({ $controller$swrevive: {} });
        return holding("waking m's proxy up…");
      })()
    );
  }
});
