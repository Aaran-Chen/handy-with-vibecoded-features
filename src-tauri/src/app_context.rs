//! Captures the foreground application — and, for browsers, the active
//! website — at dictation time so LLM post-processing can adapt tone to the
//! destination (formal for email/docs, casual for chat, etc.).
//!
//! Capture is Windows-only for now; other platforms return no context and
//! post-processing behaves exactly as upstream. Browser URLs are read through
//! UI Automation from the focused document, which works across Chromium
//! browsers (Chrome, Edge, Vivaldi, Brave, ...) and Firefox without any
//! browser extension. Everything stays on-device.

use once_cell::sync::Lazy;
use std::sync::{Condvar, Mutex};
use std::time::{Duration, Instant};

#[derive(Debug, Clone, Default)]
pub struct AppContext {
    /// Friendly application name (e.g. "Vivaldi", "Discord"), falling back to
    /// the executable stem.
    pub app_name: String,
    /// Title of the foreground window at capture time.
    pub window_title: String,
    /// Website domain (e.g. "mail.google.com") when the foreground app is a
    /// known browser and the URL could be read.
    pub domain: Option<String>,
    /// Lowercased executable stem (e.g. "vivaldi"), used for rule matching.
    pub process_name: String,
}

struct CaptureState {
    ctx: Option<(AppContext, Instant)>,
    /// Number of capture threads still in flight; last_context waits
    /// (bounded) for them so a stop-time re-capture isn't raced by a fast
    /// transcription.
    pending: u32,
}

static STATE: Lazy<(Mutex<CaptureState>, Condvar)> = Lazy::new(|| {
    (
        Mutex::new(CaptureState {
            ctx: None,
            pending: 0,
        }),
        Condvar::new(),
    )
});

/// How long last_context waits for an in-flight capture before giving up.
const CAPTURE_WAIT: Duration = Duration::from_millis(600);
/// Contexts older than this are considered stale (a leftover from a previous
/// dictation whose start/stop captures both failed) and are not used.
const CONTEXT_TTL: Duration = Duration::from_secs(120);

/// Capture the foreground app/site on a background thread. The UIA tree walk
/// for browser URLs can take ~100ms on busy windows, so this must never run
/// on the shortcut hot path. A successful capture replaces the stored
/// context; a failed one keeps the previous capture (e.g. the start-time one).
pub fn refresh_async() {
    {
        let (lock, _) = &*STATE;
        match lock.lock() {
            Ok(mut state) => state.pending += 1,
            Err(_) => return,
        }
    }
    std::thread::spawn(|| {
        let ctx = std::panic::catch_unwind(capture).unwrap_or(None);
        log::debug!("App context captured: {:?}", ctx);
        let (lock, cvar) = &*STATE;
        if let Ok(mut state) = lock.lock() {
            state.pending = state.pending.saturating_sub(1);
            if let Some(ctx) = ctx {
                state.ctx = Some((ctx, Instant::now()));
            }
            cvar.notify_all();
        }
    });
}

/// The most recent fresh capture, waiting (bounded) for any capture thread
/// still in flight so the stop-time re-capture wins over the start-time one.
pub fn last_context() -> Option<AppContext> {
    let (lock, cvar) = &*STATE;
    let mut state = lock.lock().ok()?;
    let deadline = Instant::now() + CAPTURE_WAIT;
    while state.pending > 0 {
        let now = Instant::now();
        if now >= deadline {
            break;
        }
        let (guard, wait) = cvar.wait_timeout(state, deadline - now).ok()?;
        state = guard;
        if wait.timed_out() {
            break;
        }
    }
    state
        .ctx
        .as_ref()
        .filter(|(_, captured_at)| captured_at.elapsed() < CONTEXT_TTL)
        .map(|(ctx, _)| ctx.clone())
}

/// Browsers whose URL we try to read via UI Automation (lowercased exe stems).
#[cfg(windows)]
const BROWSER_PROCESSES: &[&str] = &[
    "vivaldi",
    "chrome",
    "msedge",
    "firefox",
    "brave",
    "opera",
    "opera_gx",
    "arc",
    "zen",
    "librewolf",
    "thorium",
    "chromium",
    "waterfox",
    "iron",
];

