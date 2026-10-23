// The cast pages' inline scripts — pure string constants, no behavior.
// Each ships conditionally (cast-page.tsx assembles the page); every one
// degrades silently by contract. ES5-style bodies: these run untranspiled
// in every browser that renders the page.

import { LAST_CLIENT_COOKIE, LAST_CLIENT_MAX_AGE } from "./clients.ts";

// Live engagement counts, fetched client-side so the SSR path stays
// Shim-only and no fake numbers are ever shipped. farcaster.tv (unofficial
// Warpcast client API) sends access-control-allow-origin: * and answers for
// unsigned/banned authors too, with exact reply/like/recast counts. Any
// failure leaves the row absent — stats are decoration, not content. Only
// the static icons use innerHTML; remote values go through textContent.
export const LIVE_STATS_SCRIPT = `<script>
(function () {
  var slot = document.querySelector(".farcaster-embed-stats[data-username]");
  if (!slot) return;
  var u = slot.getAttribute("data-username") || "";
  var h = slot.getAttribute("data-hash") || "";
  if (!u || !/^0x[0-9a-fA-F]+$/.test(h)) return;
  fetch("https://farcaster.tv/" + encodeURIComponent(u) + "/" + h)
    .then(function (r) { return r.ok ? r.json() : null; })
    .then(function (j) {
      var casts = j && j.result && j.result.casts;
      if (!casts) return;
      var c = null;
      for (var i = casts.length - 1; i >= 0; i--) {
        if (casts[i] && typeof casts[i].hash === "string" && casts[i].hash.indexOf(h) === 0) {
          c = casts[i];
          break;
        }
      }
      if (!c) return;
      var replies = c.replies && c.replies.count;
      var recasts = c.combinedRecastCount != null ? c.combinedRecastCount : c.recasts && c.recasts.count;
      var likes = c.reactions && c.reactions.count;
      if (replies == null && recasts == null && likes == null) return;
      var fmt = function (v) {
        return typeof v === "number" && isFinite(v) ? v.toLocaleString("en-US") : "0";
      };
      var icons = {
        reply: '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"></path></svg>',
        recast: '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17 2.1l4 4-4 4"></path><path d="M3 12.2v-2a4 4 0 0 1 4-4h12.8M7 21.9l-4-4 4-4"></path><path d="M21 11.8v2a4 4 0 0 1-4 4H4.2"></path></svg>',
        like: '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06 1.06a5.5 5.5 0 0 0 0-7.78z"></path></svg>'
      };
      var href = "https://farcaster.xyz/" + u + "/" + h;
      var ul = document.createElement("ul");
      [[icons.reply, replies], [icons.recast, recasts], [icons.like, likes]].forEach(function (it) {
        var a = document.createElement("a");
        a.className = "farcaster-embed-stats-link";
        a.href = href;
        a.target = "_blank";
        a.rel = "noopener";
        var span = document.createElement("span");
        span.textContent = fmt(it[1]);
        a.innerHTML = it[0];
        a.appendChild(span);
        var li = document.createElement("li");
        li.appendChild(a);
        ul.appendChild(li);
      });
      slot.insertBefore(ul, slot.firstChild);
    })
    .catch(function () {});
})();
</script>`;

// Click-through telemetry helper (PLAN3): one anonymous event per client
// selection, sent fire-and-forget to POST /t — client slug, choice kind,
// transport, coarse device class. No cast ids, no identifiers; failure is
// silent by contract (same degradation as the live-stats script). Emitted
// before CLIENT_SCRIPT/AUTO_SCRIPT, which call window.__fk when present.
export const TRACK_SCRIPT = `<script>
(function () {
  var dev = "";
  try {
    dev = window.matchMedia && window.matchMedia("(pointer: coarse)").matches
      ? "coarse"
      : (window.matchMedia && window.matchMedia("(pointer: fine)").matches ? "fine" : "");
  } catch (err) { dev = ""; }
  window.__fk = function (event) {
    try {
      event.d = dev;
      var body = JSON.stringify(event);
      if (body.length > 128) return;
      if (navigator.sendBeacon && navigator.sendBeacon("/t", body)) return;
      fetch("/t", { method: "POST", body: body, keepalive: true }).catch(function () {});
    } catch (err) {}
  };
})();
</script>`;

