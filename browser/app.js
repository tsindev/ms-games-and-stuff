/*
  app.js - "proxy (beta)".

  two halves. the bottom half brings the proxy up:

    1. a cdn that has the engine          (the scramjet "jet" build)
    2. the service worker controlling us  (sw.js, scoped to ./browser/)
    3. a wisp relay that really works     (the socket the requests ride on)
    4. libcurl.js over that relay         (the transport)
    5. the scramjet controller            (stitches this page to the worker)

  the top half is the browser on top of it: tabs, a home page, an address bar.
  each tab is just an iframe, and the controller gives every iframe its own
  prefix, so tabs do not step on each other.
*/

const ENGINE = "TongSherbet/storage";

// the engine lives in one third-party repo; these are its cdn edges
const TEMPLATES = [
  "https://cdn.jsdelivr.net/gh/{r}@main/",
  "https://fastly.jsdelivr.net/gh/{r}@main/",
  "https://gcore.jsdelivr.net/gh/{r}@main/",
  "https://testingcf.jsdelivr.net/gh/{r}@main/",
  "https://originfastly.jsdelivr.net/gh/{r}@main/",
  "https://quantil.jsdelivr.net/gh/{r}@main/",
  "https://rawcdn.githack.com/{r}/main/",
  "https://raw.githack.com/{r}/main/"
];

// every route this proxy serves sits under here, so the worker's scope covers
// exactly the proxy and nothing else in the repo
const PROXY_PREFIX = "/browser/~/";

const HOUR = Math.floor(Date.now() / 3600000);

// wisp relays. the bare hostnames speak wisp at "/" over https; the two with a
// scheme are full websocket urls.
const WISP = [
  "cdn.northstreetumc.org",
  "cdn.vipersfutbol.com",
  "cdn.pcesc.org",
  "cdn.kcchallengevbc.com",
  "cdn.slcbmooc.org",
  "cdn.topstargym.net",
  "wss://athollcottage.com/connection/",
  "wss://api.personalloanonline.net/ws/"
];

/*
  the url codec. scramjet puts the target url in the path, so it has to survive
  being a path: url-safe base64, no padding. only the page-side controller reads
  it, so any symmetric pair works.
*/
const CODEC = {
  encode(url) {
    if (!url) return url;
    const bytes = new TextEncoder().encode(url);
    let binary = "";
    for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
    return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  },
  decode(text) {
    if (!text) return text;
    const padded = text.replace(/-/g, "+").replace(/_/g, "/");
    const binary = atob(padded.padEnd(padded.length + ((4 - (padded.length % 4)) % 4), "="));
    return new TextDecoder().decode(Uint8Array.from(binary, (c) => c.charCodeAt(0)));
  }
};

/* ==========================================================================
   bringing the proxy up
   ========================================================================== */

function asset(base, path) {
  return base + path + "?" + HOUR + "&raw";
}

function withDeadline(promise, ms, message) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      }
    );
  });
}

/*
  what the worker thinks it is doing, for when the handshake goes quiet - and
  for telling a current worker from a stale one.

  it retries because the route only starts answering once the freshly registered
  worker has actually activated, and asking a second too early would look
  exactly like a worker that is out of date.
*/
async function workerInfo(attempts = 25) {
  for (let i = 0; i < attempts; i++) {
    const info = await fetch("__proxy_info", { cache: "no-store" })
      .then((res) => (res.ok ? res.json() : null))
      .catch(() => null);
    if (info) return info;
    await new Promise((r) => setTimeout(r, 200));
  }
  return null;
}

function loadScript(src) {
  return new Promise((resolve, reject) => {
    const el = document.createElement("script");
    el.src = src;
    el.onload = () => {
      el.remove();
      resolve();
    };
    el.onerror = () => reject(new Error("could not load " + src));
    document.head.appendChild(el);
  });
}

async function pickEngineBase() {
  const tried = [];
  for (const template of TEMPLATES) {
    const base = template.split("{r}").join(ENGINE);
    try {
      const res = await fetch(asset(base, "sj/jet.api.js"), {
        cache: "no-store",
        signal: AbortSignal.timeout(6000)
      });
      if (!res.ok) {
        tried.push(base + " -> http " + res.status);
        continue;
      }
      // indexOf, not a regex: "$jet" starts with a regex anchor
      if (!(await res.text()).includes("$jetController")) {
        tried.push(base + " -> not the engine");
        continue;
      }
      return base;
    } catch (err) {
      tried.push(base + " -> " + ((err && err.name) || err));
    }
  }
  const err = new Error("no cdn had the proxy engine");
  err.tried = tried;
  throw err;
}

