// ---------------------------------------------------------------------------
// The drive overlay (J's design, docs/drive-mode.md): the whole screen is
// one tap target whose meaning follows the phase — speaking → skip,
// listening → done, paused → resume, thinking → a spoken status line. A big
// state word and hint; while listening, the words heard so far. Again and
// Exit in the corners — no End: on the road the move is "stop here, carry on
// later", and an End beside an ✕ read as the same thing (two End taps, then
// ✕, on the first real run). Ending stays a text-mode action. A collapsed
// debug strip at the bottom holds the build id, the wake-lock dot, voice and
// speed, the pre-drive check, and the live diag tail — for use while parked.
//
// DOM only: every decision is the controller's (and the state machine's).
// ---------------------------------------------------------------------------

import { h, clear } from "../../dom.js";
import type { DriveSnapshot, Phase } from "./drive-state.js";
import type { DiagRecord } from "./diag.js";
import { defaultVoice, type SpeechSettings } from "./adapter.js";

export interface PanelHandlers {
  tap(): void;
  again(): void;
  exit(): void;
  check(): void;
  settings(s: SpeechSettings): void;
}

export interface PanelExtras {
  wakeLock: boolean;
  checking: boolean;
  checkLines: string[];
}

const LABELS: Record<Phase, [string, string]> = {
  off: ["", ""],
  speaking: ["SPEAKING", "tap to skip"],
  listening: ["LISTENING", "tap when you're done"],
  waiting: ["THINKING", "tap for status"],
  paused: ["PAUSED", "tap to resume"],
  stuck: ["STUCK", "tap to retry"],
  done: ["COMMITTED", "lesson saved · Exit to close"],
  blocked: ["MIC BLOCKED", "Safari didn't allow the microphone"],
};

const RATES = [0.9, 1, 1.1, 1.2];

export class DrivePanel {
  readonly el: HTMLElement;
  private state = h("div", { class: "drive-state" });
  private hint = h("div", { class: "drive-hint" });
  // The newest words stay in view: the box is bottom-anchored and clips the
  // oldest lines off the top (a long answer used to push the newest words
  // off the screen while J was still saying them).
  private heardText = h("span", {});
  private heard = h("div", { class: "drive-heard" }, this.heardText);
  // Shown only while the mic is blocked. Its click bubbles to the overlay's
  // tap, which in that state reloads — one tap target, a visible label.
  private reloadBtn = h("button", { class: "drive-reload hidden" }, "Reload");
  private stripLabel = h("span", {});
  private debug = h("div", { class: "drive-debug hidden" });
  private debugBody = h("pre", { class: "drive-debug-body" });
  private checkOut = h("div", { class: "drive-check" });
  private voiceSel = h("select", { class: "drive-select" }) as HTMLSelectElement;
  private rateSel = h("select", { class: "drive-select" }) as HTMLSelectElement;
  private tonesBox = h("input", { type: "checkbox" }) as HTMLInputElement;
  private playbackBox = h("input", { type: "checkbox" }) as HTMLInputElement;
  private expanded = false;

  constructor(
    private handlers: PanelHandlers,
    private build: string,
    private settings: SpeechSettings
  ) {
    // Controls inside the overlay must not also count as the big tap.
    const own = (fn: () => void) => (e: Event) => {
      e.stopPropagation();
      fn();
    };
    const corner = (label: string, cls: string, fn: () => void) =>
      h("button", { class: `drive-corner ${cls}`, onclick: own(fn) }, label);

    for (const r of RATES) {
      this.rateSel.append(h("option", { value: String(r) }, `${r}×`));
    }
    this.rateSel.value = String(settings.rate);
    this.tonesBox.checked = settings.tones;
    this.playbackBox.checked = settings.sessionPlayback;
    const emitSettings = () => {
      this.settings = {
        voiceURI: this.voiceSel.value || null,
        rate: Number(this.rateSel.value),
        tones: this.tonesBox.checked,
        sessionPlayback: this.playbackBox.checked,
      };
      this.handlers.settings(this.settings);
    };
    this.voiceSel.addEventListener("change", emitSettings);
    this.rateSel.addEventListener("change", emitSettings);
    this.tonesBox.addEventListener("change", emitSettings);
    this.playbackBox.addEventListener("change", emitSettings);

    this.debug.append(
      h(
        "div",
        { class: "drive-settings" },
        h("label", {}, "Voice ", this.voiceSel),
        h("label", {}, "Speed ", this.rateSel),
        h("label", {}, this.tonesBox, " Tones (off: short spoken cues)"),
        h(
          "label",
          {},
          this.playbackBox,
          " Playback mode while speaking (experiment: steadier volume; on Bluetooth, music audio instead of call audio)"
        ),
        h("button", { class: "drive-check-btn", onclick: own(() => this.handlers.check()) }, "Run pre-drive check"),
        h(
          "div",
          { class: "drive-note" },
          "Phone speaker works best — Bluetooth switches the car's audio source and sounds worse."
        )
      ),
      this.checkOut,
      this.debugBody
    );
    // Stop clicks anywhere in the expanded area from reaching the tap target.
    this.debug.addEventListener("click", (e) => e.stopPropagation());

    const strip = h(
      "button",
      {
        class: "drive-strip",
        onclick: own(() => {
          this.expanded = !this.expanded;
          this.debug.classList.toggle("hidden", !this.expanded);
          this.el.classList.toggle("expanded", this.expanded);
        }),
      },
      this.stripLabel
    );

    this.el = h(
      "div",
      { class: "drive-overlay", role: "button", "aria-label": "Drive mode" },
      h(
        "div",
        { class: "drive-top" },
        corner("↺ Again", "left", () => this.handlers.again()),
        h("span", { class: "drive-spacer" }),
        corner("✕ Exit drive mode", "", () => this.handlers.exit())
      ),
      h("div", { class: "drive-center" }, this.state, this.hint, this.heard, this.reloadBtn),
      strip,
      this.debug
    );
    this.el.addEventListener("click", () => this.handlers.tap());
  }