// Remembers the visitor's client choice: a delegated click listener
// writes the cookie value — slug + the existing tail ("|" and everything
// after it: auto-open flag and optional delay), so pill clicks never
// clear the preference. The flag and delay are written server-side via
// POST /prefs (ITP-safe).
export const CLIENT_SCRIPT = `<script>
(function () {
  document.addEventListener("click", function (e) {
    var el = e.target;
    while (el && el !== document) {
      var id = el.getAttribute && el.getAttribute("data-client");
      if (id) {
        var m = document.cookie.match(/(?:^|; )${LAST_CLIENT_COOKIE}=([^;]*)/);
        var cur = "";
        try { cur = m ? decodeURIComponent(m[1]) : ""; } catch (err) { cur = m ? m[1] : ""; }
        var sep = cur.indexOf("|");
        var tail = sep === -1 ? "" : cur.slice(sep);
        // First-choice flag, computed BEFORE the rewrite: no saved slug =
        // "first", a different one = "switch", same = "repeat". This is
        // the pure popularity signal (a deliberate new choice) and it is
        // computed from the visitor's own cookie — the server never sees it.
        var prev = sep === -1 ? cur : cur.slice(0, sep);
        var flag = cur === "" ? "first" : (prev === id ? "repeat" : "switch");
        document.cookie = "${LAST_CLIENT_COOKIE}=" + id + tail +
          ";path=/;max-age=${LAST_CLIENT_MAX_AGE};SameSite=Lax;Secure";
        var nativeTarget = window.matchMedia &&
          window.matchMedia("(pointer: coarse)").matches &&
          (el.getAttribute("data-scheme") || el.getAttribute("data-intent"));
        if (window.__fk) window.__fk({ c: id, k: "pill", t: nativeTarget ? "native" : "web", f: flag });
        return;
      }
      el = el.parentNode;
    }
  });
})();
</script>`;

// Native-target handling for mobile: on coarse-pointer devices, a click
// on a pill that carries a native target attempts the app first and
// falls back to the pill's web href if the page is still visible after
// the attempt (app opened ⇒ page hidden ⇒ no fallback). Android prefers
// data-intent (Chrome handles the fallback natively); everything else
// uses data-scheme. Desktop and no-JS visitors just follow the web
// href; the SSR HTML is byte-identical for every device — no UA
// sniffing on the server, only a client-side transport choice. Emitted
// only when at least one rendered client has a native target.
export const DEEPLINK_SCRIPT = `<script>
(function () {
  if (!window.matchMedia("(pointer: coarse)").matches) return;
  var android = /android/i.test(navigator.userAgent);
  document.addEventListener("click", function (e) {
    var el = e.target;
    while (el && el !== document) {
      var intent = android ? el.getAttribute && el.getAttribute("data-intent") : null;
      var target = intent || (el.getAttribute && el.getAttribute("data-scheme"));
      if (target) {
        e.preventDefault();
        var opened = false;
        var hide = function () { opened = true; };
        document.addEventListener("visibilitychange", hide, { once: true });
        window.addEventListener("pagehide", hide, { once: true });
        window.location.href = target;
        setTimeout(function () {
          if (!opened && !document.hidden) window.location.href = el.getAttribute("href");
        }, 1800);
        return;
      }
      el = el.parentNode;
    }
  });
})();
</script>`;

// Quote-card fill-in for partial wins: farcaster.tv drops quote embeds,
// so such pages ship without quote cards and this script pulls the
// shim-resolved SSR fragment (?embeds=quotes) into the page — the same
// silent-degradation contract as the live-stats script. Bots and no-JS
// visitors keep the OG-complete page; no server cache is involved.
export const QUOTE_FILL_SCRIPT = `<script>
(function () {
  var slot = document.querySelector(".farcaster-embed");
  if (!slot) return;
  fetch(location.pathname + "?embeds=quotes")
    .then(function (r) { return r.ok ? r.text() : null; })
    .then(function (html) {
      if (!html || !html.trim()) return;
      slot.insertAdjacentHTML("afterend", html);
    })
    .catch(function () {});
})();
</script>`;

