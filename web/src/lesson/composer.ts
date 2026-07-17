import { h, clear } from "../dom.js";
import { api } from "../api.js";
import type { OutgoingImage } from "../api.js";
import type { LessonCtx } from "./ctx.js";
import { showBanner } from "./ctx.js";
import { addBubble, scrollDown } from "./bubbles.js";
// Demo-mode-only pre-fill wiring. Referenced only inside `if (__DEMO__)`
// blocks below, so the live build's dead-code elimination drops both these
// bindings and the whole replay module they come from.
import { nextLearnerLine, onDemoIdle } from "../demo/replay.js";

// ---------------------------------------------------------------------------
// The input row: textarea auto-grow, image attach + client-side downscale,
// send.
// ---------------------------------------------------------------------------

function isTouchDevice(): boolean {
  return matchMedia("(pointer: coarse)").matches;
}

/**
 * Downscale a picked photo to ≤1568 px on the long edge and re-encode as
 * JPEG (~0.8) — token and upload cost control; full-resolution camera shots
 * are wasted on the model anyway.
 */
async function downscaleImage(file: File): Promise<{ out: OutgoingImage; preview: string }> {
  const bitmap = await createImageBitmap(file);
  const scale = Math.min(1, 1568 / Math.max(bitmap.width, bitmap.height));
  const w = Math.max(1, Math.round(bitmap.width * scale));
  const hpx = Math.max(1, Math.round(bitmap.height * scale));
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = hpx;
  canvas.getContext("2d")!.drawImage(bitmap, 0, 0, w, hpx);
  bitmap.close();
  const dataUrl = canvas.toDataURL("image/jpeg", 0.8);
  return {
    out: { media_type: "image/jpeg", data: dataUrl.slice(dataUrl.indexOf(",") + 1) },
    preview: dataUrl,
  };
}

export interface ComposerEls {
  chipRow: HTMLElement;
  composer: HTMLElement;
}

/** Builds the composer row and its attachment chip strip, and wires them up. */
export function buildComposer(ctx: LessonCtx): ComposerEls {
  const input = h("textarea", {
    class: "composer-input",
    placeholder: "Message…",
    rows: "1",
  }) as HTMLTextAreaElement;

  // Demo mode: the composer is always pre-filled with the next learner line
  // from the recording. The visitor can edit it, but sending always advances
  // the script on the canned line underneath (see demo/replay.ts).
  const growInput = () => {
    input.style.height = "auto";
    input.style.height = `${Math.min(input.scrollHeight, 160)}px`;
  };
  if (__DEMO__) {
    const fill = () => {
      input.value = nextLearnerLine() ?? "";
      growInput();
    };
    fill();
    onDemoIdle(fill);
  }

  const sendBtn = h("button", { class: "composer-send" }, "↑") as HTMLButtonElement;
  // Photo attachments: picked → downscaled client-side → chip preview → sent
  // as base64 with the next message. `capture` hint keeps phone cameras easy.
  const fileInput = h("input", {
    type: "file",
    accept: "image/*",
    capture: "environment",
    multiple: "",
    class: "hidden",
  }) as HTMLInputElement;
  const attachBtn = h(
    "button",
    { class: "composer-attach", onclick: () => fileInput.click() },
    "+"
  ) as HTMLButtonElement;
  const chipRow = h("div", { class: "attach-chips hidden" });
  const pendingImages: { out: OutgoingImage; preview: string }[] = [];
  const MAX_ATTACH = 4;

  const refreshChips = () => {
    clear(chipRow);
    chipRow.classList.toggle("hidden", pendingImages.length === 0);
    pendingImages.forEach((p, i) => {
      chipRow.append(
        h(
          "span",
          { class: "attach-chip" },
          h("img", { src: p.preview, alt: "attachment" }),
          h(
            "button",
            {
              class: "attach-x",
              onclick: () => {
                pendingImages.splice(i, 1);
                refreshChips();
              },
            },
            "×"
          )
        )
      );
    });
  };

  fileInput.addEventListener("change", async () => {
    const files = [...(fileInput.files ?? [])];
    fileInput.value = "";
    for (const f of files) {
      if (pendingImages.length >= MAX_ATTACH) break;
      try {
        pendingImages.push(await downscaleImage(f));
      } catch {
        showBanner(ctx, `Couldn't read ${f.name} as an image.`);
      }
    }
    refreshChips();
  });

  const composer = h("div", { class: "composer" }, attachBtn, fileInput, input, sendBtn);

  async function send(text: string): Promise<void> {
    const trimmed = text.trim();
    const images = pendingImages.splice(0, pendingImages.length);
    refreshChips();
    if (!trimmed && images.length === 0) return;
    addBubble(ctx, "user", trimmed, images.map((p) => p.preview));
    ctx.renderedCount++; // the server persists this user turn to the transcript
    ctx.lesson.ending = false; // chatting on means we're no longer just wrapping up
    ctx.endingHint.classList.add("hidden");
    ctx.thinking.classList.remove("hidden");
    scrollDown(ctx, true);
    try {
      await api.sendMessage(ctx.id, trimmed, images.map((p) => p.out));
    } catch (e) {
      ctx.thinking.classList.add("hidden");
      // The attachments weren't delivered — put them back in the composer.
      pendingImages.push(...images);
      refreshChips();
      showBanner(ctx, `Couldn't send: ${(e as Error).message}`);
    }
  }

  const submit = () => {
    const v = input.value;
    input.value = "";
    input.style.height = "auto";
    void send(v);
  };
  sendBtn.addEventListener("click", submit);
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey && !isTouchDevice()) {
      e.preventDefault();
      submit();
    }
  });
  input.addEventListener("input", () => {
    input.style.height = "auto";
    input.style.height = `${Math.min(input.scrollHeight, 160)}px`;
  });

  return { chipRow, composer };
}
