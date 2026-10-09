/*
  mirrors.js - the fetch layer everything goes through.

  the site lives on one cdn, but the same commit is readable from a handful of
  others. a request here is tried against the page's own origin first, then
  every mirror in turn, so one cdn being blocked, rate limited or dmca'd does
  not take the arcade with it.

  the same file runs in a page and in a worker, so sw.js can importScripts() it
  and get the same list.

  requests carry a cache-buster that only changes once an hour. a cdn reads an
  unknown query parameter as "a different url", which is the point: fresh enough
  to pick up a game you just added, quiet enough not to hammer the network.
  `&raw` rides along for the mirrors that hand back a repo file unchanged.
*/
(function (scope) {
  "use strict";

  var OWNER = "tsindev";
  var REPO = "ms-games-and-stuff";
  var REF = "main";
  var SLUG = OWNER + "/" + REPO;

  // {r} is owner/repo, {ref} is the branch. probed one by one - every one of
  // these answers 200 for games.json. the last three are the "always there"
  // mirrors rather than the nice ones: they serve everything as text/plain.
  var TEMPLATES = [
    "https://cdn.jsdelivr.net/gh/{r}@{ref}/",
    "https://fastly.jsdelivr.net/gh/{r}@{ref}/",
    "https://gcore.jsdelivr.net/gh/{r}@{ref}/",
    "https://testingcf.jsdelivr.net/gh/{r}@{ref}/",
    "https://originfastly.jsdelivr.net/gh/{r}@{ref}/",
    "https://quantil.jsdelivr.net/gh/{r}@{ref}/",
    "https://cdn.statically.io/gh/{r}@{ref}/",
    "https://rawcdn.githack.com/{r}/{ref}/",
    "https://raw.githack.com/{r}/{ref}/",
    "https://raw.githubusercontent.com/{r}/{ref}/",
    "https://gh.llkk.cc/https://github.com/{r}/raw/{ref}/"
  ];

  var BASES = TEMPLATES.map(function (t) {
    return t.split("{r}").join(SLUG).split("{ref}").join(REF);
  });

  var HOUR = Math.floor(Date.now() / 3600000);

  var preferred = null; // whichever mirror answered last time
  var lastHit = null;
  var skipped = []; // mirrors that have failed, with the reason

  function bust(url) {
    return url + (url.indexOf("?") < 0 ? "?" : "&") + HOUR + "&raw";
  }

  // where "here" is, as a url. a page inside the svg entry point is an srcdoc
  // frame with no url of its own - there the injected <base> is the answer. in
  // a worker there is no document and location is the thing.
  function pageUrl() {
    try {
      var here = scope.location && scope.location.href;
      if (here && here.indexOf("about:") !== 0) return here;
    } catch (err) {}
    try {
      if (scope.document && scope.document.baseURI) return scope.document.baseURI;
    } catch (err) {}
    return "";
  }

  function absolute(path) {
    try {
      return new URL(path, pageUrl() || undefined).href;
    } catch (err) {
      return path;
    }
  }

  function stopwatch(ms) {
    try {
      return AbortSignal.timeout(ms);
    } catch (err) {}
    try {
      var c = new AbortController();
      setTimeout(function () {
        c.abort();
      }, ms);
      return c.signal;
    } catch (err) {}
    return undefined;
  }

  /*
    a missing file is not always a 404. cdns answer 200 with an error page or a
    json envelope, and a mirror that does that has to be treated as down - not
    handed to the page as if it were the game. this is the check that decides.
  */
  function looksWrong(text) {
    if (typeof text !== "string") return true;
    var body = text.trim();
    if (!body) return true;

    var head = body.slice(0, 400).toLowerCase();

    if (/^\s*(<!doctype html|<html|<head)/.test(head)) {
      var title = /<title[^>]*>([^<]*)</.exec(head);
      var h1 = /<h1[^>]*>([^<]*)</.exec(head);
      var said = (title ? title[1] : "") + " " + (h1 ? h1[1] : "");
      return /(404|403|429|not found|forbidden|blocked|unavailable|dmca|too many requests|error)/.test(said);
    }

    // a bare "404: Not Found" body, the way raw.githubusercontent says it
    if (body.length < 1000 && /^(404|403|429|not found|forbidden|blocked|unavailable)/i.test(body)) return true;

    // an error envelope when a list was expected
    if (head.charAt(0) === "{") return /"(error|errors|message|errorcode|status)"\s*:/.test(head);

    return false;
  }

  /*
    what to try, in order. the page's own origin comes first because when you
    are serving this locally that *is* the right answer, and on a cdn it is the
    mirror you got the page from anyway.
  */
  function candidates(path) {
    var seen = {};
    var list = [];

    function add(base, url) {
      if (seen[url]) return;
      seen[url] = 1;
      list.push({ base: base, url: url });
    }

    // read the list off MSG rather than closing over BASES, so a ?base= that
    // repoints the worker repoints the page too
    var live = (MSG && MSG.bases) || BASES;

    add("", absolute(path));
    // only trust the sticky mirror while it is still on the list - otherwise a
    // base that was dropped or replaced keeps getting asked for
    if (preferred && live.indexOf(preferred) !== -1) add(preferred, preferred + path);
    for (var i = 0; i < live.length; i++) add(live[i], live[i] + path);

    return list;
  }

  function note(failure) {
    for (var i = 0; i < skipped.length; i++) {
      if (skipped[i].url === failure.url) {
        skipped[i] = failure;
        return;
      }
    }
    skipped.push(failure);
  }

  async function pick(path, ms) {
    var list = candidates(path);
    var failed = [];

    for (var i = 0; i < list.length; i++) {
      var url = bust(list[i].url);
      try {
        var res = await fetch(url, {
          cache: "no-store",
          credentials: "omit",
          signal: stopwatch(ms)
        });
        if (!res.ok) {
          var bad = { url: list[i].url, why: "http " + res.status };
          failed.push(bad);
          note(bad);
          continue;
        }

        var text = await res.text();
        if (looksWrong(text)) {
          var blocked = { url: list[i].url, why: "blocked (error page back)" };
          failed.push(blocked);
          note(blocked);
          continue;
        }

        if (list[i].base) preferred = list[i].base;
        lastHit = {
          url: list[i].url,
          base: list[i].base,
          mirror: list[i].base ? list[i].base : "(this origin)",
          tried: i,
          failed: failed.slice()
        };
        return { text: text, url: list[i].url, base: list[i].base, tried: i, failed: failed.slice() };
      } catch (err) {
        var dead = { url: list[i].url, why: (err && err.name) || String(err) };
        failed.push(dead);
        note(dead);
      }
    }

    var err2 = new Error("no mirror answered for " + path + " (" + failed.length + " tried)");
    err2.failed = failed;
    throw err2;
  }

  var MSG = {
    owner: OWNER,
    repo: REPO,
    ref: REF,
    slug: SLUG,
    bases: BASES,
    hour: HOUR,
    bust: bust,
    looksWrong: looksWrong,
    candidates: candidates,

    // fetchText gives you where it came from as well as what it said: the game
    // iframe needs that url to work out its own <base>.
    fetchText: function (path, opts) {
      return pick(path, (opts && opts.timeout) || 15000);
    },

    text: async function (path, opts) {
      return (await pick(path, (opts && opts.timeout) || 15000)).text;
    },

    json: async function (path, opts) {
      return JSON.parse((await pick(path, (opts && opts.timeout) || 15000)).text);
    },

    stats: function () {
      return {
        hour: HOUR,
        mirrors: BASES.length,
        preferred: preferred,
        lastHit: lastHit,
        skipped: skipped.slice()
      };
    },

    get base() {
      return preferred || BASES[0];
    }
  };

  scope.MSG = MSG;
})(typeof self !== "undefined" ? self : typeof globalThis !== "undefined" ? globalThis : this);