/// Map well-known executable stems to friendly names for the prompt.
fn friendly_app_name(process_name: &str) -> Option<&'static str> {
    Some(match process_name {
        "vivaldi" => "Vivaldi (web browser)",
        "chrome" => "Google Chrome (web browser)",
        "msedge" => "Microsoft Edge (web browser)",
        "firefox" => "Firefox (web browser)",
        "brave" => "Brave (web browser)",
        "opera" | "opera_gx" => "Opera (web browser)",
        "discord" => "Discord",
        "slack" => "Slack",
        "code" => "Visual Studio Code",
        "cursor" => "Cursor",
        "windowsterminal" | "wt" => "Windows Terminal",
        "notepad" => "Notepad",
        "obsidian" => "Obsidian",
        "outlook" | "olk" => "Microsoft Outlook",
        "thunderbird" => "Thunderbird",
        "teams" | "ms-teams" => "Microsoft Teams",
        "telegram" => "Telegram",
        "whatsapp" => "WhatsApp",
        "signal" => "Signal",
        "winword" => "Microsoft Word",
        "excel" => "Microsoft Excel",
        "powerpnt" => "Microsoft PowerPoint",
        "onenote" => "Microsoft OneNote",
        "claude" => "Claude",
        "explorer" => "File Explorer",
        _ => return None,
    })
}

/// Extract a lowercased host (minus `www.`) from a URL-ish string.
fn extract_domain(url: &str) -> Option<String> {
    let trimmed = url.trim();
    if trimmed.is_empty() {
        return None;
    }
    let without_scheme = trimmed
        .split_once("://")
        .map(|(_, rest)| rest)
        .unwrap_or(trimmed);
    let host = without_scheme.split(['/', '?', '#']).next()?;
    let host = host.rsplit('@').next()?;
    let host = host.split(':').next()?;
    let host = host.strip_prefix("www.").unwrap_or(host);
    if host.is_empty() || !host.contains('.') || host.contains(' ') {
        return None;
    }
    Some(host.to_lowercase())
}

#[cfg(windows)]
fn capture() -> Option<AppContext> {
    use std::path::Path;
    use windows::core::PWSTR;
    use windows::Win32::Foundation::CloseHandle;
    use windows::Win32::System::Threading::{
        OpenProcess, QueryFullProcessImageNameW, PROCESS_NAME_WIN32,
        PROCESS_QUERY_LIMITED_INFORMATION,
    };
    use windows::Win32::UI::WindowsAndMessaging::{
        GetForegroundWindow, GetWindowTextW, GetWindowThreadProcessId,
    };

    let hwnd = unsafe { GetForegroundWindow() };
    if hwnd.is_invalid() {
        return None;
    }

    let mut title_buf = [0u16; 512];
    let title_len = unsafe { GetWindowTextW(hwnd, &mut title_buf) };
    let window_title = String::from_utf16_lossy(&title_buf[..title_len.max(0) as usize]);

    let mut pid = 0u32;
    unsafe { GetWindowThreadProcessId(hwnd, Some(&mut pid)) };
    if pid == 0 {
        return None;
    }

    let exe_path = unsafe {
        let handle = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid).ok()?;
        let mut name_buf = [0u16; 1024];
        let mut size = name_buf.len() as u32;
        let result = QueryFullProcessImageNameW(
            handle,
            PROCESS_NAME_WIN32,
            PWSTR(name_buf.as_mut_ptr()),
            &mut size,
        );
        let _ = CloseHandle(handle);
        result.ok()?;
        String::from_utf16_lossy(&name_buf[..size as usize])
    };

    let process_name = Path::new(&exe_path)
        .file_stem()
        .and_then(|stem| stem.to_str())
        .unwrap_or_default()
        .to_lowercase();
    if process_name.is_empty() {
        return None;
    }

    let domain = if BROWSER_PROCESSES.contains(&process_name.as_str()) {
        read_browser_url(hwnd).as_deref().and_then(extract_domain)
    } else {
        None
    };

    let app_name = friendly_app_name(&process_name)
        .map(str::to_string)
        .unwrap_or_else(|| process_name.clone());

    Some(AppContext {
        app_name,
        window_title,
        domain,
        process_name,
    })
}

