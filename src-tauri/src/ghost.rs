//! Caret-anchored ghost preview window.
//!
//! While dictating, a small transparent, click-through window is positioned
//! at the text caret of the focused control and renders the live streaming
//! transcription at ~50% opacity — a preview of what will be pasted, sitting
//! where the text will land. When recording stops it switches to a spinning
//! star while transcription/post-processing runs, and hides when the final
//! text is pasted (or the operation is cancelled).
//!
//! The preview cannot literally render inside another app's text field (that
//! text would be real input); the ghost window is the closest robust
//! approximation: font size is matched to the field's caret height so the
//! preview visually lines up with the destination text.

use log::debug;
use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, PhysicalPosition, PhysicalSize, WebviewWindowBuilder};

pub const GHOST_WINDOW_LABEL: &str = "ghost_preview";

/// Logical width of the ghost window; the preview shows the tail end of the
/// text, so a fixed width is fine.
const GHOST_WIDTH_LOGICAL: f64 = 440.0;
/// Fallback caret height (physical px) when no caret rect is available.
const FALLBACK_CARET_H: f64 = 22.0;

#[derive(Clone, Serialize)]
struct GhostStateEvent {
    /// "listening" (live preview) or "processing" (spinner).
    state: String,
    /// Logical font size matching the destination field's caret height.
    font_px: f64,
}

/// Create the (hidden) ghost window at startup.
pub fn create_ghost_window(app_handle: &AppHandle) {
    let mut builder = WebviewWindowBuilder::new(
        app_handle,
        GHOST_WINDOW_LABEL,
        tauri::WebviewUrl::App("src/ghost/index.html".into()),
    )
    .title("Preview")
    .resizable(false)
    .inner_size(GHOST_WIDTH_LOGICAL, 40.0)
    .shadow(false)
    .maximizable(false)
    .minimizable(false)
    .closable(false)
    .decorations(false)
    .always_on_top(true)
    .skip_taskbar(true)
    .transparent(true)
    .focusable(false)
    .focused(false)
    .visible(false);

    if let Some(data_dir) = crate::portable::data_dir() {
        builder = builder.data_directory(data_dir.join("webview"));
    }

    match builder.build() {
        Ok(window) => {
            // Click-through: the preview must never intercept typing or clicks
            // aimed at the text field underneath it.
            if let Err(e) = window.set_ignore_cursor_events(true) {
                debug!("ghost: set_ignore_cursor_events failed: {e}");
            }
            debug!("Ghost preview window created (hidden)");
        }
        Err(e) => {
            debug!("Failed to create ghost preview window: {e}");
        }
    }
}

/// Show the ghost at the focused control's caret in the given state.
/// No-op when no caret position can be determined (better no preview than a
/// preview floating somewhere wrong).
pub fn show_at_caret(app_handle: &AppHandle, state: &str) {
    let Some(window) = app_handle.get_webview_window(GHOST_WINDOW_LABEL) else {
        return;
    };
    let Some((x, y, _w, h)) = crate::app_context::caret_screen_rect() else {
        debug!("ghost: no caret rect available; skipping preview");
        return;
    };

    let scale = window.scale_factor().unwrap_or(1.0);
    let caret_h = if h > 4.0 { h } else { FALLBACK_CARET_H };
    // Window tall enough for one line with breathing room.
    let win_h = (caret_h * 1.6).max(28.0);
    let win_w = GHOST_WIDTH_LOGICAL * scale;

    // First preview line sits exactly on the caret line: left edge at the
    // caret, vertically centered on it.
    let pos_x = x;
    let pos_y = y - (win_h - caret_h) / 2.0;

    let _ = window.set_size(PhysicalSize::new(win_w as u32, win_h as u32));
    let _ = window.set_position(PhysicalPosition::new(pos_x as i32, pos_y as i32));

    let font_px = (caret_h / scale * 0.82).clamp(11.0, 40.0);
    let _ = app_handle.emit(
        "ghost-state",
        GhostStateEvent {
            state: state.to_string(),
            font_px,
        },
    );
    let _ = window.show();
}

/// Switch an already-visible ghost to a new state without re-positioning
/// (falls back to showing at the caret when it isn't visible yet).
pub fn set_state(app_handle: &AppHandle, state: &str) {
    let Some(window) = app_handle.get_webview_window(GHOST_WINDOW_LABEL) else {
        return;
    };
    if window.is_visible().unwrap_or(false) {
        let _ = app_handle.emit(
            "ghost-state",
            GhostStateEvent {
                state: state.to_string(),
                font_px: 0.0, // 0 = keep current size
            },
        );
    } else {
        show_at_caret(app_handle, state);
    }
}

pub fn hide(app_handle: &AppHandle) {
    if let Some(window) = app_handle.get_webview_window(GHOST_WINDOW_LABEL) {
        let _ = window.hide();
        // Clear stale text so the next show starts empty.
        let _ = app_handle.emit(
            "ghost-state",
            GhostStateEvent {
                state: "hidden".to_string(),
                font_px: 0.0,
            },
        );
    }
}
