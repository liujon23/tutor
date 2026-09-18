/* Throwaway Phase 0 diagnostic — delete this folder once it has answered.
 *
 * A guided runbook, not a control panel: one instruction on screen at a time,
 * because this is operated alone in a car and nobody remembers a protocol
 * under those conditions. Each step says what to do and what to listen for,
 * and every judgement is recorded against the step that produced it — "heard
 * it clearly" after test 1 and after test 2 mean opposite things.
 *
 * External file, not inline: the server sets script-src 'self' with no
 * 'unsafe-inline' (server/index.ts), so an inline <script> is blocked.
 */
(function () {
  "use strict";

  var BUILD = "spike-2";
  var STORE_KEY = "tutor-audio-spike-v2";
  var t0 = Date.now();

  var SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  var MODE =
    window.navigator.standalone === true ||
    (window.matchMedia && window.matchMedia("(display-mode: standalone)").matches)
      ? "pwa"
      : "tab";

  var ROUTES = [
    { id: "bluetooth", name: "Bluetooth car kit" },
    { id: "speaker", name: "Phone speaker" },
    { id: "earbud", name: "Wired earbud" },
  ];

  var el = function (id) { return document.getElementById(id); };

  // --- state ---------------------------------------------------------------
  var S = {
    route: null,
    stepIndex: 0,
    marked: null,      // mark recorded for the current step
    acted: false,      // the step's action has been run at least once
    exported: false,
    running: false,    // a start/stop action is mid-flight
    log: [],
    done: {},          // "<route>|<mode>" -> ISO timestamp
  };

  function loadDone() {
    try {
      var raw = localStorage.getItem(STORE_KEY);
      if (raw) S.done = JSON.parse(raw).done || {};
    } catch (e) { /* private mode / blocked storage — the JSON download covers us */ }
  }
  function saveDone() {
    try {
      localStorage.setItem(STORE_KEY, JSON.stringify({ done: S.done }));
    } catch (e) { /* ignore — export is the source of truth */ }
  }

  // --- log -----------------------------------------------------------------
  function rec(kind, detail) {
    var e = {
      ms: Date.now() - t0,
      kind: kind,
      route: S.route || "unset",
      mode: MODE,
      step: STEPS[S.stepIndex] ? STEPS[S.stepIndex].id : "none",
    };
    if (detail !== undefined) e.detail = detail;
    S.log.push(e);
    var line =
      String(e.ms).padStart(6, " ") + "  [" + e.step + "] " + kind +
      (detail === undefined ? "" : "  " + (typeof detail === "string" ? detail : JSON.stringify(detail)));
    var logEl = el("log");
    logEl.textContent += line + "\n";
    logEl.scrollTop = logEl.scrollHeight;
    el("count").textContent = "(" + S.log.length + ")";
  }

  // --- environment ---------------------------------------------------------
  function describeEnv() {
    var dl = el("envlist");
    function row(label, value, good) {
      var dt = document.createElement("dt"); dt.textContent = label;
      var dd = document.createElement("dd"); dd.textContent = value;
      if (good === true) dd.className = "yes";
      if (good === false) dd.className = "no";
      dl.appendChild(dt); dl.appendChild(dd);
    }
    row("app mode", MODE === "pwa" ? "home-screen app" : "Safari tab");
    row("SpeechRecognition", SR ? "present" : "MISSING", !!SR);
    row("speechSynthesis", window.speechSynthesis ? "present" : "MISSING", !!window.speechSynthesis);
    row("audioSession", navigator.audioSession ? "present" : "missing", !!navigator.audioSession);
    row("wakeLock", navigator.wakeLock ? "present" : "missing", !!navigator.wakeLock);
    row("secure context", window.isSecureContext ? "yes" : "NO", window.isSecureContext);
    row("UA", navigator.userAgent);

    el("stamp").textContent = BUILD + " · " + (MODE === "pwa" ? "home-screen app" : "Safari tab");
    var v = el("verdict");
    if (!window.isSecureContext) {
      v.className = "verdict bad";
      v.textContent = "Not a secure context — open the https:// tailnet URL, not a LAN IP.";
    } else if (SR) {
      v.className = "verdict ok";
      v.textContent = "Recognition available in the " +
        (MODE === "pwa" ? "home-screen app" : "Safari tab") + ".";
    } else {
      v.className = "verdict bad";
      v.textContent = "Recognition MISSING in the " +
        (MODE === "pwa" ? "home-screen app" : "Safari tab") + " — that is a finding. Record it and try the other mode.";
    }
    rec("env", { mode: MODE, hasSR: !!SR, hasAudioSession: !!navigator.audioSession,
      hasWakeLock: !!navigator.wakeLock, secure: window.isSecureContext, ua: navigator.userAgent });
  }

  // --- speech synthesis ----------------------------------------------------
  var PARAGRAPH =
    "Marker one, marker two, marker three. This is the tutor audio spike, speaking a " +
    "medium length paragraph so you can judge whether the voice stays audible, which " +
    "speaker it comes from, and whether the first word is clipped. If you heard the " +
    "words marker one, nothing was cut off the front. Keep listening for the end. " +
    "Marker four, marker five, marker six.";

  function speak(tag) {
    // Called SYNCHRONOUSLY from the tap handler — anything behind an await
    // breaks the gesture chain and iOS silently drops the utterance.
    var u = new SpeechSynthesisUtterance(PARAGRAPH);
    u.onstart = function () { rec("tts.start", tag); };
    u.onend = function () { rec("tts.end", tag); };
    u.onerror = function (ev) { rec("tts.ERROR", { tag: tag, error: ev.error }); };
    rec("tts.speak() called", tag);
    window.speechSynthesis.speak(u);
    var polls = 0;
    var iv = setInterval(function () {
      polls++;
      rec("tts.poll", { speaking: speechSynthesis.speaking, pending: speechSynthesis.pending });
      if (polls >= 10 || (!speechSynthesis.speaking && !speechSynthesis.pending)) clearInterval(iv);
    }, 2500);
  }

  // --- recognition ---------------------------------------------------------
  var recog = null, looping = false, lastEndAt = null, deafWindows = [];

  function buildRecog() {
    if (!SR) return null;
    var r = new SR(); // ONE singleton — a fresh instance each time plays the chime
    r.continuous = false;
    r.interimResults = true;
    r.lang = "en-US";
    ["audiostart", "soundstart", "speechstart", "speechend", "soundend", "audioend"].forEach(function (name) {
      r["on" + name] = function () {
        if (name === "audiostart" && lastEndAt !== null) {
          var gap = Date.now() - lastEndAt;
          deafWindows.push(gap);
          rec("DEAF WINDOW ms", gap); // audio not captured between sessions
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
      if (S.stepIndex >= 0) render();
    };
    r.onerror = function (ev) {
      // no-speech and aborted are the NORMAL path with continuous=false.
      rec("sr." + (ev.error === "no-speech" || ev.error === "aborted" ? "end-reason" : "ERROR"),
        { error: ev.error, message: ev.message || "" });
    };
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
    try { recog.start(); rec("sr.start() ok"); }
    catch (e) {
      // InvalidStateError: start() before the previous onend settled.
      rec("sr.start() THREW", String(e && e.name) + ": " + String(e && e.message));
      setTimeout(function () { if (looping) startRecog(); }, 600);
    }
  }

  function transcriptSoFar() {
    return S.log.filter(function (e) { return e.kind === "sr.FINAL"; })
      .map(function (e) { return e.detail.text.trim(); }).join(" | ");
  }

  // --- audio session + wake lock ------------------------------------------
  function holdPlayAndRecord() {
    if (!navigator.audioSession) { rec("audioSession UNSUPPORTED"); return false; }
    try {
      navigator.audioSession.type = "play-and-record";
      rec("audioSession.type :=", navigator.audioSession.type);
      return true;
    } catch (e) { rec("audioSession THREW", String(e)); return false; }
  }

  var wake = null;
  function requestWake() {
    if (!navigator.wakeLock) { rec("wakeLock UNSUPPORTED"); return; }
    navigator.wakeLock.request("screen").then(function (w) {
      wake = w; rec("wakeLock acquired");
      w.addEventListener("release", function () { rec("wakeLock RELEASED by system"); wake = null; });
    }).catch(function (e) { rec("wakeLock REJECTED", String(e)); });
  }

  // --- step actions --------------------------------------------------------
  function playParagraph() { speak("solo"); }
  function micThenPlay() { looping = false; startRecog(); speak("with-mic-live"); }
  function holdThenPlay() { holdPlayAndRecord(); looping = false; startRecog(); speak("session-held"); }
  function startLoop() { deafWindows = []; looping = true; startRecog(); }
  function stopLoop() {
    looping = false;
    if (recog) { try { recog.abort(); } catch (e) { /* already stopped */ } }
    rec("loop stopped", { deafWindows: deafWindows, transcript: transcriptSoFar() });
  }

  function deafReadout() {
    if (!deafWindows.length) return "";
    var sorted = deafWindows.slice().sort(function (a, b) { return a - b; });
    var med = sorted[Math.floor(sorted.length / 2)];
    return "Restarts so far: " + deafWindows.length +
      " · deaf window median " + med + "ms, worst " + sorted[sorted.length - 1] + "ms";
  }

  function loopTranscriptReadout() {
    var t = transcriptSoFar();
    return t ? "Heard: " + t : "Nothing recognised yet.";
  }

  // --- steps ---------------------------------------------------------------
  var STEPS = [
    {
      id: "route", meta: "Setup", title: "Which audio route?",
      doText: "Park with the engine running and the phone mounted. Connect the route you are testing, then tap it below.",
      routePicker: true,
    },
    {
      id: "baseline", meta: "Test 1 of 4", title: "Baseline — speak only",
      doText: "Tap Play and listen to the whole paragraph. No microphone is involved yet.",
      listenText: "Did you hear the words “marker one” at the very start? Is it loud enough over the engine?",
      action: { label: "▶ Play paragraph", fn: playParagraph },
      marks: ["Heard, clear", "Heard, too quiet", "First word clipped", "Heard nothing"],
    },
    {
      id: "miclive", meta: "Test 2 of 4 — the decisive one", title: "Microphone on, then speak",
      doText: "Tap Start. The microphone turns on first, then the same paragraph plays — the order the real lesson loop uses.",
      listenText: "Is the voice still audible now the mic is live? Quieter than test 1? Coming from the earpiece instead of the speaker? On Bluetooth: did the car switch source or show a call?",
      action: { label: "▶ Mic on, then play", fn: micThenPlay },
      marks: ["Heard, same as test 1", "Heard, but quieter", "Came from earpiece", "Heard nothing", "Car switched source"],
    },
    {
      id: "holdpnr", meta: "Test 3 of 4", title: "Hold the session, then speak",
      doText: "Tap Start. This pins the audio session to play-and-record before speaking — the “treat it as a phone call” mitigation.",
      listenText: "Same question as test 2. If this one is audible but test 2 was not, holding the session is the fix and Phase 2 has a path.",
      action: { label: "▶ Hold session, then play", fn: holdThenPlay },
      marks: ["Heard, clear", "Heard, but quieter", "Came from earpiece", "Heard nothing", "Car switched source"],
    },
    {
      id: "loop", meta: "Test 4 of 4", title: "Recognition restart loop",
      doText: "Tap Start, then count aloud steadily — one, two, three … up to twenty. Then tap Stop.",
      listenText: "Missing numbers in the transcript are words lost while the recogniser was restarting. The deaf window below measures that directly.",
      action: { label: "▶ Start loop", fn: startLoop, stopLabel: "■ Stop loop", stopFn: stopLoop },
      readouts: [deafReadout, loopTranscriptReadout],
      marks: ["Got every number", "A few missing", "Many missing", "Nothing recognised"],
    },
    {
      id: "wake", meta: "Check", title: "Wake lock",
      doText: "Tap Request, then leave the phone untouched for a moment.",
      listenText: "Does the screen stay awake? If wake lock is unsupported in this mode the log says so — mark it unsupported.",
      action: { label: "Request wake lock", fn: requestWake },
      marks: ["Screen stayed on", "Screen slept", "Unsupported"],
    },
    {
      id: "export", meta: "Finish", title: "Save this run",
      doText: "Download the JSON now. iOS may not share storage between Safari and the home-screen app, so this file is the only thing guaranteed to survive switching modes.",
      action: { label: "⬇ Download JSON", fn: saveRun },
      requireExport: true,
    },
  ];

  var HIGHWAY = {
    id: "highway", meta: "Driving", title: "Highway run",
    doText: "One tap to start, then drive. Count aloud and talk in full sentences as you go. Do not touch the phone again until you have parked.",
    listenText: "Nothing to judge while moving. Park first, then stop the run and read the transcript.",
    action: { label: "▶ Start and drive", fn: startLoop, stopLabel: "■ Parked — stop", stopFn: stopLoop },
    readouts: [deafReadout, loopTranscriptReadout],
    marks: ["Usable at speed", "Marginal", "Useless at speed"],
  };
  var highwayMode = false;

  // --- rendering -----------------------------------------------------------
  function currentStep() { return highwayMode ? HIGHWAY : STEPS[S.stepIndex]; }

  function canAdvance(step) {
    if (step.routePicker) return !!S.route;
    if (step.requireExport) return S.exported;
    if (step.marks) return S.marked !== null;
    return true;
  }

  function render() {
    var step = currentStep();
    var stage = el("stage");
    stage.innerHTML = "";

    var meta = document.createElement("div");
    meta.className = "stepmeta";
    meta.textContent = highwayMode
      ? "Highway run"
      : "Step " + (S.stepIndex + 1) + " of " + STEPS.length + " · " + step.meta +
        (S.route ? " · " + routeName(S.route) : "");
    stage.appendChild(meta);

    var h = document.createElement("h2");
    h.className = "steptitle";
    h.textContent = step.title;
    stage.appendChild(h);

    stage.appendChild(block("Do this", step.doText, ""));
    if (step.listenText) stage.appendChild(block("Listen for", step.listenText, "listen"));

    if (step.routePicker) {
      var row = document.createElement("div");
      row.className = "row";
      ROUTES.forEach(function (r) {
        var b = document.createElement("button");
        b.className = "pill" + (S.route === r.id ? " sel" : "");
        b.textContent = r.name + (S.done[r.id + "|" + MODE] ? " ✓" : "");
        b.onclick = function () { S.route = r.id; rec("route :=", r.id); render(); };
        row.appendChild(b);
      });
      stage.appendChild(row);
    }

    (S.acted ? step.readouts || [] : []).forEach(function (fn) {
      var text = fn();
      if (!text) return;
      var p = document.createElement("p");
      p.className = "big-readout";
      p.textContent = text;
      stage.appendChild(p);
    });

    if (step.action) {
      var ab = document.createElement("button");
      ab.className = "big " + (S.running ? "stop" : "go");
      ab.textContent = S.running ? step.action.stopLabel : step.action.label;
      ab.onclick = function () {
        if (S.running) {
          step.action.stopFn();
          S.running = false;
        } else {
          step.action.fn();          // synchronous — keeps the gesture chain alive
          S.acted = true;
          if (step.action.stopFn) S.running = true;
        }
        render();
      };
      stage.appendChild(ab);
    }

    if (step.marks && S.acted && !S.running) {
      var mrow = document.createElement("div");
      mrow.className = "row";
      step.marks.forEach(function (m) {
        var b = document.createElement("button");
        b.className = "pill" + (S.marked === m ? " sel" : "") + (/nothing|useless|slept/i.test(m) ? " bad" : "");
        b.textContent = m;
        b.onclick = function () {
          S.marked = m;
          rec("MARK", m); // logged against this step — never ambiguous later
          render();
        };
        mrow.appendChild(b);
      });
      stage.appendChild(mrow);
    }

    var nb = document.createElement("button");
    nb.className = "big next";
    if (highwayMode) {
      nb.textContent = "Done — back to the checklist";
      nb.disabled = !canAdvance(step);
      nb.onclick = function () { highwayMode = false; resetStep(); render(); };
    } else if (S.stepIndex === STEPS.length - 1) {
      nb.textContent = "Finish this run";
      nb.disabled = !canAdvance(step);
      nb.onclick = finishRun;
    } else {
      nb.textContent = "Next step →";
      nb.disabled = !canAdvance(step);
      nb.onclick = function () { S.stepIndex++; resetStep(); render(); };
    }
    stage.appendChild(nb);
    if (nb.disabled) stage.appendChild(hint(disabledReason(step)));

    renderProgress();
  }

  function disabledReason(step) {
    if (step.routePicker) return "Pick a route first — every log line is tagged with it.";
    if (step.requireExport) return "Download the file first; it is the only copy that survives switching modes.";
    if (S.running) return "Stop the run first.";
    if (!S.acted) return "Run the test above first.";
    return "Mark what you heard — an unmarked test tells us nothing later.";
  }

  function block(label, text, cls) {
    var d = document.createElement("div");
    d.className = "block " + cls;
    var l = document.createElement("span");
    l.className = "label"; l.textContent = label;
    var b = document.createElement("span");
    b.className = "body"; b.textContent = text;
    d.appendChild(l); d.appendChild(b);
    return d;
  }
  function hint(text) {
    var p = document.createElement("p");
    p.className = "hint"; p.textContent = text;
    return p;
  }
  function routeName(id) {
    for (var i = 0; i < ROUTES.length; i++) if (ROUTES[i].id === id) return ROUTES[i].name;
    return id;
  }

  function resetStep() { S.marked = null; S.acted = false; S.running = false; S.exported = false; }

  function renderProgress() {
    var p = el("progress");
    p.innerHTML = "";
    var title = document.createElement("div");
    title.className = "stepmeta";
    title.textContent = "Runs completed";
    p.appendChild(title);

    var grid = document.createElement("div");
    grid.className = "runs";
    ["tab", "pwa"].forEach(function (mode) {
      ROUTES.forEach(function (r) {
        var n = document.createElement("div");
        n.className = "name";
        n.textContent = routeName(r.id) + " · " + (mode === "pwa" ? "home-screen" : "Safari tab");
        var st = document.createElement("div");
        var done = S.done[r.id + "|" + mode];
        st.className = "state " + (done ? "done" : "todo");
        st.textContent = done ? "done" : "—";
        grid.appendChild(n); grid.appendChild(st);
      });
    });
    p.appendChild(grid);
    p.appendChild(hint(
      "You only need all three routes in ONE mode. The other mode needs a single run, " +
      "just to establish whether recognition exists there at all."
    ));

    if (!highwayMode) {
      var hb = document.createElement("button");
      hb.className = "big";
      hb.style.marginTop = "10px";
      hb.textContent = "Highway run (driving)";
      hb.onclick = function () {
        if (!S.route) { alert("Pick a route on step 1 first."); return; }
        highwayMode = true; resetStep(); rec("--- HIGHWAY RUN ---"); render();
      };
      p.appendChild(hb);
    }
  }

  // --- export / finish -----------------------------------------------------
  function saveRun() {
    var payload = {
      build: BUILD, mode: MODE, route: S.route,
      startedAt: new Date(t0).toISOString(),
      deafWindows: deafWindows,
      events: S.log,
    };
    var blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
    var a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "audio-spike-" + (S.route || "unset") + "-" + MODE + ".json";
    a.click();
    S.exported = true;
    rec("exported");
    setTimeout(render, 0);
  }

  function finishRun() {
    S.done[S.route + "|" + MODE] = new Date().toISOString();
    saveDone();
    rec("RUN COMPLETE", S.route + "|" + MODE);
    S.stepIndex = 0;
    S.route = null;
    resetStep();
    render();
  }

  // --- global listeners ----------------------------------------------------
  document.addEventListener("visibilitychange", function () {
    rec("visibilitychange", document.visibilityState);
  });
  window.addEventListener("pagehide", function () { rec("pagehide"); });
  if (window.speechSynthesis) {
    window.speechSynthesis.onvoiceschanged = function () {
      rec("tts.voiceschanged", { count: speechSynthesis.getVoices().length });
    };
  }

  el("b-copy").onclick = function () {
    var text = el("log").textContent;
    if (navigator.clipboard) {
      navigator.clipboard.writeText(text).then(
        function () { rec("log copied"); },
        function () { rec("clipboard denied — use Download"); }
      );
    } else { rec("no clipboard API — use Download"); }
  };
  el("b-save").onclick = saveRun;
  el("b-reset").onclick = function () {
    if (!confirm("Clear the log and all recorded run progress?")) return;
    S.log = []; S.done = {}; S.route = null; S.stepIndex = 0;
    deafWindows = []; resetStep();
    el("log").textContent = ""; el("count").textContent = "(0)";
    saveDone(); render();
  };

  // --- go ------------------------------------------------------------------
  loadDone();
  describeEnv();
  if (window.speechSynthesis) rec("tts.voices at load", { count: speechSynthesis.getVoices().length });
  render();
})();
