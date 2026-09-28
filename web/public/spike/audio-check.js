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

  var BUILD = "spike-6";
  var STORE_KEY = "tutor-audio-spike-v4";
  var t0 = Date.now();

  var SR = window.SpeechRecognition || window.webkitSpeechRecognition;

  /* Which browser, not just which display mode.
   *
   * Every iOS browser is WebKit underneath, so a third-party one still EXPOSES
   * webkitSpeechRecognition — `hasSR` is true — but lacks the speech-recognition
   * entitlement, and start() fails ~10ms later with
   * not-allowed / "Microphone permission check has failed", no prompt shown.
   * The first real run hit exactly this in Chrome while the page cheerfully
   * reported "Recognition available in a Safari tab", which is the opposite of
   * the truth on the one question this page exists to answer. */
  function detectBrowser() {
    var ua = navigator.userAgent;
    if (/CriOS\//.test(ua)) return { name: "Chrome for iOS", thirdParty: true };
    if (/FxiOS\//.test(ua)) return { name: "Firefox for iOS", thirdParty: true };
    if (/EdgiOS\//.test(ua)) return { name: "Edge for iOS", thirdParty: true };
    if (/(OPiOS|OPT)\//.test(ua)) return { name: "Opera for iOS", thirdParty: true };
    return { name: "Safari", thirdParty: false };
  }
  var BROWSER = detectBrowser();

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
    saved: false,      // this run survived — uploaded or downloaded
    runMarks: {},      // stepId -> mark, for the run in progress
    srError: null,     // last recognition error, shown on the step
    micOpened: false,  // sr.audiostart fired at least once this run
    running: false,    // a start/stop action is mid-flight
    log: [],
    done: {},          // "<route>|<mode>" -> ISO timestamp
  };

  // Completed runs, so the verdict can reason ACROSS runs rather than just
  // flagging them done. Storage can be unavailable (private mode) and iOS may
  // not share it between Safari and a home-screen app, which is exactly why
  // finishing a run also requires an upload or a download.
  var STORE = { runs: [], highway: {} };

  function loadStore() {
    try {
      var raw = localStorage.getItem(STORE_KEY);
      if (raw) {
        var parsed = JSON.parse(raw);
        STORE.runs = parsed.runs || [];
        STORE.highway = parsed.highway || {};
      }
    } catch (e) { /* blocked storage — the upload/download is the real record */ }
    rebuildDone();
  }
  function persist() {
    try { localStorage.setItem(STORE_KEY, JSON.stringify(STORE)); }
    catch (e) { /* ignore — the saved run file is the source of truth */ }
    rebuildDone();
  }
  function rebuildDone() {
    S.done = {};
    STORE.runs.forEach(function (r) { S.done[r.route + "|" + r.mode] = r.at; });
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
    row("browser", BROWSER.name, !BROWSER.thirdParty);
    row("app mode", MODE === "pwa" ? "home-screen app" : "tab");
    row("SpeechRecognition", SR ? "present" : "MISSING", !!SR);
    row("speechSynthesis", window.speechSynthesis ? "present" : "MISSING", !!window.speechSynthesis);
    row("audioSession", navigator.audioSession ? "present" : "missing", !!navigator.audioSession);
    row("wakeLock", navigator.wakeLock ? "present" : "missing", !!navigator.wakeLock);
    row("secure context", window.isSecureContext ? "yes" : "NO", window.isSecureContext);
    row("UA", navigator.userAgent);

    var where = BROWSER.name + (MODE === "pwa" ? ", home-screen app" : ", tab");
    el("stamp").textContent = BUILD + " · " + where;
    var v = el("verdict");
    if (!window.isSecureContext) {
      v.className = "verdict bad";
      v.textContent = "Not a secure context — open the https:// tailnet URL, not a LAN IP.";
    } else if (BROWSER.thirdParty) {
      // hasSR is true here and means nothing; never show green.
      v.className = "verdict bad";
      v.textContent = "This is " + BROWSER.name + ". Speech recognition does not work in " +
        "third-party iOS browsers — it fails instantly with no prompt, however the " +
        "settings are configured. Reopen this page in Safari.";
    } else if (SR) {
      v.className = "verdict ok";
      v.textContent = "Recognition available in " + where + ".";
    } else {
      v.className = "verdict bad";
      v.textContent = "Recognition MISSING in " + where +
        " — that is a finding. Record it and try the other mode.";
    }
    rec("env", { browser: BROWSER.name, thirdParty: BROWSER.thirdParty, mode: MODE, hasSR: !!SR, hasAudioSession: !!navigator.audioSession,
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

  /* What each recognition error actually means, in the operator's terms. The
   * reason used to sit only in a collapsed log nobody had cause to open, which
   * is indefensible for a page whose whole job is "does the mic work". */
  var SR_ERROR_HELP = {
    "not-allowed":
      "The microphone was refused before iOS even asked. In a third-party browser " +
      "(Chrome, Firefox, Edge) this is permanent — use Safari. In Safari, check aA → " +
      "Website Settings → Microphone, and Settings → Safari → Microphone.",
    "service-not-allowed":
      "iOS refused the speech service itself. Check Settings → General → Keyboard → " +
      "Enable Dictation. Home-screen web apps also often cannot use recognition at all — " +
      "if this is the installed app, try a Safari tab.",
    "audio-capture":
      "No microphone available, or another app is holding it. Close other audio apps and retry.",
    "network":
      "Recognition needs the network and could not reach it. Expected in a dead zone.",
    "no-speech":
      "The mic worked and simply heard nothing — that is a PASS for opening the mic. " +
      "Speak sooner or louder and run it again.",
    "aborted": "Stopped deliberately — normal when a test ends.",
  };

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
        if (name === "audiostart") S.micOpened = true; // the mic genuinely opened
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
      var benign = ev.error === "no-speech" || ev.error === "aborted";
      rec("sr." + (benign ? "end-reason" : "ERROR"), { error: ev.error, message: ev.message || "" });
      S.srError = { error: ev.error, message: ev.message || "", benign: benign };
      render();
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
    // Releasing first: a second request used to overwrite `wake`, leaking the
    // previous lock (visible as two simultaneous "RELEASED by system" lines).
    if (wake) { wake.release().catch(function () {}); wake = null; }
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
  /** One recognition session, no restart loop, and crucially no audio played
   *  first. iOS has a documented bug where mic input stops working after media
   *  playback, so a mic test that runs AFTER the speak test cannot distinguish
   *  "mic is broken" from "mic was broken by the playback". This is the control. */
  function startMicOnly() { deafWindows = []; looping = false; S.micOpened = false; startRecog(); }
  function stopMicOnly() {
    if (recog) { try { recog.abort(); } catch (e) { /* already stopped */ } }
    rec("mic-only stopped", { micOpened: S.micOpened, transcript: transcriptSoFar() });
  }
  function stopLoop() {
    looping = false;
    if (recog) { try { recog.abort(); } catch (e) { /* already stopped */ } }
    rec("loop stopped", { deafWindows: deafWindows, transcript: transcriptSoFar() });
  }

  function deafStats() {
    if (!deafWindows.length) return null;
    var sorted = deafWindows.slice().sort(function (a, b) { return a - b; });
    return { n: sorted.length, median: sorted[Math.floor(sorted.length / 2)], worst: sorted[sorted.length - 1] };
  }

  function deafReadout() {
    if (!deafWindows.length) return "";
    var sorted = deafWindows.slice().sort(function (a, b) { return a - b; });
    var med = sorted[Math.floor(sorted.length / 2)];
    return "Restarts so far: " + deafWindows.length +
      " · deaf window median " + med + "ms, worst " + sorted[sorted.length - 1] + "ms";
  }

  function micOnlyReadout() {
    if (!S.acted) return "";
    return S.micOpened
      ? "The microphone OPENED. " + (transcriptSoFar() ? "Heard: " + transcriptSoFar() : "No words recognised yet.")
      : "The microphone has NOT opened yet — no audiostart event.";
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
      id: "miconly", meta: "Test 1 of 5 — the control", title: "Microphone alone",
      doText: "Nothing has played yet — that is the point. Tap Start, say \u201cone two three four five\u201d, then tap Stop.",
      listenText: "Does the mic work on a clean audio session, before any audio has played? " +
        "iOS can break recognition once media has played, so if this is not tested first, a " +
        "later failure cannot be told apart from that bug. If this step fails, nothing after it means much.",
      action: { label: "\u25B6 Start mic", fn: startMicOnly, stopLabel: "\u25A0 Stop mic", stopFn: stopMicOnly },
      readouts: [micOnlyReadout],
      marks: ["Recognised my words", "Mic opened, heard nothing", "Mic never opened"],
    },
    {
      id: "baseline", meta: "Test 2 of 5", title: "Baseline — speak only",
      doText: "Tap Play and listen to the whole paragraph. No microphone is involved yet.",
      listenText: "Did you hear the words “marker one” at the very start? Is it loud enough over the engine?",
      action: { label: "▶ Play paragraph", fn: playParagraph },
      marks: ["Heard, clear", "Heard, too quiet", "First word clipped", "Heard nothing"],
    },
    {
      id: "miclive", meta: "Test 3 of 5 — the decisive one", title: "Microphone on, then speak",
      doText: "Tap Start. The microphone turns on first, then the same paragraph plays — the order the real lesson loop uses.",
      listenText: "Two things at once. Is the voice still audible now the mic is live — quieter, " +
        "or coming from the earpiece? On Bluetooth, did the car switch source or show a call? " +
        "And separately: audio has now played, so if the mic opened in test 1 but not here, " +
        "that is the after-playback bug rather than anything about routing.",
      action: { label: "▶ Mic on, then play", fn: micThenPlay },
      marks: ["Heard, same as test 1", "Heard, but quieter", "Came from earpiece", "Heard nothing", "Car switched source"],
    },
    {
      id: "holdpnr", meta: "Test 4 of 5", title: "Hold the session, then speak",
      doText: "Tap Start. This pins the audio session to play-and-record before speaking — the “treat it as a phone call” mitigation.",
      listenText: "Same question as test 2. If this one is audible but test 2 was not, holding the session is the fix and Phase 2 has a path.",
      action: { label: "▶ Hold session, then play", fn: holdThenPlay },
      marks: ["Heard, clear", "Heard, but quieter", "Came from earpiece", "Heard nothing", "Car switched source"],
    },
    {
      id: "loop", meta: "Test 5 of 5", title: "Recognition restart loop",
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
      doText: "Save the run. It uploads straight to the server if the tailnet is reachable; otherwise it downloads to Files. Do this before switching modes — iOS may not share storage between Safari and the home-screen app.",
      action: { label: "⬆ Save this run", fn: saveRun },
      requireSaved: true,
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
    if (step.requireSaved) return S.saved;
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

    if (S.srError) {
      var box = document.createElement("div");
      box.className = "srerror" + (S.srError.benign ? " benign" : "");
      var h2 = document.createElement("strong");
      h2.textContent = (S.srError.benign ? "Microphone: " : "Microphone failed: ") + S.srError.error;
      box.appendChild(h2);
      if (S.srError.message) {
        var m = document.createElement("div");
        m.className = "srerror-raw";
        m.textContent = S.srError.message;
        box.appendChild(m);
      }
      var help = document.createElement("div");
      help.textContent = SR_ERROR_HELP[S.srError.error] || "Unrecognised error code.";
      box.appendChild(help);
      if (BROWSER.thirdParty) {
        var bb = document.createElement("div");
        bb.className = "srerror-raw";
        bb.textContent = "You are in " + BROWSER.name + ". Reopen this page in Safari.";
        box.appendChild(bb);
      }
      stage.appendChild(box);
    }

    if (step.action) {
      var ab = document.createElement("button");
      ab.className = "big " + (S.running ? "stop" : "go");
      ab.textContent = S.running ? step.action.stopLabel : step.action.label;
      ab.onclick = function () {
        if (S.running) {
          step.action.stopFn();
          S.running = false;
        } else {
          S.srError = null;          // a fresh attempt gets a fresh verdict
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
          S.runMarks[step.id] = m;
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
      nb.onclick = finishHighway;
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
    renderResults();
  }

  function disabledReason(step) {
    if (step.routePicker) return "Pick a route first — every log line is tagged with it.";
    if (step.requireSaved) return "Save the run first — it uploads to the server, or downloads if that is unreachable.";
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

  function resetStep() { S.marked = null; S.acted = false; S.running = false; S.saved = false; }

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
      "Run whichever routes you actually have, in ONE mode. The other mode needs a " +
      "single run, just to establish whether recognition exists there at all. " +
      "Routes left as \u2014 are recorded as untested, not as failures."
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

  // --- verdict -------------------------------------------------------------
  function modeName(m) { return m === "pwa" ? "home-screen app" : "tab"; }
  function runLabel(r) {
    return routeName(r.route) + " / " + (r.browser || "unknown browser") + ", " + modeName(r.mode);
  }
  function heardAt(marks, stepId) { return !!(marks && marks[stepId]) && /^Heard/.test(marks[stepId]); }

  /** Plain-language reading of every completed run. This is the thing to act
   *  on — the raw log is for fixtures, not for decisions. */
  function buildVerdict() {
    if (!STORE.runs.length) return null;
    var lines = [];

    // Keyed by browser AND mode: "recognition present in a tab" is meaningless
    // without saying which browser's tab.
    var modes = {};
    STORE.runs.forEach(function (r) {
      var k = (r.browser || "unknown browser") + ", " + modeName(r.mode);
      if (modes[k] === undefined) modes[k] = r.hasSR;
    });
    Object.keys(modes).forEach(function (k) {
      lines.push("Recognition interface " + (modes[k] ? "present" : "MISSING") + " in " + k +
        (/Chrome|Firefox|Edge|Opera/.test(k) ? " (but unusable there — see below)" : "") + ".");
    });

    var invalid = STORE.runs.filter(function (r) { return r.thirdPartyBrowser; });
    if (invalid.length) {
      lines.push(invalid.length + " run(s) were recorded in a third-party iOS browser, " +
        "where recognition cannot work — their microphone results are not evidence.");
    }

    var opened = STORE.runs.filter(function (r) { return r.micOpened; });
    lines.push(opened.length
      ? "Microphone opened on: " + opened.map(runLabel).join(", ") + "."
      : "The microphone never opened on any run (no audiostart event).");

    var live = STORE.runs.filter(function (r) { return heardAt(r.marks, "miclive"); });
    var held = STORE.runs.filter(function (r) {
      return !heardAt(r.marks, "miclive") && heardAt(r.marks, "holdpnr");
    });
    lines.push(live.length
      ? "Voice survived a live mic on: " + live.map(runLabel).join(", ") + "."
      : "No route tested kept the voice audible with the mic live.");
    if (held.length) {
      lines.push("Holding play-and-record rescued: " + held.map(runLabel).join(", ") + ".");
    }
    // Name the failures explicitly — "survived on X" alone leaves the reader to
    // infer what was tried and lost, which is the half that decides Phase 2.
    var failed = STORE.runs.filter(function (r) {
      return !heardAt(r.marks, "miclive") && !heardAt(r.marks, "holdpnr");
    });
    if (failed.length) {
      lines.push("Voice did NOT survive on: " + failed.map(runLabel).join(", ") + ".");
    }

    STORE.runs.forEach(function (r) {
      if (r.deaf) {
        lines.push(runLabel(r) + " — deaf window median " + r.deaf.median +
          "ms, worst " + r.deaf.worst + "ms over " + r.deaf.n + " restarts.");
      }
    });

    Object.keys(STORE.highway).forEach(function (route) {
      var h = STORE.highway[route];
      lines.push("At speed on " + routeName(route) + ": " + (h.mark || "unmarked") +
        (h.deaf ? " (deaf window median " + h.deaf.median + "ms)" : "") + ".");
    });

    var tried = {};
    STORE.runs.forEach(function (r) { tried[r.route] = true; });
    var untested = ROUTES.filter(function (r) { return !tried[r.id]; });
    if (untested.length) {
      lines.push("Not tested: " + untested.map(function (r) { return r.name; }).join(", ") + ".");
    }

    var anySR = Object.keys(modes).some(function (m) { return modes[m]; });
    var call;
    if (BROWSER.thirdParty || (invalid.length && invalid.length === STORE.runs.length)) {
      call = "CALL: none of this settles anything about recognition — it was all recorded in a " +
        "browser that cannot use it. Reopen in Safari and re-run. The audio results above still stand.";
    } else if (!anySR) {
      call = "CALL: recognition is unavailable — two-way is dead. Build the one-way listening mode.";
    } else if (live.length) {
      call = "CALL: browser-native two-way survives. Phase 2 can take the free path on " +
        live.map(runLabel).join(" or ") + ".";
    } else if (held.length) {
      call = "CALL: only the held-session model works, which forces TTS onto AudioContext " +
        "and therefore paid cloud bytes. Decide before building.";
    } else {
      call = "CALL: browser-native two-way failed on every route tested." +
        (untested.length
          ? " Try " + untested.map(function (r) { return r.name; }).join(" or ") +
            " before concluding — an untested route is not a failed one, and it is far " +
            "cheaper than committing to a paid TTS vendor."
          : " The choice is paid cloud TTS through AudioContext, or one-way.");
    }
    lines.push(call);
    return lines;
  }

  function renderResults() {
    var box = el("results");
    var lines = buildVerdict();
    box.innerHTML = "";
    if (!lines) { box.style.display = "none"; return; }
    box.style.display = "";
    var t = document.createElement("div");
    t.className = "stepmeta"; t.textContent = "What the runs say so far";
    box.appendChild(t);
    lines.forEach(function (line) {
      var p = document.createElement("p");
      p.className = "verdict-line" + (/^CALL:/.test(line) ? " call" : "");
      p.textContent = line;
      box.appendChild(p);
    });
    var b = document.createElement("button");
    b.className = "mini";
    b.textContent = "Copy summary";
    b.onclick = function () {
      var text = "Audio spike — " + new Date().toISOString().slice(0, 10) + "\n" +
        lines.map(function (l) { return "- " + l; }).join("\n");
      if (navigator.clipboard) navigator.clipboard.writeText(text).then(
        function () { b.textContent = "Copied"; },
        function () { b.textContent = "Copy failed"; }
      );
    };
    box.appendChild(b);
  }

  // --- export / finish -----------------------------------------------------
  function runPayload() {
    return {
      build: BUILD, mode: MODE, route: S.route,
      browser: BROWSER.name, thirdParty: BROWSER.thirdParty,
      hasSR: !!SR, micOpened: S.micOpened,
      startedAt: new Date(t0).toISOString(),
      marks: S.runMarks,
      deafWindows: deafWindows,
      events: S.log,
    };
  }

  function downloadRun(payload) {
    var blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
    var a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "audio-spike-" + (S.route || "unset") + "-" + MODE + ".json";
    a.click();
    S.saved = true;
    rec("downloaded");
    render();
  }

  /** Upload to the server so the log lands in the data root; fall back to a
   *  download when the tailnet isn't reachable from the road. Either one
   *  satisfies the step gate, so a finished run is never lost. */
  function saveRun() {
    var payload = runPayload();
    rec("uploading…");
    fetch("/api/spike/run", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    }).then(function (res) {
      if (!res.ok) throw new Error("HTTP " + res.status);
      return res.json();
    }).then(function (j) {
      S.saved = true;
      rec("UPLOADED", j.saved || "ok");
      render();
    }).catch(function (e) {
      rec("upload failed — downloading instead", String(e && e.message));
      downloadRun(payload);
    });
  }

  function finishRun() {
    // Replace any earlier attempt at the same route+mode rather than stacking.
    STORE.runs = STORE.runs.filter(function (r) { return !(r.route === S.route && r.mode === MODE); });
    STORE.runs.push({
      route: S.route, mode: MODE, hasSR: !!SR,
      marks: S.runMarks, deaf: deafStats(), micOpened: S.micOpened,
      browser: BROWSER.name, thirdPartyBrowser: BROWSER.thirdParty,
      at: new Date().toISOString(),
    });
    persist();
    rec("RUN COMPLETE", S.route + "|" + MODE);
    S.stepIndex = 0;
    S.route = null;
    S.runMarks = {};
    S.micOpened = false;
    deafWindows = [];
    resetStep();
    render();
  }

  function finishHighway() {
    saveRun(); // same upload-then-download path; the transcript is the payload
    STORE.highway[S.route] = {
      mark: S.marked, deaf: deafStats(), at: new Date().toISOString(),
    };
    persist();
    highwayMode = false;
    S.runMarks = {};
    deafWindows = [];
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
    S.log = []; S.route = null; S.stepIndex = 0; S.runMarks = {};
    STORE = { runs: [], highway: {} };
    deafWindows = []; resetStep();
    el("log").textContent = ""; el("count").textContent = "(0)";
    persist(); render();
  };

  // --- go ------------------------------------------------------------------
  loadStore();
  describeEnv();
  if (window.speechSynthesis) rec("tts.voices at load", { count: speechSynthesis.getVoices().length });
  render();
})();