async function claimPage() {
  /*
    every load starts from a clean registration, on purpose.

    a worker stuck in "waiting" wedges its whole registration: it will not
    activate on its own, and the browser will not install anything newer while
    it sits there - so a fixed worker can end up never taking over, which is a
    miserable thing to debug. dropping the proxy's own registration first means
    each load runs the current worker. it is scoped to ./browser/, so the hub's
    worker (which is a different, root-scoped registration) is never touched.
  */
  const scope = new URL("./", location.href).href;
  const existing = (await navigator.serviceWorker.getRegistrations()).filter((r) => r.scope === scope);
  await Promise.all(existing.map((r) => r.unregister().catch(() => {})));

  const registration = await navigator.serviceWorker.register("sw.js", { updateViaCache: "none" });
  await navigator.serviceWorker.ready;

  // the worker claims this page as it activates, which hands us control without
  // a reload. wait for that, briefly.
  if (!navigator.serviceWorker.controller) {
    await new Promise((resolve) => {
      navigator.serviceWorker.addEventListener("controllerchange", resolve, { once: true });
      setTimeout(resolve, 3000);
    });
  }

  if (!navigator.serviceWorker.controller) {
    if (!sessionStorage.getItem("mspReloaded")) {
      sessionStorage.setItem("mspReloaded", "1");
      location.reload();
    }
    throw new Error("the proxy worker is not controlling this page");
  }
  sessionStorage.removeItem("mspReloaded");

  /*
    now confirm the worker that took over is really this build. route presence
    is a capability, which beats any version string - an older worker simply
    cannot answer this one. if it cannot, drop the registration and take one
    clean load, because a worker that will not update should never be something
    the user has to work out for themselves.
  */
  const info = await workerInfo();

  if (!info) {
    if (!sessionStorage.getItem("mspFresh")) {
      sessionStorage.setItem("mspFresh", "1");
      const current = (await navigator.serviceWorker.getRegistrations()).filter((r) => r.scope === scope);
      await Promise.all(current.map((r) => r.unregister().catch(() => {})));
      location.reload();
    }
    throw new Error("the proxy worker would not update - reload the page");
  }
  sessionStorage.removeItem("mspFresh");

  if (!info.engine) console.warn("[proxy] the worker came up without its engine", info.engineBase);

  return registration;
}

function wispUrl(entry) {
  return entry.includes("://") ? entry : "wss://" + entry + "/";
}

/*
  a wisp server is a websocket speaking a small binary protocol. this walks the
  handshake just far enough to prove it is really wisp and not merely something
  accepting connections: wait for the server's INFO, ask it to connect to a port
  that will always refuse, and time the answer.
*/
function probeWisp(entry, timeoutMs = 3000) {
  return new Promise((resolve) => {
    let socket;
    try {
      socket = new WebSocket(wispUrl(entry));
    } catch (err) {
      return resolve(null);
    }
    socket.binaryType = "arraybuffer";

    const streamId = (Math.floor(Math.random() * 0xfffffffe) + 1) >>> 0;
    let connected = false;
    let sentAt = 0;
    let done = false;

    function finish(value) {
      if (done) return;
      done = true;
      clearTimeout(timer);
      socket.onmessage = socket.onerror = socket.onclose = null;
      try {
        socket.close();
      } catch (err) {}
      resolve(value);
    }

    const timer = setTimeout(() => finish(null), timeoutMs);
    socket.onerror = () => finish(null);
    socket.onclose = () => finish(null);

    socket.onmessage = (event) => {
      let type, id;
      try {
        const packet = new DataView(event.data);
        type = packet.getUint8(0);
        id = packet.getUint32(1, true);
      } catch (err) {
        return;
      }

      if (!connected) {
        if (type === 5 && id === 0) {
          socket.send(new Uint8Array([5, 0, 0, 0, 0, 2, 1]));
        } else if (type === 3 && id === 0) {
          connected = true;
          const host = new TextEncoder().encode("127.0.0.1");
          const packet = new ArrayBuffer(8 + host.length);
          const out = new DataView(packet);
          out.setUint8(0, 1); // CONNECT
          out.setUint32(1, streamId, true);
          out.setUint8(5, 1);
          out.setUint16(6, 1, true); // port 1, which nothing listens on
          new Uint8Array(packet).set(host, 8);
          sentAt = performance.now();
          socket.send(packet);
        }
        return;
      }

      if (id !== streamId) return;
      finish(Math.round(performance.now() - sentAt));
    };
  });
}

// every relay that answers the handshake, best-first. speaking wisp is not the
// same as being able to reach the internet, so this is a shortlist rather than a
// decision - a relay has to pass a real request before it gets used.
async function probeRelays() {
  const live = [];
  for (const entry of WISP) {
    const ping = await probeWisp(entry);
    if (ping !== null) live.push({ server: wispUrl(entry), entry, ping });
  }
  if (!live.length) throw new Error("no wisp relay answered");
  return live;
}

