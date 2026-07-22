# Handy — with Vibecoded Features

A heavily customized fork of [Handy](https://github.com/cjpais/Handy) by CJ Pais: a free, open-source speech-to-text app that runs entirely on your own machine. This fork keeps everything Handy does and layers on a local-LLM cleanup pipeline, context-aware tone adaptation, live in-overlay preview, and a pile of quality-of-life and stability fixes — all developed conversationally ("vibecoded") with Claude Code.

> **Windows x86_64 only.** Upstream Handy is cross-platform, but this fork is developed and tested exclusively on Windows (x86_64) — several of its headline features (app/website detection, caret probing, smart spacing, the clipboard fallback) are built on Windows UI Automation and have no macOS/Linux implementation. CI builds Windows x86_64 only. If you're on another platform, use [upstream Handy](https://github.com/cjpais/Handy) instead.

Upstream documentation is preserved in [README.upstream.md](README.upstream.md). Everything below documents what this fork adds or changes.

---

## Table of Contents

- [Feature Overview](#feature-overview)
- [AI Cleanup Pass (Post-Processing)](#ai-cleanup-pass-post-processing)
- [Context-Aware Tone](#context-aware-tone)
- [Tone Presets](#tone-presets)
- [Live Preview Overlay](#live-preview-overlay)
- [Dual-Model Preview Mode](#dual-model-preview-mode)
- [Editable Preview](#editable-preview)
- [Model Recommendations](#model-recommendations)
- [Cleanup Model Management](#cleanup-model-management)
- [Smart Paste Spacing](#smart-paste-spacing)
- [Stability Fixes](#stability-fixes)
- [Building This Fork (Windows)](#building-this-fork-windows)
- [Architecture Notes](#architecture-notes)
- [Credits and License](#credits-and-license)

---

## Feature Overview

| Feature                 | What it does                                                                                                                  |
| ----------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| AI cleanup pass         | Every transcription can be cleaned by a local LLM (Ollama): filler removed, grammar fixed, numbers converted, lists formatted |
| Change-of-mind handling | "at 4, wait no, at 3" comes out as "at 3" — the prompt was tuned by automated tournaments against real revision phrasings     |
| Context-aware tone      | Detects the app _and website_ you're dicting into and adapts tone (casual for Discord, formal for Gmail, etc.)                |
| Tone presets            | Six tones from casual to technical, each with its own editable embedded prompt                                                |
| Live preview            | Words appear in the overlay as you speak, with a spinning star while the cleanup model polishes the final text                |
| Dual-model preview      | A fast streaming model drives the instant preview while your accurate model transcribes the real thing in parallel            |
| Editable preview        | Click the live preview text to edit it mid-dictation; your edit steers the final AI cleanup                                   |
| Model recommendations   | The Models tab recommends models for _your machine_, for accuracy, and for speed, with a language filter                      |
| Smart spacing           | Pasting right after a period automatically inserts a space first                                                              |
| Tray robustness         | The app keeps working after the window is closed, with a hook watchdog and single-instance hardening                          |

---

## AI Cleanup Pass (Post-Processing)

The core addition. After transcription, the text is sent to a local LLM served by [Ollama](https://ollama.com) (OpenAI-compatible endpoint on `localhost:11434`), which:

1. Deletes filler ("um", "uh", "so yeah", stutters, repeated words)
2. Applies the speaker's **final intent** when they change their mind mid-sentence — revision cues like "wait", "no", "actually", "never mind", "scratch that", and "make that" are recognized, the abandoned wording is removed, and the final version is applied **with the smallest possible edit**: your sentence shapes and hedges ("I think", "maybe") are preserved, questions stay questions, and the model is forbidden from inventing phrasings you didn't say
3. Collapses restated details ("at 5 p.m., from 5 to 6 p.m." becomes "from 5 to 6 p.m.")
4. Fixes spelling, grammar, capitalization, and punctuation; guarantees terminal punctuation
5. Converts spoken numbers to digits ("twenty-five" → 25, "four pm" → 4 p.m.) and spoken punctuation words to symbols
6. Splits run-ons into clean sentences
7. Formats dictated lists ("grocery list: milk, eggs, bread") as real numbered lists, one item per line

The default prompt was not written once and hoped for: it was developed through **automated prompt tournaments** — candidate prompts run head-to-head against a suite of natural dictation utterances (revisions, hesitations, lists, controls that must pass through unchanged) on the live model at temperature 0, scored automatically on whether the final value survived, the abandoned one vanished, and nothing was invented. The shipping prompt is the tournament winner, and regressions reported in real use become new test cases.

A toggle in settings (**Automatic post-processing**) applies the cleanup to every transcription without needing the separate post-process hotkey. Cleanup runs at temperature 0 for deterministic output, and reasoning-model `<think>` blocks are stripped defensively.

## Context-Aware Tone

When you start dictating, the fork captures the foreground app (process name, window title) — and, for browsers, the **actual website domain** via UI Automation — then prepends a context block to the cleanup prompt so the LLM matches your register to the destination:

- Dictating into Discord or a chat app → casual, keeps your slang
- Dictating into Gmail or Outlook → formal, professional phrasing
- Dictating into a code editor or terminal → technical, no fluff

Rules are fully configurable in settings: each rule maps a pattern to a tone. Dotted patterns (like `mail.google.com`) anchor to the detected domain; plain words match app names and titles. Ships with 21 sensible defaults, and each rule's tone is chosen from a dropdown (with a custom free-text option).

Context capture is engineered not to slow dictation: it runs concurrently with recording and the cleanup path waits at most 600 ms for it before proceeding without.

## Tone Presets

Six built-in tones, ordered as a spectrum: **casual → friendly → neutral → formal → professional → technical**. Each preset carries its own embedded prompt describing exactly how that tone should transform text, and every one of those prompts is editable in an expandable editor in settings — so "casual" can mean _your_ casual.

## Live Preview Overlay

Like the dictation preview in commercial tools, but local:

- As you speak, recognized words stream into the bottom overlay panel next to the audio visualizer, oldest lines scrolling up with a dial/wheel warp-and-fade effect
- Long dictations stay readable: the panel sticks to the newest line, but you can scroll back without being yanked down
- When you stop, the transcription phase and the AI cleanup phase are shown with a spinning star and a status label ("Transcribing…", "Polishing…") where the old spinner circle used to be
- Works with **every** model: models with native streaming stream directly; for the rest, a chunked preview transcribes the rolling audio buffer every 250 ms

## Dual-Model Preview Mode

An optional mode (off by default) for the best of both worlds: a small, fast **streaming** model (like Moonshine) drives the instant live preview, while your selected accurate model (like Whisper Large v3 Turbo or bigger) transcribes the same audio hidden in the background. When you stop, the accurate model's transcript is what gets cleaned and pasted — the preview model's text is never used for output, only for feedback.

Both engines share the GPU safely: all native engine operations (model loads, streaming decode steps, batch runs) are serialized behind a process-wide lock, because concurrent Vulkan work from two models was observed crashing the process (see [Stability Fixes](#stability-fixes)).

## Editable Preview

The live preview text is clickable. Click it mid-dictation (or right after you stop) and it becomes an editable box in the same style; press Enter to confirm, Escape to cancel. Your edited version is passed to the cleanup LLM as an authoritative `<user_edit>` block — where your edit disagrees with the raw transcript, your edit wins. The overlay window is normally non-focusable so it can never steal keystrokes; it takes focus only during an edit and hands focus straight back to the app you were dictating into, so the final paste still lands where you meant it to.

## Model Recommendations

The Models tab is reorganized into **Transcription** and **AI Cleanup** tabs, and recommends three models instead of leaving you to guess:

- **For your machine** — weighs accuracy heavily when a capable GPU is detected, and prefers models with broad language coverage
- **For accuracy** — the best transcription quality among installed/available models
- **For speed** — the fastest option that doesn't fall off an accuracy cliff (an accuracy floor keeps garbage-fast models out)

A language filter narrows recommendations to models supporting the language you need. Speed scores are rescaled monotonically on GPU machines so real differences survive instead of saturating.

## Cleanup Model Management

Post-processing models are first-class citizens: the AI Cleanup tab lists a curated catalog of Ollama models (from ~2B to 32B), shows which are installed, and can pull or delete them through the Ollama API directly from the app — no terminal needed. Recommendations here follow the same machine/accuracy/speed logic, sized against your VRAM.

## Smart Paste Spacing

If your cursor sits immediately to the right of a period (or other sentence-ending punctuation) when you paste a dictation, a space is inserted first. Caret inspection uses UI Automation TextPattern2 with graceful fallbacks, so it works across ordinary edit fields, browsers, and editors.

## Stability Fixes

Things that broke and are now fixed properly:

- **Dead hotkeys after closing the window.** Windows silently removes low-level keyboard hooks whose callbacks run long; a watchdog re-arms the hooks every 60 seconds and on window close, so the tray icon you see always means a hotkey that works
- **Duplicate instances.** The single-instance helper window could be destroyed by a stray `WM_CLOSE`, letting multiple instances pile up with clashing keyboard hooks; the vendored plugin now ignores `WM_CLOSE` (this fix belongs upstream in `tauri-plugin-single-instance` and is vendored here until then)
- **GPU crashes with two models.** Concurrent Vulkan backend loads fastfail inside `vulkan-1.dll` (0xc0000409), and a model load racing another model's streaming decode corrupts the heap (0xc0000374 in `ntdll`) — both observed live. One process-wide engine-operation lock serializes loads, streaming decode steps, and batch runs; decode steps are milliseconds, so the serialization is imperceptible
- **Instruction echo from small models.** Context and user-edit blocks are _prepended_ to the prompt, never appended — small local models tend to echo trailing instructions into their output. Reasoning-model think-blocks are stripped as a second line of defense
- **Flat model files.** Model files dropped flat into the models directory (rather than HF-cache layout) are recognized as installed and loadable

## Building This Fork (Windows)

Windows x86_64 is the only supported target. Prerequisites: Rust (stable), [Bun](https://bun.sh), CMake, and the Vulkan SDK. For the cleanup features you'll also want [Ollama](https://ollama.com) running locally with a model pulled (`qwen2.5:7b` is the sweet spot for quality vs. latency on a strong GPU).

```
bun install
bun run tauri build --no-bundle
```

Two things that will save you pain:

1. **Always build through the tauri CLI.** A plain `cargo build --release` produces an exe that silently points its webviews at the Vite dev URL (`localhost:1420`) because the tauri CLI is what injects the `custom-protocol` feature. The app will look alive (tray icon, backend logs) but the UI and hotkeys will never initialize.
2. The VAD model must exist before building: download `silero_vad_v4.onnx` into `src-tauri/resources/models/` (see upstream's BUILD.md).

For development, `bun run tauri dev` works as upstream documents.

## Architecture Notes

For anyone reading the code, the fork's moving parts live here:

| Area                                              | Where                                                                |
| ------------------------------------------------- | -------------------------------------------------------------------- |
| Cleanup pipeline, context blocks, revision prompt | `src-tauri/src/actions.rs`, defaults in `src-tauri/src/settings.rs`  |
| App/website capture (UIA), caret probing          | `src-tauri/src/app_context.rs`                                       |
| Streaming, chunked preview, engine-op lock        | `src-tauri/src/managers/transcription.rs`                            |
| Dual-model preview manager                        | `PreviewTranscription` state in `src-tauri/src/lib.rs`               |
| Ollama model catalog and pulls                    | `src-tauri/src/commands/post_process_models.rs`                      |
| Editable preview commands                         | `src-tauri/src/commands/preview_edit.rs`                             |
| Overlay UI (preview, wheel warp, edit box)        | `src/overlay/RecordingOverlay.tsx` / `.css`                          |
| Models tab, recommendations                       | `src/components/settings/models/`, `src/lib/utils/recommend.ts`      |
| Tone rules and preset editors                     | `src/components/settings/post-processing/PostProcessingSettings.tsx` |
| Vendored single-instance fix                      | `src-tauri/vendor/tauri-plugin-single-instance`                      |

The fork follows upstream's conventions: one Tauri command per setting with a matching `settingUpdaters` entry, tauri-specta bindings (`src/bindings.ts` is maintained by hand here since specta export is debug-only), i18next for all UI strings, and conventional commits.

## Credits and License

- Built on [Handy](https://github.com/cjpais/Handy) by [CJ Pais](https://github.com/cjpais) and contributors — all the hard parts (audio pipeline, VAD, model engines, cross-platform packaging) are theirs
- Local inference by `transcribe-cpp` (GGUF/Vulkan) and `transcribe-rs` (ONNX); cleanup models served by [Ollama](https://ollama.com)
- Fork features developed with [Claude Code](https://claude.com/claude-code)
- Same license as upstream — see [LICENSE](LICENSE)