// Auto-open flow: for a returning user with a last-used client.
// - unset: pausable countdown (saved delay, default 5s; 0 redirects
//   immediately) → redirect.
// - on: LARGE arming overlay with the same countdown + Pause, then
//   location.replace().
// - off: compact status chip that toggles the preference on.
// Bots never send the cookie and see none of this. Timer cancels on
// any pill pointerdown.
export const AUTO_SCRIPT = `<script>
(function () {
  var box = document.querySelector("[data-auto]");
  var post = function (auto) {
    return fetch("/prefs", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ auto: auto })
    }).catch(function () {});
  };
  var name = box ? box.getAttribute("data-auto-client") : "";
  var slug = box ? box.getAttribute("data-auto-slug") || "" : "";
  var url = box ? box.getAttribute("data-auto-url") : "";
  var mode = box ? box.getAttribute("data-auto") : "";
  // Native targets for the last-used client (server-resolved per cast).
  // Mobile attempts the app before the web redirect — the web href can be
  // a homepage stub (quorum), and a timer-driven location.replace() to it
  // would never open the app. Desktop keeps the plain redirect: schemes
  // are phone-scoped and stalling auto-open by the fallback window there
  // buys nothing.
  var schemeAttr = box ? box.getAttribute("data-auto-scheme") || "" : "";
  var intentAttr = box ? box.getAttribute("data-auto-intent") || "" : "";
  var native = null;
  if (box && window.matchMedia("(pointer: coarse)").matches) {
    native = /android/i.test(navigator.userAgent) && intentAttr ? intentAttr : schemeAttr || null;
  }
  // Telemetry: one anonymous event per open, kinded by the caller —
  // "auto" (timer expiry / delay-0) vs "go-now" (explicit). Transport
  // mirrors what open() will actually attempt. Auto events echo an
  // earlier choice; the rank weighting on the server discounts them.
  var fk = function (kind) {
    if (window.__fk && slug) window.__fk({ c: slug, k: kind, t: native ? "native" : "web" });
  };
  var delay = 5;
  if (box) {
    var rawDelay = box.getAttribute("data-auto-delay");
    if (rawDelay === "0" || rawDelay === "1" || rawDelay === "2" || rawDelay === "3" || rawDelay === "4" || rawDelay === "5") {
      delay = Number(rawDelay);
    }
  }
  var prefOn = mode === "on" || mode === "unset";
  var opening = function (tail) {
    if (delay === 0) return "Opening <strong>" + name + "</strong> now" + tail;
    return "Opening <strong>" + name + '</strong> in <span class="auto-secs">' + delay + "</span>s" + tail;
  };
  var chip = function (pressed) {
    return '<button class="pill auto-chip" data-auto-toggle aria-pressed="' +
      (pressed ? "true" : "false") + '" title="Toggle auto-open">Auto-open: ' +
      (pressed ? "On" : "Off") + '</button>';
  };
  var settings = '<a class="auto-settings" href="/">settings</a>';
  // One choice per view: Pause. Settings (Turn off / toggle) appear only
  // in the calm paused view, never during the redirect window.
  var views = {
    countdown: function () {
      // data-scheme/data-intent let DEEPLINK_SCRIPT's delegated click
      // handler attempt the app when the anchor is tapped manually (its
      // fallback is the anchor href — the same web URL).
      return '<a class="auto-go" href="' + url + '"' +
        (schemeAttr ? ' data-scheme="' + schemeAttr + '"' : '') +
        (intentAttr ? ' data-intent="' + intentAttr + '"' : '') +
        '>' + opening(" \u2192") + "</a>" +
        '<button class="pill" data-auto-action="pause">Pause</button>';
    },
    paused: function () {
      return '<span class="auto-status">Paused \u2014 ' +
        (prefOn ? "auto-open is on; next casts open in <strong>" + name + "</strong>" : "pick a client below") +
        '</span>' +
        '<button class="pill" data-auto-action="go">Go now</button>' +
        (prefOn ? '<button class="pill" data-auto-action="off">Turn off auto-open</button>' : '') +
        settings;
    },
    arming: function () {
      return '<p class="auto-overlay-title">' + opening("\u2026") + "</p>" +
        '<p class="auto-overlay-actions"><button class="pill" data-auto-action="pause">Pause</button></p>';
    },
    stayed: function () {
      return '<span class="auto-status">Auto-open is on \u2014 next casts open in <strong>' + name + '</strong></span>' +
        chip(true) + settings;
    },
    off: function () {
      return '<span class="auto-status">Auto-open is off</span>' + chip(false) + settings;
    }
  };
  var apply = function (view) {
    box.className = view === "arming" ? "auto-overlay" : "auto-banner";
    box.innerHTML = views[view]();
  };
  var fired = false;
  var timer = null;
  var tick = null;
  var cancelAll = function () {
    if (timer) { clearTimeout(timer); timer = null; }
    if (tick) { clearInterval(tick); tick = null; }
  };
  // Every redirect path (delay-0, timer expiry, Go now) funnels through
  // open(): native attempt when the last-used client has a target and
  // this is a phone, web redirect otherwise. The 2.5s visibility window
  // mirrors DEEPLINK_SCRIPT but runs longer — a timer fire has no user
  // gesture anchoring the navigation, and cold starts (Quorum's RN +
  // WASM boot, expo-updates check-on-launch) can outrun 1.8s. The kind
  // argument distinguishes an automatic open from an explicit one.
  var open = function (kind) {
    if (fired) return;
    fired = true;
    fk(kind);
    if (!native) {
      location.replace(url);
      return;
    }
    var opened = false;
    var hide = function () { opened = true; };
    document.addEventListener("visibilitychange", hide, { once: true });
    window.addEventListener("pagehide", hide, { once: true });
    window.location.href = native;
    setTimeout(function () {
      if (!opened && !document.hidden) location.replace(url);
    }, 2500);
  };
  var secsLeft = delay;
  var startTimer = function () {
    if (delay === 0) {
      open("auto");
      return;
    }
    secsLeft = delay;
    tick = setInterval(function () {
      secsLeft -= 1;
      if (secsLeft <= 0) {
        cancelAll();
        open("auto");
        return;
      }
      var s = box.querySelector(".auto-secs");
      if (s) s.textContent = String(secsLeft);
    }, 1000);
  };
  var pause = function () { cancelAll(); apply("paused"); };
  var goNow = function () {
    cancelAll();
    open("go-now");
  };
  var turnOff = function () {
    cancelAll();
    prefOn = false;
    if (tick) { clearInterval(tick); tick = null; }
    post("off").then(function () { apply("off"); });
  };
  if (box) {
    box.addEventListener("click", function (e) {
      var t = e.target && e.target.closest ? e.target.closest("[data-auto-toggle]") : null;
      if (t) {
        var target = prefOn ? "off" : "on";
        cancelAll();
        post(target).then(function () {
          prefOn = target === "on";
          apply(prefOn ? "stayed" : "off");
        });
        return;
      }
      // The countdown link is an explicit open of the saved client (the
      // anchor routes through DEEPLINK_SCRIPT on phones). Cancel the
      // pending timer and mark fired: a manual open supersedes the
      // auto-open — without this, a native attempt that keeps the page
      // visible would get re-redirected to the web href when the timer
      // later fires.
      var g = e.target && e.target.closest ? e.target.closest(".auto-go") : null;
      if (g) {
        cancelAll();
        fired = true;
        fk("go-now");
        return;
      }
      var a = e.target && e.target.closest ? e.target.closest("[data-auto-action]") : null;
      if (!a) return;
      var action = a.getAttribute("data-auto-action");
      if (action === "pause") pause();
      else if (action === "go") goNow();
      else if (action === "off") turnOff();
    });
    document.addEventListener("pointerdown", function (e) {
      var n = e.target;
      while (n && n !== document) {
        if (n.classList && n.classList.contains("actions")) {
          if (mode === "unset" || mode === "on") pause();
          return;
        }
        n = n.parentNode;
      }
    }, true);
  }
  if (mode === "on") {
    apply("arming");
    startTimer();
  }
  if (mode === "unset") {
    apply("countdown");
    startTimer();
  }
})();
</script>`;