  mount(): void {
    if (!this.el.isConnected) document.body.append(this.el);
  }

  unmount(): void {
    this.el.remove();
  }

  /**
   * Fill the voice picker once voices are known (they may load late). The
   * first entry is the default voice (Samantha) by name — there is no
   * "automatic" entry: the automatic pick kept landing on novelty voices.
   */
  setVoices(voices: SpeechSynthesisVoice[], chosen: string | null): void {
    clear(this.voiceSel);
    const def = defaultVoice(voices);
    this.voiceSel.append(h("option", { value: "" }, def ? `${def.name} (${def.lang}) — default` : "Browser default"));
    for (const v of voices.filter((x) => /^en(-|_|$)/i.test(x.lang) && x !== def)) {
      this.voiceSel.append(h("option", { value: v.voiceURI }, `${v.name} (${v.lang})`));
    }
    // A saved choice of the default voice itself shows as the default entry.
    this.voiceSel.value = chosen && chosen !== def?.voiceURI ? chosen : "";
    // A saved voice that's no longer installed: show the default actually used.
    if (this.voiceSel.selectedIndex === -1) this.voiceSel.value = "";
  }

  render(snap: DriveSnapshot, extras: PanelExtras): void {
    const phase = snap.phase;
    this.el.dataset.phase = extras.checking ? "checking" : phase;
    if (extras.checking) {
      this.state.textContent = "CHECKING";
      this.hint.textContent = "pre-drive check — listen";
    } else {
      const [word, hint] = LABELS[phase];
      this.state.textContent = phase === "waiting" && !snap.turnInFlight ? "GETTING READY" : word;
      this.hint.textContent = hint;
    }
    this.reloadBtn.classList.toggle("hidden", extras.checking || phase !== "blocked");
    const heard = phase === "listening" && snap.heard ? `“${snap.heard}”` : "";
    if (this.heardText.textContent !== heard) {
      this.heardText.textContent = heard;
      // Fade the top edge only once the oldest words are actually clipped.
      this.heard.classList.toggle("clipped", this.heardText.offsetHeight > this.heard.clientHeight + 1);
    }
    this.stripLabel.textContent = `${this.expanded ? "▾" : "▸"} debug · ${this.build} · wake ${extras.wakeLock ? "●" : "○"}`;
    clear(this.checkOut);
    for (const line of extras.checkLines) this.checkOut.append(h("div", {}, line));
  }

  /** The debug tail — only drawn while expanded, so it costs nothing while driving. */
  renderDebug(snap: DriveSnapshot, counters: Readonly<Record<string, number>>, recent: DiagRecord[]): void {
    if (!this.expanded) return;
    const notable = Object.entries(counters)
      .filter(([k]) => k.startsWith("anomaly:") || k.startsWith("invariant:"))
      .map(([k, v]) => `${k} ×${v}`);
    const lines = [
      `phase=${snap.phase} mode=${snap.mode} turn=${snap.turnInFlight} rec=${snap.rec} listening=${snap.listening} ep=${snap.endpoint} queued=${snap.queued}`,
      notable.length ? `!! ${notable.join("  ")}` : "no anomalies",
      "",
      ...recent.map(
        (r) =>
          `${(r.t / 1000).toFixed(1).padStart(7)} ${r.level === "info" ? " " : "!"} ${r.kind}${
            r.detail === undefined ? "" : " " + JSON.stringify(r.detail).slice(0, 140)
          }`
      ),
    ];
    this.debugBody.textContent = lines.join("\n");
  }
}
