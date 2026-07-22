//! Preview-edit commands: let the user click into the Live overlay's text
//! and edit what they said. The overlay window is normally non-focusable so
//! it never steals keystrokes from the dictation target; editing temporarily
//! grants it focus, and submitting hands focus back to the target window so
//! the final paste still lands where the user was typing.

use tauri::{AppHandle, Manager};

const OVERLAY_LABEL: &str = "recording_overlay";

/// The user clicked the preview text: allow the overlay to take keyboard
/// focus so the edit box can type.
#[tauri::command]
#[specta::specta]
pub fn begin_preview_edit(app: AppHandle) -> Result<(), String> {
    let window = app
        .get_webview_window(OVERLAY_LABEL)
        .ok_or("overlay window not found")?;
    window.set_focusable(true).map_err(|e| e.to_string())?;
    window.set_focus().map_err(|e| e.to_string())?;
    Ok(())
}

/// The user finished editing (Enter / blur): store the edited text for the
/// post-processing prompt, drop the overlay's focusability, and hand focus
/// back to the dictation target. An empty string clears the edit (cancel).
#[tauri::command]
#[specta::specta]
pub fn submit_preview_edit(app: AppHandle, text: String) -> Result<(), String> {
    let trimmed = text.trim();
    crate::actions::set_preview_edit(if trimmed.is_empty() {
        None
    } else {
        Some(trimmed.to_string())
    });

    if let Some(window) = app.get_webview_window(OVERLAY_LABEL) {
        let _ = window.set_focusable(false);
    }
    crate::app_context::refocus_last_target();
    Ok(())
}