/// Read the current page URL from a browser window via UI Automation: the
/// page's Document element exposes the URL through its ValuePattern in both
/// Chromium and Firefox. Locale-independent, no extension needed.
#[cfg(windows)]
fn read_browser_url(hwnd: windows::Win32::Foundation::HWND) -> Option<String> {
    use windows::Win32::System::Com::{
        CoCreateInstance, CoInitializeEx, CLSCTX_INPROC_SERVER, COINIT_APARTMENTTHREADED,
    };
    use windows::Win32::System::Variant::{VARIANT, VARIANT_0, VARIANT_0_0, VARIANT_0_0_0, VT_I4};
    use windows::Win32::UI::Accessibility::{
        CUIAutomation, IUIAutomation, IUIAutomationValuePattern, TreeScope_Descendants,
        UIA_ControlTypePropertyId, UIA_DocumentControlTypeId, UIA_ValuePatternId,
    };

    unsafe {
        // May legitimately fail with RPC_E_CHANGED_MODE if this thread is
        // already in another apartment; CoCreateInstance still works then.
        let _ = CoInitializeEx(None, COINIT_APARTMENTTHREADED);

        let automation: IUIAutomation =
            CoCreateInstance(&CUIAutomation, None, CLSCTX_INPROC_SERVER).ok()?;
        let root = automation.ElementFromHandle(hwnd).ok()?;
        // Raw VT_I4 VARIANT holding the Document control-type id; the windows
        // crate's Win32 VARIANT has no From<i32> convenience constructor.
        let control_type = VARIANT {
            Anonymous: VARIANT_0 {
                Anonymous: std::mem::ManuallyDrop::new(VARIANT_0_0 {
                    vt: VT_I4,
                    wReserved1: 0,
                    wReserved2: 0,
                    wReserved3: 0,
                    Anonymous: VARIANT_0_0_0 {
                        lVal: UIA_DocumentControlTypeId.0,
                    },
                }),
            },
        };
        let condition = automation
            .CreatePropertyCondition(UIA_ControlTypePropertyId, &control_type)
            .ok()?;
        let document = root.FindFirst(TreeScope_Descendants, &condition).ok()?;
        let pattern: IUIAutomationValuePattern =
            document.GetCurrentPatternAs(UIA_ValuePatternId).ok()?;
        let value = pattern.CurrentValue().ok()?;
        let url = value.to_string();
        if url.trim().is_empty() {
            None
        } else {
            Some(url)
        }
    }
}

#[cfg(not(windows))]
fn capture() -> Option<AppContext> {
    None
}

/// The character immediately to the left of the caret in the focused
/// control, read via UI Automation's text pattern. Used for smart paste
/// spacing (dictating right after a sentence should insert a space first).
/// Returns None when the focused control exposes no caret/text pattern —
/// callers must treat that as "unknown", not "no character".
#[cfg(windows)]
pub fn char_before_caret() -> Option<char> {
    use windows::core::BOOL;
    use windows::Win32::System::Com::{
        CoCreateInstance, CoInitializeEx, CLSCTX_INPROC_SERVER, COINIT_APARTMENTTHREADED,
    };
    use windows::Win32::UI::Accessibility::{
        CUIAutomation, IUIAutomation, IUIAutomationTextPattern, IUIAutomationTextPattern2,
        TextPatternRangeEndpoint_Start, TextUnit_Character, UIA_TextPattern2Id, UIA_TextPatternId,
    };

    unsafe {
        let _ = CoInitializeEx(None, COINIT_APARTMENTTHREADED);
        let automation: IUIAutomation =
            match CoCreateInstance(&CUIAutomation, None, CLSCTX_INPROC_SERVER) {
                Ok(a) => a,
                Err(e) => {
                    log::debug!("char_before_caret: UIA instance failed: {e}");
                    return None;
                }
            };
        let focused = match automation.GetFocusedElement() {
            Ok(f) => f,
            Err(e) => {
                log::debug!("char_before_caret: no focused element: {e}");
                return None;
            }
        };

        // Prefer the true caret range (TextPattern2); fall back to the
        // selection's start, which coincides with the caret when nothing is
        // selected and is still the right anchor when pasting over one.
        let range = if let Ok(tp2) =
            focused.GetCurrentPatternAs::<IUIAutomationTextPattern2>(UIA_TextPattern2Id)
        {
            let mut is_active = BOOL::default();
            match tp2.GetCaretRange(&mut is_active) {
                Ok(r) => r,
                Err(e) => {
                    log::debug!("char_before_caret: caret range failed: {e}");
                    return None;
                }
            }
        } else {
            let Ok(tp) = focused.GetCurrentPatternAs::<IUIAutomationTextPattern>(UIA_TextPatternId)
            else {
                log::debug!("char_before_caret: focused element has no text pattern");
                return None;
            };
            let ranges = tp.GetSelection().ok()?;
            if ranges.Length().ok()? == 0 {
                return None;
            }
            ranges.GetElement(0).ok()?
        };

        // Pull the range's start back one character and read what's there.
        range
            .MoveEndpointByUnit(TextPatternRangeEndpoint_Start, TextUnit_Character, -1)
            .ok()?;
        let text = range.GetText(8).ok()?.to_string();
        let ch = text.chars().next();
        log::debug!("char_before_caret probed: {:?}", ch);
        ch
    }
}

