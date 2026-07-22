import React, { useEffect, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { events } from "@/bindings";

type GhostState = "hidden" | "listening" | "processing";

interface GhostStatePayload {
  state: string;
  font_px: number;
}

/**
 * Caret-anchored ghost preview: renders the live streaming transcription at
 * ~50% opacity where the text will be pasted, then a spinning star while
 * transcription/post-processing runs. The window is transparent and
 * click-through; font size is provided by the backend, matched to the
 * destination field's caret height so the preview lines up with real text.
 */
export const GhostPreview: React.FC = () => {
  const [state, setState] = useState<GhostState>("hidden");
  const [fontPx, setFontPx] = useState(15);
  const [committed, setCommitted] = useState("");
  const [tentative, setTentative] = useState("");
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const unlisteners: Promise<() => void>[] = [];

    unlisteners.push(
      listen<GhostStatePayload>("ghost-state", (event) => {
        const next = event.payload.state as GhostState;
        setState(next);
        if (event.payload.font_px > 0) {
          setFontPx(event.payload.font_px);
        }
        if (next === "hidden" || next === "listening") {
          // Fresh dictation (or teardown): drop any stale preview text.
          setCommitted("");
          setTentative("");
        }
      }),
    );

    unlisteners.push(
      events.streamTextEvent.listen((event) => {
        setCommitted(event.payload.committed);
        setTentative(event.payload.tentative);
      }),
    );

    return () => {
      unlisteners.forEach((p) => {
        p.then((unlisten) => unlisten()).catch(() => {});
      });
    };
  }, []);

  // Keep the tail (latest words) visible: the preview hugs the caret line and
  // older words scroll out to the left.
  useEffect(() => {
    const el = scrollRef.current;
    if (el) {
      el.scrollLeft = el.scrollWidth;
    }
  }, [committed, tentative]);

  if (state === "hidden") {
    return null;
  }

  const text = `${committed}${tentative}`;

  return (
    <div
      style={{
        width: "100%",
        height: "100%",
        display: "flex",
        alignItems: "center",
        pointerEvents: "none",
      }}
    >
      {state === "processing" ? (
        <span
          style={{
            display: "inline-block",
            fontSize: `${fontPx}px`,
            lineHeight: 1,
            opacity: 0.75,
            color: "#8b8b92",
            textShadow: "0 0 3px rgba(0,0,0,0.25)",
            animation: "ghost-spin 1.1s linear infinite",
          }}
        >
          {"✦"}
        </span>
      ) : (
        text.length > 0 && (
          <div
            ref={scrollRef}
            style={{
              maxWidth: "100%",
              overflow: "hidden",
              whiteSpace: "nowrap",
              fontFamily:
                "'Segoe UI', system-ui, -apple-system, 'Helvetica Neue', sans-serif",
              fontSize: `${fontPx}px`,
              lineHeight: 1.25,
              color: "#8b8b92",
              opacity: 0.55,
              textShadow: "0 0 3px rgba(0,0,0,0.2)",
            }}
          >
            {text}
            <span
              style={{
                display: "inline-block",
                width: "2px",
                height: `${fontPx}px`,
                marginLeft: "2px",
                verticalAlign: "text-bottom",
                background: "#8b8b92",
                animation: "ghost-blink 1s steps(1) infinite",
              }}
            />
          </div>
        )
      )}
      <style>{`
        @keyframes ghost-spin {
          from { transform: rotate(0deg); }
          to { transform: rotate(360deg); }
        }
        @keyframes ghost-blink {
          0%, 60% { opacity: 1; }
          61%, 100% { opacity: 0; }
        }
      `}</style>
    </div>
  );
};