async function verifyTransport(transport) {
  const out = await transport.request(new URL("http://example.com/"), "GET", undefined, [], undefined);
  const res = Array.isArray(out) ? out[0] : out;
  if (!res || !res.status) throw new Error("the relay answered with nothing");
  return res.status;
}

// libcurl builds its wasm lazily; init() complains until that finishes
async function initTransport(transport) {
  for (let i = 0; i < 100; i++) {
    try {
      await transport.init();
      return;
    } catch (err) {
      if (!String(err).includes("wasm not loaded")) throw err;
      await new Promise((r) => setTimeout(r, 100));
    }
  }
  throw new Error("the transport never finished loading its wasm");
}

/* ==========================================================================
   the browser on top
   ========================================================================== */

const stage = document.getElementById("stage");
const homePage = document.getElementById("homePage");
const tabstrip = document.getElementById("tabstrip");
const omni = document.getElementById("omni");
const urlBar = document.getElementById("url");
const stateLine = document.getElementById("state");

let controller = null;
let tabs = [];
let active = null;
let counter = 0;

function say(text) {
  stateLine.textContent = text;
}

function pretty(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, "") || url;
  } catch (err) {
    return url;
  }
}

// one iframe per tab. the controller hands each iframe its own prefix, which is
// what keeps tabs from routing into each other.
function attach(tab) {
  if (controller && !tab.frame) tab.frame = controller.createFrame(tab.element);
  return tab.frame;
}

function render() {
  const onHome = !active || !active.url;
  homePage.hidden = !onHome;

  for (const tab of tabs) {
    const on = tab === active;
    tab.element.classList.toggle("is-on", on && !!tab.url);
    tab.chip.classList.toggle("is-on", on);
  }

  urlBar.value = active && active.url ? active.url : "";
  if (onHome && controller) say("home");
}

function makeTab(url = null) {
  const id = ++counter;

  const element = document.createElement("iframe");
  element.className = "view";
  element.title = "tab " + id;
  element.setAttribute("allow", "autoplay; fullscreen; gamepad; encrypted-media; clipboard-write; cross-origin-isolated");
  stage.appendChild(element);

  const chip = document.createElement("div");
  chip.className = "chip";
  const label = document.createElement("span");
  label.className = "label";
  label.textContent = "new tab";
  const close = document.createElement("button");
  close.type = "button";
  close.className = "close";
  close.textContent = "close";
  close.setAttribute("aria-label", "close tab");
  chip.append(label, close);
  tabstrip.appendChild(chip);

  const tab = { id, element, chip, label, url: null, frame: null };
  tabs.push(tab);

  chip.addEventListener("click", (event) => {
    if (event.target !== close) activate(tab);
  });
  close.addEventListener("click", (event) => {
    event.stopPropagation();
    closeTab(tab);
  });

  if (controller) attach(tab);
  return tab;
}

function activate(tab) {
  active = tab;
  render();
}

function navigate(tab, url) {
  const frame = attach(tab);
  if (!frame) {
    say("still coming up…");
    return false;
  }
  tab.url = url;
  tab.label.textContent = pretty(url);
  frame.go(url);
  active = tab;
  render();
  say(pretty(url));
  return true;
}

function goHome() {
  if (!active) return;
  active.url = null;
  active.label.textContent = "new tab";
  render();
}

function closeTab(tab) {
  const at = tabs.indexOf(tab);
  if (at === -1) return;
  tabs = tabs.filter((t) => t !== tab);
  tab.element.remove();
  tab.chip.remove();

  if (!tabs.length) {
    active = makeTab();
  } else if (active === tab) {
    active = tabs[Math.min(at, tabs.length - 1)];
  }
  render();
}

