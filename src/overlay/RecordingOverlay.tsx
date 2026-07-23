import { listen } from "@tauri-apps/api/event";
import React, { useEffect, useLayoutEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import "./RecordingOverlay.css";
import { commands, events } from "@/bindings";
import type {
  StreamPhase,
  StreamPhaseEvent,
  StreamTextEvent,
  StreamWorkKind,
} from "@/bindings";
import i18n, { syncLanguageFromSettings } from "@/i18n";
import { getLanguageDirection } from "@/lib/utils/rtl";

type OverlayState = "recording" | "streaming" | "transcribing" | "processing";

// Number of reactive bars in the waveform (the simple, smoothed style shared by
// every overlay form). Mic levels arrive as 16 FFT buckets; we take the first N.
const WAVE_BARS = 9;

const RecordingOverlay: React.FC = () => {
  const { t } = useTranslation();
  const [isVisible, setIsVisible] = useState(false);
  const [state, setState] = useState<OverlayState>("recording");
  const [levels, setLevels] = useState<number[]>(Array(WAVE_BARS).fill(0));
  const [streamText, setStreamText] = useState<StreamTextEvent>({
    committed: "",
    tentative: "",
  });
  const [phase, setPhase] = useState<StreamPhase>("listening");
  const [workKind, setWorkKind] = useState<StreamWorkKind>("transcribing");
  const [elapsed, setElapsed] = useState(0);
  // Bumped on each new streaming session so the Live card remounts fresh (replays
  // the pop-in, and never animates in from the previous panel's open size).
  const [session, setSession] = useState(0);
  // Overlay placement (top vs bottom of the screen). The Live panel grows downward
  // from a top overlay (oldest line under the pill) and upward from a bottom one.
  const [position, setPosition] = useState<"top" | "bottom">("bottom");
  // True once live text overflows the cap. A top overlay fades its top edge only
  // while overflowing, so the resting first line stays crisp flush under the pill.
  const [overflowing, setOverflowing] = useState(false);
  // Preview editing: clicking the live text turns it into an editable box.
  // The edited version is sent to the backend and treated as authoritative
  // guidance for the AI cleanup of the final transcription.
  const [editing, setEditing] = useState(false);
  const [editText, setEditText] = useState("");
  const editRef = useRef<HTMLTextAreaElement>(null);
  // Drum preview: the live text is split into measured visual lines, each
  // rendered as its own element so it can rotate like a segment of a picker
  // wheel (iOS-clock style) as it rides up. `tentativeFrom` marks where the
  // tentative (dimmer) region starts inside a line, or null if fully
  // committed.
  const [lines, setLines] = useState<
    { text: string; tentativeFrom: number | null }[]
  >([]);
  const measureRef = useRef<HTMLDivElement>(null);
  const lineRefs = useRef<(HTMLDivElement | null)[]>([]);

  const smoothedLevelsRef = useRef<number[]>(Array(16).fill(0));
  // Live-text scroll-back: the text region "sticks" to the newest line while the
  // user is at the bottom; if they scroll up to read history, auto-follow pauses
  // until they scroll back down.
  const capRef = useRef<HTMLDivElement>(null);
  const pinnedRef = useRef(true);
  const direction = getLanguageDirection(i18n.language);

  useEffect(() => {
    const setupEventListeners = async () => {
      const unlistenShow = await listen("show-overlay", async (event) => {
        await syncLanguageFromSettings();
        // The Live panel flows downward from a top overlay and upward from a
        // bottom one; read the placement so the layout can flip to match.
        try {
          const settings = await commands.getAppSettings();
          if (settings.status === "ok") {
            setPosition(
              settings.data.overlay_position === "top" ? "top" : "bottom",
            );
          }
        } catch {
          // Keep the previous/default placement if settings can't be read.
        }
        const overlayState = event.payload as OverlayState;
        setState(overlayState);
        if (overlayState === "recording" || overlayState === "streaming") {
          setStreamText({ committed: "", tentative: "" });
        }
        if (overlayState === "streaming") {
          setPhase("listening");
          setWorkKind("transcribing");
          setElapsed(0);
          setSession((s) => s + 1); // remount the card fresh for this session
        }
        setIsVisible(true);
      });

      const unlistenHide = await listen("hide-overlay", () => {
        setIsVisible(false);
        setEditing(false);
      });

      const unlistenLevel = await listen<number[]>("mic-level", (event) => {
        const newLevels = event.payload as number[];
        // Exponential smoothing across the 16 buckets, then take the first N
        // bars for the shared waveform.
        const smoothed = smoothedLevelsRef.current.map((prev, i) => {
          const target = newLevels[i] || 0;
          return prev * 0.7 + target * 0.3;
        });
        smoothedLevelsRef.current = smoothed;
        setLevels(smoothed.slice(0, WAVE_BARS));
      });

      const unlistenStream = await events.streamTextEvent.listen((event) => {
        setStreamText(event.payload);
      });

      const unlistenPhase = await events.streamPhaseEvent.listen((event) => {
        const payload: StreamPhaseEvent = event.payload;
        setPhase(payload.phase);
        if (payload.kind) setWorkKind(payload.kind);
      });

      return () => {
        unlistenShow();
        unlistenHide();
        unlistenLevel();
        unlistenStream();
        unlistenPhase();
      };
    };

    setupEventListeners();
  }, []);

  // Elapsed timer while the Live overlay is visible.
  useEffect(() => {
    if (state !== "streaming" || !isVisible) return;
    const id = setInterval(() => setElapsed((e) => e + 1), 1000);
    return () => clearInterval(id);
  }, [state, isVisible]);

  // Split the live text into visual lines by measuring words against the
  // panel width with a hidden element that inherits the same font.
  useLayoutEffect(() => {
    const measurer = measureRef.current;
    const cap = capRef.current;
    if (!measurer || !cap) {
      return;
    }
    // Engines can emit newlines and doubled spaces mid-transcript (Whisper
    // does after pauses); collapse all whitespace so a stray "\n" can't
    // render as a phantom line break inside a measured line.
    const committed = streamText.committed.replace(/\s+/g, " ").trim();
    const tentative = streamText.tentative.replace(/\s+/g, " ").trim();
    const joiner = committed && tentative ? " " : "";
    const full = `${committed}${joiner}${tentative}`;
    const maxWidth = cap.clientWidth - 4;
    const words = full.length ? full.split(" ") : [];
    const next: { text: string; tentativeFrom: number | null }[] = [];
    let line = "";
    let lineStart = 0;
    let cursor = 0; // index of the next word's first char within `full`
    const pushLine = () => {
      if (!line) return;
      const start = lineStart;
      const commLen = committed.length;
      let tentativeFrom: number | null = null;
      if (start + line.length > commLen) {
        tentativeFrom = Math.max(0, commLen - start);
      }
      next.push({ text: line, tentativeFrom });
    };
    for (const word of words) {
      const candidate = line ? `${line} ${word}` : word;
      measurer.textContent = candidate;
      if (line && measurer.offsetWidth > maxWidth) {
        pushLine();
        line = word;
        lineStart = cursor;
      } else {
        line = candidate;
      }
      cursor += word.length + 1; // +1 for the split-out space
    }
    pushLine();
    setLines(next);
  }, [streamText]);

  // Rotate each line by its distance from the newest (bottom) line, like the
  // face of a wheel seen edge-on: the focused line is flat, older lines lean
  // back and dim as they ride up over the top.
  const applyDrum = () => {
    const cap = capRef.current;
    if (!cap) return;
    const capRect = cap.getBoundingClientRect();
    const first = lineRefs.current.find(Boolean);
    const lineH = first?.offsetHeight || 18;
    const focusY = capRect.bottom - 12 - lineH / 2;
    for (const el of lineRefs.current) {
      if (!el) continue;
      const r = el.getBoundingClientRect();
      const dist = (focusY - (r.top + r.bottom) / 2) / lineH;
      const angle = Math.max(-20, Math.min(80, dist * 24));
      const depth = -Math.abs(dist) * 6;
      // Per-line perspective: the scroll container (overflow: auto) flattens
      // any ancestor 3D context, so each line carries its own vanishing point.
      el.style.transform = `perspective(300px) rotateX(${angle}deg) translateZ(${depth}px)`;
      el.style.opacity = String(
        Math.max(0.1, Math.cos((angle * Math.PI) / 180)),
      );
    }
  };

  // Stick to the bottom as text streams in — but only while pinned, so a user who
  // has scrolled up to read history isn't yanked back down by the next chunk.
  useLayoutEffect(() => {
    const el = capRef.current;
    if (!el) return;
    // Fade the top edge only once text actually overflows the cap.
    setOverflowing(el.scrollHeight > el.clientHeight + 1);
    if (pinnedRef.current) el.scrollTop = el.scrollHeight;
    applyDrum();
  }, [lines]);

  // Each fresh streaming session starts pinned to the bottom, fade cleared.
  useEffect(() => {
    pinnedRef.current = true;
    setOverflowing(false);
  }, [session]);

  // Re-pin when the user is within ~a line of the bottom; unpin otherwise.
  // Scrolling also re-solves the drum so lines rotate through the wheel live.
  const handleStreamScroll = () => {
    const el = capRef.current;
    if (!el) return;
    pinnedRef.current = el.scrollHeight - el.scrollTop - el.clientHeight <= 16;
    applyDrum();
  };

  const fmtTime = (s: number) =>
    `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;

  // ---- Preview editing ----
  const beginEdit = async () => {
    if (editing) return;
    setEditText(
      `${streamText.committed}${streamText.committed && streamText.tentative ? " " : ""}${streamText.tentative}`,
    );
    setEditing(true);
    try {
      await commands.beginPreviewEdit();
    } catch {
      // Focus grant failed — abandon the edit UI rather than a dead textbox.
      setEditing(false);
      return;
    }
    // Focus the box once it exists.
    setTimeout(() => editRef.current?.focus(), 60);
  };

  const finishEdit = async (confirmed: boolean) => {
    if (!editing) return;
    setEditing(false);
    try {
      await commands.submitPreviewEdit(confirmed ? editText : "");
    } catch {
      // Backend unavailable — nothing else to do from the overlay.
    }
  };

  // ---- Shared building blocks (one visual language for every overlay form) ----
  const waveform = (
    <div className="swave">
      {levels.map((v, i) => (
        <i
          key={i}
          style={{
            height: `${Math.max(3, Math.min(18, 3 + Math.pow(v, 0.7) * 15))}px`,
          }}
        />
      ))}
    </div>
  );

  const cancelBtn = (
    <button
      className="sx"
      aria-label="cancel"
      onClick={() => commands.cancelOperation()}
    >
      <svg viewBox="0 0 16 16" aria-hidden="true">
        <path
          d="M4 4 L12 12 M12 4 L4 12"
          stroke="currentColor"
          strokeWidth="1.6"
          strokeLinecap="round"
        />
      </svg>
    </button>
  );

  // dot (left) | waveform (center) | timer + cancel (right) — same structure for
  // pill & panel, so the Live morph is a pure width change.
  const listeningRow = (showTimer: boolean, showCancel: boolean) => (
    <div className="sbase">
      <div className="sbase-l">
        <span className="sdot" />
      </div>
      {waveform}
      <div className="sbase-r">
        {showTimer && <span className="stimer">{fmtTime(elapsed)}</span>}
        {showCancel && cancelBtn}
      </div>
    </div>
  );

  // star (left) | label (center) | cancel (right) — same 3-zone grid as the
  // listening row, so the label is centered.
  const workingRow = (label: string, showCancel: boolean) => (
    <div className="sbase">
      <div className="sbase-l">
        <span className="sstar" aria-hidden="true">
          {"✦"}
        </span>
      </div>
      <span className="swork-label">{label}</span>
      <div className="sbase-r">{showCancel && cancelBtn}</div>
    </div>
  );

  // ---- Live overlay: a pill that sculpts open into a panel ----
  if (state === "streaming") {
    const hasText =
      streamText.committed.length > 0 || streamText.tentative.length > 0;
    const working = phase === "working";
    // Keep the panel open whenever there's text — even while finalizing — so the
    // transcript stays put under a working spinner instead of collapsing and
    // squishing the text mid-stream. Only fall back to the small working pill
    // when there was no text to preserve.
    const open = hasText;
    const collapsed = working && !hasText;

    return (
      <div dir={direction} className={`ov-stage ${position}`}>
        <div
          key={session}
          className={`scard ${open ? "open" : ""} ${collapsed ? "working" : ""} ${
            isVisible ? "" : "leaving"
          }`}
        >
          <div className="stext">
            <div className="stext-clip">
              {editing ? (
                <textarea
                  ref={editRef}
                  className="sedit"
                  value={editText}
                  onChange={(e) => setEditText(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && !e.shiftKey) {
                      e.preventDefault();
                      finishEdit(true);
                    } else if (e.key === "Escape") {
                      e.preventDefault();
                      finishEdit(false);
                    }
                  }}
                  onBlur={() => finishEdit(true)}
                  spellCheck={false}
                />
              ) : (
                <div
                  className={`stext-cap ${overflowing ? "overflowing" : ""}`}
                  ref={capRef}
                  onScroll={handleStreamScroll}
                  onClick={beginEdit}
                >
                  {lines.map((line, i) => (
                    <div
                      key={i}
                      className="sline"
                      ref={(el) => {
                        lineRefs.current[i] = el;
                      }}
                    >
                      {line.tentativeFrom === null ? (
                        <span className="committed">{line.text}</span>
                      ) : (
                        <>
                          <span className="committed">
                            {line.text.slice(0, line.tentativeFrom)}
                          </span>
                          <span className="tentative">
                            {line.text.slice(line.tentativeFrom)}
                          </span>
                        </>
                      )}
                      {/* Drop the blinking caret once finalizing — it's no
                          longer capturing, and a static star conveys the work. */}
                      {i === lines.length - 1 && !working && (
                        <span className="scaret" />
                      )}
                    </div>
                  ))}
                  {lines.length === 0 && (
                    <div className="sline">
                      {!working && <span className="scaret" />}
                    </div>
                  )}
                  <div className="smeasure" ref={measureRef} aria-hidden />
                </div>
              )}
            </div>
          </div>
          {working
            ? workingRow(
                workKind === "polishing"
                  ? t("overlay.processing")
                  : t("overlay.transcribing"),
                true,
              )
            : listeningRow(open, true)}
        </div>
      </div>
    );
  }

  // ---- Minimal overlay: exactly one row at a time — waveform (recording), or a
  // spinner + label (transcribing / processing). Never both. The pill animates its
  // width between them; the cancel button is in both rows so it stays put.
  const working = state === "transcribing" || state === "processing";
  const workLabel =
    state === "processing"
      ? t("overlay.processing")
      : t("overlay.transcribing");

  return (
    <div
      dir={direction}
      className={`ov-stage ${position} ov-fade ${isVisible ? "show" : ""}`}
    >
      <div
        className={`scard compact ${working && isVisible ? "cworking" : ""}`}
      >
        {working ? workingRow(workLabel, true) : listeningRow(false, true)}
      </div>
    </div>
  );
};

export default RecordingOverlay;
