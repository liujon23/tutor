/* Throwaway Phase 0 diagnostic — delete after the car test.
 *
 * Answers, on the actual device in the actual car:
 *   1. Does SpeechRecognition exist/work in a home-screen PWA, or only a tab?
 *   2. With the mic live, is speechSynthesis still audible, and from where?
 *   3. What does the head unit do when the Bluetooth profile flips?
 *   4. Is the mic usable at speed?
 *   5. How long is the deaf window across a recognition restart?
 *
 * External file, not inline: the server sets script-src 'self' with no
 * 'unsafe-inline' (server/index.ts), so an inline <script> is blocked.
 */
(function () {
  "use strict";

  var BUILD = "spike-1";
  var t0 = Date.now();
  var log = [];
  var route = "unset";

  var el = function (id) { return document.getElementById(id); };
  var logEl = el("log"), countEl = el("count");

  function rec(kind, detail) {
    var e = { ms: Date.now() - t0, kind: kind, route: route };
    if (detail !== undefined) e.detail = detail;
    log.push(e);
    var line = String(e.ms).padStart(6, " ") + "  " + kind +
      (detail === undefined ? "" : "  " + (typeof detail === "string" ? detail : JSON.stringify(detail)));
    logEl.textContent += line + "\n";
    logEl.scrollTop = logEl.scrollHeight;
    countEl.textContent = "(" + log.length + ")";
  }

  // --- Environment ---------------------------------------------------------
  var SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  var standalone =
    window.navigator.standalone === true ||
    (window.matchMedia && window.matchMedia("(display-mode: standalone)").matches);

  function envRow(dl, label, value, good) {
    var dt = document.createElement("dt"); dt.textContent = label;
    var dd = document.createElement("dd"); dd.textContent = value;
    if (good === true) dd.className = "yes";
    if (good === false) dd.className = "no";
    dl.appendChild(dt); dl.appendChild(dd);
  }

  (function describeEnv() {
    var dl = el("envlist");
    envRow(dl, "standalone", standalone ? "YES (home screen)" : "no (Safari tab)", standalone);
    envRow(dl, "SpeechRecognition", SR ? "present" : "MISSING", !!SR);
    envRow(dl, "speechSynthesis", window.speechSynthesis ? "present" : "MISSING", !!window.speechSynthesis);
    envRow(dl, "audioSession", navigator.audioSession ? "present" : "missing", !!navigator.audioSession);
    envRow(dl, "wakeLock", navigator.wakeLock ? "present" : "missing", !!navigator.wakeLock);
    envRow(dl, "secure ctx", window.isSecureContext ? "yes" : "NO — APIs will fail", window.isSecureContext);
    envRow(dl, "UA", navigator.userAgent);
    el("stamp").textContent = BUILD + " · " + (standalone ? "standalone" : "tab");
    rec("env", {
      standalone: standalone, hasSR: !!SR,
      hasAudioSession: !!navigator.audioSession, hasWakeLock: !!navigator.wakeLock,
      secure: window.isSecureContext, ua: navigator.userAgent,
    });
  })();

  // --- Speech synthesis ----------------------------------------------------
  var PARAGRAPH =
    "Marker one, marker two, marker three. This is the tutor audio spike, speaking a " +
    "medium length paragraph so you can judge whether the voice stays audible, which " +
    "speaker it comes from, and whether the first word is clipped. If you heard the " +
    "words marker one, nothing was cut off the front. Keep listening for the end. " +
    "Marker four, marker five, marker six.";

  function speak(tag) {
    // Must be called SYNCHRONOUSLY from a tap handler the first time — anything
    // behind an await breaks the gesture chain and iOS silently drops it.
    var u = new SpeechSynthesisUtterance(PARAGRAPH);
    u.rate = 1.0;
    u.onstart = function () { rec("tts.start", tag); };
    u.onend = function () { rec("tts.end", tag); };
    u.onerror = function (ev) { rec("tts.ERROR", { tag: tag, error: ev.error }); };
    rec("tts.speak() called", tag);
    window.speechSynthesis.speak(u);
    // iOS lies about .speaking; poll so a stalled queue is visible in the log.
    var polls = 0;
    var iv = setInterval(function () {
      polls++;
      rec("tts.poll", { speaking: speechSynthesis.speaking, pending: speechSynthesis.pending });
      if (polls >= 12 || (!speechSynthesis.speaking && !speechSynthesis.pending)) clearInterval(iv);
    }, 2500);
  }

  if (window.speechSynthesis) {
    window.speechSynthesis.onvoiceschanged = function () {
      rec("tts.voiceschanged", { count: speechSynthesis.getVoices().length });
    };
    rec("tts.voices at load", { count: speechSynthesis.getVoices().length });
  }

  // --- Recognition ---------------------------------------------------------
  var recog = null, looping = false, lastEndAt = null;

  function buildRecog() {
    if (!SR) return null;
    // ONE singleton — constructing a new instance each time plays the chime.
    var r = new SR();
    r.continuous = false;
    r.interimResults = true;
    r.lang = "en-US";
    ["audiostart", "soundstart", "speechstart", "speechend", "soundend", "audioend"].forEach(function (name) {
      r["on" + name] = function () {
        if (name === "audiostart" && lastEndAt !== null) {
          // THE number that matters: audio not captured between sessions.
          rec("DEAF WINDOW ms", Date.now() - lastEndAt);
          lastEndAt = null;
        }
        rec("sr." + name);
      };
    });
    r.onresult = function (ev) {
      for (var i = ev.resultIndex; i < ev.results.length; i++) {
        var res = ev.results[i];
        rec(res.isFinal ? "sr.FINAL" : "sr.interim", {
          text: res[0].transcript,
          conf: Math.round((res[0].confidence || 0) * 100) / 100,
        });
      }
    };
    r.onerror = function (ev) { rec("sr.ERROR", { error: ev.error, message: ev.message || "" }); };
    r.onend = function () {
      lastEndAt = Date.now();
      rec("sr.end", looping ? "restarting…" : "stopped");
      if (looping) setTimeout(startRecog, 100);
    };
    return r;
  }

  function startRecog() {
    if (!recog) recog = buildRecog();
    if (!recog) { rec("sr.UNAVAILABLE"); return; }
    try {
      recog.start();
      rec("sr.start() ok");
    } catch (e) {
      // InvalidStateError = start() before the previous onend settled.
      rec("sr.start() THREW", String(e && e.name) + ": " + String(e && e.message));
      setTimeout(function () { if (looping) startRecog(); }, 600);
    }
  }

  function stopRecog() {
    looping = false;
    if (recog) { try { recog.abort(); } catch (e) { rec("sr.abort threw", String(e)); } }
    rec("sr stopped by user");
  }

  // --- Audio session + wake lock ------------------------------------------
  var pnrOn = false;
  function togglePnr() {
    if (!navigator.audioSession) { rec("audioSession UNSUPPORTED"); return; }
    pnrOn = !pnrOn;
    try {
      navigator.audioSession.type = pnrOn ? "play-and-record" : "playback";
      rec("audioSession.type :=", navigator.audioSession.type);
    } catch (e) {
      rec("audioSession THREW", String(e));
    }
    el("pnr-state").textContent = pnrOn ? "HELD" : "off";
  }

  var wake = null;
  function toggleWake() {
    if (!navigator.wakeLock) { rec("wakeLock UNSUPPORTED"); return; }
    if (wake) {
      wake.release().then(function () { rec("wakeLock released by user"); });
      wake = null; el("wake-state").textContent = "off";
      return;
    }
    navigator.wakeLock.request("screen").then(function (w) {
      wake = w; el("wake-state").textContent = "HELD";
      rec("wakeLock acquired");
      w.addEventListener("release", function () {
        rec("wakeLock RELEASED by system");
        el("wake-state").textContent = "off";
        wake = null;
      });
    }).catch(function (e) { rec("wakeLock REJECTED", String(e)); });
  }

  // --- Wiring --------------------------------------------------------------
  el("b-speak").addEventListener("click", function () { rec("--- TEST 1: speak only ---"); speak("solo"); });

  el("b-both").addEventListener("click", function () {
    // The critical test. Mic first, then speak — same order the real loop uses.
    rec("--- TEST 2: mic live, then speak ---");
    looping = false;
    startRecog();
    speak("with-mic-live"); // synchronous, still inside the gesture
  });

  el("b-listen").addEventListener("click", function () {
    rec("--- TEST 3: restart loop (count aloud: one two three…) ---");
    looping = true;
    startRecog();
  });

  el("b-pnr").addEventListener("click", togglePnr);
  el("b-wake").addEventListener("click", toggleWake);

  el("b-stop").addEventListener("click", function () {
    stopRecog();
    try { speechSynthesis.cancel(); } catch (e) {}
    rec("--- STOPPED ---");
  });

  document.querySelectorAll("[data-route]").forEach(function (b) {
    b.addEventListener("click", function () {
      route = b.getAttribute("data-route");
      document.querySelectorAll("[data-route]").forEach(function (o) { o.classList.remove("sel"); });
      b.classList.add("sel");
      rec("ROUTE :=", route);
    });
  });
  document.querySelectorAll("[data-mark]").forEach(function (b) {
    b.addEventListener("click", function () { rec("MARK", b.getAttribute("data-mark")); });
  });

  document.addEventListener("visibilitychange", function () {
    rec("visibilitychange", document.visibilityState);
  });
  window.addEventListener("pagehide", function () { rec("pagehide"); });
  window.addEventListener("pageshow", function () { rec("pageshow"); });

  // --- Log export ----------------------------------------------------------
  el("b-copy").addEventListener("click", function () {
    var text = logEl.textContent;
    if (navigator.clipboard) {
      navigator.clipboard.writeText(text).then(
        function () { rec("log copied"); },
        function () { rec("clipboard denied — use Download"); }
      );
    } else { rec("no clipboard API — use Download"); }
  });
  el("b-save").addEventListener("click", function () {
    var blob = new Blob([JSON.stringify({ build: BUILD, startedAt: new Date(t0).toISOString(), events: log }, null, 2)],
      { type: "application/json" });
    var a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "audio-spike-" + route + "-" + (standalone ? "pwa" : "tab") + ".json";
    a.click();
  });
  el("b-clear").addEventListener("click", function () {
    log = []; logEl.textContent = ""; countEl.textContent = "(0)";
  });

  rec("ready");
})();