#[cfg(not(windows))]
pub fn char_before_caret() -> Option<char> {
    None
}

/// Screen rectangle (physical px: x, y, w, h) of the text caret in the
/// focused control. Tries the classic Win32 caret first (exact for native
/// edit controls), then falls back to UI Automation's caret-range bounding
/// rect (covers browsers and modern frameworks).
#[cfg(windows)]
pub fn caret_screen_rect() -> Option<(f64, f64, f64, f64)> {
    if let Some(rect) = caret_rect_guithreadinfo() {
        return Some(rect);
    }
    caret_rect_uia()
}

#[cfg(windows)]
fn caret_rect_guithreadinfo() -> Option<(f64, f64, f64, f64)> {
    use windows::Win32::Foundation::POINT;
    use windows::Win32::Graphics::Gdi::ClientToScreen;
    use windows::Win32::UI::WindowsAndMessaging::{GetGUIThreadInfo, GUITHREADINFO};

    unsafe {
        let mut info = GUITHREADINFO {
            cbSize: std::mem::size_of::<GUITHREADINFO>() as u32,
            ..Default::default()
        };
        // Thread id 0 = the foreground thread.
        GetGUIThreadInfo(0, &mut info).ok()?;
        if info.hwndCaret.is_invalid() {
            return None;
        }
        let rc = info.rcCaret;
        if rc.bottom <= rc.top {
            return None;
        }
        let mut top_left = POINT {
            x: rc.left,
            y: rc.top,
        };
        if !ClientToScreen(info.hwndCaret, &mut top_left).as_bool() {
            return None;
        }
        Some((
            top_left.x as f64,
            top_left.y as f64,
            (rc.right - rc.left).max(1) as f64,
            (rc.bottom - rc.top) as f64,
        ))
    }
}

/// First bounding rect of a UIA text range, or None (with a debug log on
/// failure). Returns (left, top, width, height) in physical px.
#[cfg(windows)]
unsafe fn first_range_rect(
    automation: &windows::Win32::UI::Accessibility::IUIAutomation,
    range: &windows::Win32::UI::Accessibility::IUIAutomationTextRange,
) -> Option<(f64, f64, f64, f64)> {
    let sa = match range.GetBoundingRectangles() {
        Ok(sa) => sa,
        Err(e) => {
            log::debug!("caret: GetBoundingRectangles failed: {e}");
            return None;
        }
    };
    let mut rect_ptr: *mut windows::Win32::Foundation::RECT = std::ptr::null_mut();
    let count = automation
        .SafeArrayToRectNativeArray(sa, &mut rect_ptr)
        .unwrap_or(0);
    let _ = windows::Win32::System::Ole::SafeArrayDestroy(sa);
    if count > 0 && !rect_ptr.is_null() {
        let r = *rect_ptr;
        windows::Win32::System::Com::CoTaskMemFree(Some(rect_ptr as *const core::ffi::c_void));
        if r.bottom > r.top {
            return Some((
                r.left as f64,
                r.top as f64,
                (r.right - r.left).max(1) as f64,
                (r.bottom - r.top) as f64,
            ));
        }
    }
    None
}