function toUrl(input) {
  const text = input.trim();
  if (!text) return null;
  if (/^(https?|about|data):/i.test(text)) return text;
  if (/^[^\s/]+\.[^\s/]{2,}(?::\d+)?(\/|$|\?|#)/.test(text)) return "https://" + text;
  return null;
}

function go(input) {
  const target = toUrl(input);
  if (!target) {
    say("that does not look like a website");
    return;
  }
  if (!active) active = makeTab();
  navigate(active, target);
}

/* ==========================================================================
   the boot
   ========================================================================== */

async function boot() {
  if (!("serviceWorker" in navigator)) throw new Error("this browser has no service workers");

  say("finding a cdn with the engine…");
  const base = await pickEngineBase();
  console.log("[proxy] engine from", base);

  say("starting the proxy worker…");
  const registration = await claimPage();

  say("finding a wisp relay…");
  const relays = await probeRelays();
  console.log("[proxy] relays that answered: " + relays.map((r) => r.entry + " " + r.ping + "ms").join(", "));

  say("loading the transport…");
  const { default: TransportClient } = await import(asset(base, "curl/index.mjs"));

  // only the first few relays get the full treatment. each attempt builds a
  // fresh transport, which means compiling a couple of megabytes of wasm, so
  // trying all eight would make a bad network take a minute to give up.
  let wisp = relays[0];
  let transport = null;
  for (const relay of relays.slice(0, 3)) {
    try {
      const candidate = new TransportClient({ wisp: relay.server });
      await initTransport(candidate);
      await verifyTransport(candidate);
      transport = candidate;
      wisp = relay;
      break;
    } catch (err) {
      console.warn("[proxy] relay failed a real request:", relay.entry, (err && err.message) || err);
    }
  }
  if (!transport) {
    // nothing passed. still come up on the quickest one rather than refusing to
    // start at all - a relay that cannot fetch one page can still fetch others.
    wisp = relays[0];
    transport = new TransportClient({ wisp: wisp.server });
    await initTransport(transport);
    console.warn("[proxy] no relay passed the test, falling back to", wisp.entry);
  }
  console.log("[proxy] using", wisp.entry, wisp.ping + "ms");

  say("loading the engine…");
  await loadScript(asset(base, "sj/jet.core.js"));
  await loadScript(asset(base, "sj/jet.api.js"));
  const Controller = window.$jetController && window.$jetController.Controller;
  if (!Controller) throw new Error("the engine did not expose a Controller");

  controller = new Controller({
    serviceworker: navigator.serviceWorker.controller,
    transport,
    // the engine rebuilds sourcemaps inside every proxied page by default, and
    // that rewriting throws `$jet$pushsourcemap is not defined` all over the
    // console. we do not need sourcemaps, so they are off.
    jetConfig: { flags: { sourcemaps: false } },
    config: {
      prefix: PROXY_PREFIX,
      jetPath: asset(base, "sj/jet.core.js"),
      wasmPath: asset(base, "sj/jet.wasm"),
      injectPath: asset(base, "sj/jet.inject.js"),
      virtualWasmPath: "jet.wasm.js",
      codec: CODEC
    }
  });
  // the worker pings this page when it thinks it has been replaced; without
  // this the proxy would go deaf after a worker update. armed before wait(),
  // because a worker swap during the handshake is exactly when it is needed.
  controller.guardServiceWorkerRevive = false;

  // controller.wait() is Promise.all of the port handshake, the wasm load and a
  // read of the __jet_controller database. if the worker has no engine it never
  // resolves, and without a deadline that is an indefinite silent hang.
  try {
    await withDeadline(controller.wait(), 20000, "the proxy worker never completed the handshake");
  } catch (err) {
    const info = await workerInfo(5);
    if (info && !info.engine) {
      throw new Error("the proxy worker came up without its engine");
    }
    throw err;
  }

  // and a slow health check, because a worker that is up but whose engine never
  // loaded would otherwise look healthy forever
  setInterval(async () => {
    try {
      const alive = await fetch(new URL("__sw_alive", registration.scope).href, { cache: "no-store" });
      if ((await alive.text()) !== "true") throw new Error("not alive");
    } catch (err) {
      try {
        controller.serviceWorkerController = navigator.serviceWorker.controller;
        controller.setupMessagePort();
      } catch (retry) {}
    }
  }, 20000);

  // every tab that already exists (there is one) can have its frame now
  for (const tab of tabs) attach(tab);

  omni.classList.remove("loading");
  say("ready - " + wisp.entry + " (" + wisp.ping + "ms)");
  urlBar.focus();
}

/* ==========================================================================
   wiring
   ========================================================================== */

omni.addEventListener("submit", (event) => {
  event.preventDefault();
  go(urlBar.value);
  urlBar.blur();
});

document.getElementById("home").addEventListener("click", goHome);
document.getElementById("newtab").addEventListener("click", () => activate(makeTab()));

homePage.addEventListener("click", (event) => {
  const link = event.target.closest("[data-url]");
  if (!link) return;
  if (!active) active = makeTab();
  navigate(active, link.dataset.url);
});

for (const button of document.querySelectorAll("[data-act]")) {
  button.addEventListener("click", () => {
    const frame = active && active.frame;
    if (!frame) return;
    const act = button.dataset.act;
    if (act === "back") frame.back();
    else if (act === "forward") frame.forward();
    else if (act === "reload") frame.reload();
  });
}

// a site that grabs the keyboard would otherwise leave no way out of the
// overlay, so escape closes it by asking the hub
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape") {
    try {
      parent.postMessage({ proxyOverlayClose: true }, "*");
    } catch (err) {}
  }
});

active = makeTab();
render();

boot().catch((err) => {
  console.error("[proxy]", err);
  omni.classList.remove("loading");
  say(err && err.message ? err.message : String(err));
  if (err && err.tried) for (const line of err.tried) console.warn("  tried", line);
});
