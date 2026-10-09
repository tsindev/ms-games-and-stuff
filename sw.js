/*
  sw.js - the worker the hub registers.

  it is deliberately small. the part that actually does the work, proxy.js,
  lives on the cdn, and this pulls the current copy of it in with importScripts()
  and an hourly cache-buster. fixing the proxy therefore does not need every
  open tab to re-register anything: the next load picks up the new build.

  every mirror is tried in order, so one dead cdn does not take the worker - and
  with it the site - down. and if they all fail, this still installs as a
  do-nothing worker: mirrors.js has already been doing the fetching, so the
  arcade keeps working and the worker simply retries next time.

  to point the proxy at a different copy of itself:

    navigator.serviceWorker.register(
      "sw.js?base=" + encodeURIComponent("https://example.com/gh/me/ms-games-and-stuff@main/"),
      { updateViaCache: "none" }
    )

  relative importScripts() resolves against this script's own url, so mirrors.js
  is read from wherever this worker was registered from.
*/

/* global MSG */

var FALLBACK_BASES = [
  "https://cdn.jsdelivr.net/gh/tsindev/ms-games-and-stuff@main/",
  "https://fastly.jsdelivr.net/gh/tsindev/ms-games-and-stuff@main/",
  "https://gcore.jsdelivr.net/gh/tsindev/ms-games-and-stuff@main/",
  "https://raw.githubusercontent.com/tsindev/ms-games-and-stuff/main/"
];

var HOUR = Math.floor(Date.now() / 3600000);

// mirrors.js owns the list. this is only here for the case where importing it
// fails, which would otherwise leave the worker with nowhere to look.
try {
  importScripts("mirrors.js");
} catch (err) {
  console.warn("[proxy] could not import mirrors.js, using the built-in list:", err && err.message);
}

var bases = (self.MSG && self.MSG.bases) || FALLBACK_BASES;

// ?base= lets a page repoint the worker at another copy without editing it.
try {
  var asked = new URL(self.location.href).searchParams.get("base");
  if (asked) {
    var url = new URL(decodeURIComponent(asked));
    if (url.protocol === "https:") {
      var base = url.href.slice(-1) === "/" ? url.href : url.href + "/";
      bases = [base].concat(
        bases.filter(function (b) {
          return b !== base;
        })
      );
      if (self.MSG) self.MSG.bases = bases;
      console.log("[proxy] repointed at", base);
    }
  }
} catch (err) {
  console.warn("[proxy] ignoring a bad ?base=:", err && err.message);
}

var proxyBase = null;

for (var i = 0; i < bases.length && !proxyBase; i++) {
  try {
    importScripts(bases[i] + "proxy.js?" + HOUR + "&raw");
    proxyBase = bases[i];
  } catch (err) {
    console.warn("[proxy] mirror down for proxy.js:", bases[i], err && err.message);
  }
}

if (proxyBase) {
  if (self.MSG) {
    self.MSG.proxyBase = proxyBase;
    self.MSG.worker = "bootstrap";
  }
  console.log("[proxy] running proxy.js from", proxyBase);
} else {
  console.error("[proxy] every mirror failed for proxy.js - installing as a no-op worker");
  self.addEventListener("install", function (event) {
    event.waitUntil(self.skipWaiting());
  });
}