#[cfg(windows)]
fn caret_rect_uia() -> Option<(f64, f64, f64, f64)> {
    use windows::core::BOOL;
    use windows::Win32::System::Com::{
        CoCreateInstance, CoInitializeEx, CLSCTX_INPROC_SERVER, COINIT_APARTMENTTHREADED,
    };
    use windows::Win32::UI::Accessibility::{
        CUIAutomation, IUIAutomation, IUIAutomationTextPattern2, TextPatternRangeEndpoint_Start,
        TextUnit_Character, UIA_TextPattern2Id,
    };

    unsafe {
        let _ = CoInitializeEx(None, COINIT_APARTMENTTHREADED);
        let automation: IUIAutomation =
            CoCreateInstance(&CUIAutomation, None, CLSCTX_INPROC_SERVER).ok()?;
        let focused = match automation.GetFocusedElement() {
            Ok(f) => f,
            Err(e) => {
                log::debug!("caret: no focused element: {e}");
                return None;
            }
        };
        let tp2 = match focused.GetCurrentPatternAs::<IUIAutomationTextPattern2>(UIA_TextPattern2Id)
        {
            Ok(tp) => tp,
            Err(e) => {
                log::debug!("caret: focused element has no TextPattern2: {e}");
                return None;
            }
        };
        let mut is_active = BOOL::default();
        let range = match tp2.GetCaretRange(&mut is_active) {
            Ok(r) => r,
            Err(e) => {
                log::debug!("caret: GetCaretRange failed: {e}");
                return None;
            }
        };

        // Preferred: measure the character just LEFT of the caret — the same
        // maneuver char_before_caret uses (empirically supported where
        // ExpandToEnclosingUnit on a collapsed caret is not). The caret sits
        // at that character's right edge.
        if let Ok(prev) = range.Clone() {
            let moved = prev
                .MoveEndpointByUnit(TextPatternRangeEndpoint_Start, TextUnit_Character, -1)
                .unwrap_or(0);
            if moved != 0 {
                if let Some((left, top, width, height)) = first_range_rect(&automation, &prev) {
                    return Some((left + width, top, 2.0, height));
                }
            }
        }

        // Next: expand the caret range itself to the enclosing character
        // (covers caret-at-start-of-text, where there is no previous char).
        if let Ok(expanded) = range.Clone() {
            let _ = expanded.ExpandToEnclosingUnit(TextUnit_Character);
            if let Some((left, top, _width, height)) = first_range_rect(&automation, &expanded) {
                return Some((left, top, 2.0, height));
            }
        }

        // Last resort: the focused element's own rect — left edge, a typical
        // line height. Keeps the spinner near the field even when the exact
        // caret cannot be measured (e.g. empty field in some frameworks).
        match focused.CurrentBoundingRectangle() {
            Ok(el_rect) => Some((
                el_rect.left as f64 + 6.0,
                el_rect.top as f64 + 6.0,
                2.0,
                ((el_rect.bottom - el_rect.top) as f64 - 12.0).clamp(14.0, 28.0),
            )),
            Err(e) => {
                log::debug!("caret: element bounding rect failed: {e}");
                None
            }
        }
    }
}

#[cfg(not(windows))]
pub fn caret_screen_rect() -> Option<(f64, f64, f64, f64)> {
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn extract_domain_handles_common_forms() {
        assert_eq!(
            extract_domain("https://mail.google.com/mail/u/0/#inbox"),
            Some("mail.google.com".to_string())
        );
        assert_eq!(
            extract_domain("http://www.reddit.com/r/rust"),
            Some("reddit.com".to_string())
        );
        assert_eq!(
            extract_domain("discord.com/channels/123"),
            Some("discord.com".to_string())
        );
        assert_eq!(
            extract_domain("https://user@example.com:8080/path"),
            Some("example.com".to_string())
        );
        assert_eq!(extract_domain(""), None);
        assert_eq!(extract_domain("New Tab"), None);
        assert_eq!(extract_domain("localhost"), None);
    }

    #[test]
    fn friendly_names_cover_browsers() {
        assert_eq!(friendly_app_name("vivaldi"), Some("Vivaldi (web browser)"));
        assert_eq!(friendly_app_name("unknown_app"), None);
    }
}
