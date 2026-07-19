//! Post-processing (LLM cleanup) model management.
//!
//! Handy talks to an OpenAI-compatible endpoint for post-processing. When that
//! endpoint is a local Ollama server (the default "custom" provider,
//! http://localhost:11434), we can also *manage* its models: list what's
//! installed, pull a curated model, and delete it — all through Ollama's native
//! REST API. This powers the "Post-processing models" section of the Models tab
//! and the machine-aware recommendations, so the user can download a fast local
//! model without leaving Handy.

use futures_util::StreamExt;
use serde::{Deserialize, Serialize};
use specta::Type;
use std::collections::BTreeMap;
use tauri::{AppHandle, Emitter};

/// Hardware capability used to recommend a model that fits this machine.
#[derive(Serialize, Clone, Debug, Type)]
pub struct SystemCapability {
    /// Largest single-GPU VRAM in MB (0 if no GPU / unreported).
    pub vram_mb: usize,
    /// Total system RAM in MB.
    pub ram_mb: usize,
    pub has_gpu: bool,
}

/// A curated local post-processing model (an Ollama tag) with metadata for
/// recommendation and display. Non-reasoning, instruction-following models that
/// are good at transcript cleanup, spanning fast -> accurate.
#[derive(Serialize, Clone, Debug, Type)]
pub struct PostProcessCatalogModel {
    /// Ollama tag, e.g. "qwen2.5:3b" — also the value stored in settings.
    pub id: String,
    pub name: String,
    pub params: String,
    pub description: String,
    pub size_mb: usize,
    /// Approximate VRAM needed to run comfortably (MB).
    pub vram_need_mb: usize,
    /// 0-100, higher = faster.
    pub speed_score: u32,
    /// 0-100, higher = more accurate.
    pub accuracy_score: u32,
    /// Whether this tag is currently installed in the local Ollama server.
    pub is_installed: bool,
}

fn catalog() -> Vec<PostProcessCatalogModel> {
    fn m(
        id: &str,
        name: &str,
        params: &str,
        description: &str,
        size_mb: usize,
        vram_need_mb: usize,
        speed_score: u32,
        accuracy_score: u32,
    ) -> PostProcessCatalogModel {
        PostProcessCatalogModel {
            id: id.to_string(),
            name: name.to_string(),
            params: params.to_string(),
            description: description.to_string(),
            size_mb,
            vram_need_mb,
            speed_score,
            accuracy_score,
            is_installed: false,
        }
    }
    vec![
        m(
            "gemma2:2b",
            "Gemma 2 2B",
            "2B",
            "Tiny and near-instant. Great when speed matters most.",
            1600,
            3000,
            98,
            70,
        ),
        m(
            "qwen2.5:3b",
            "Qwen 2.5 3B",
            "3B",
            "Fast, faithful cleanup with terse output. Best all-round pick for dictation.",
            1900,
            4000,
            95,
            80,
        ),
        m(
            "llama3.2:3b",
            "Llama 3.2 3B",
            "3B",
            "Fast and capable; slightly chattier than Qwen 2.5.",
            2000,
            4000,
            92,
            77,
        ),
        m(
            "qwen2.5:7b",
            "Qwen 2.5 7B",
            "7B",
            "Balanced quality and speed for richer rewrites.",
            4700,
            8000,
            80,
            87,
        ),
        m(
            "llama3.1:8b",
            "Llama 3.1 8B",
            "8B",
            "Strong general model; good tone control.",
            4900,
            10000,
            74,
            88,
        ),
        m(
            "qwen2.5:14b",
            "Qwen 2.5 14B",
            "14B",
            "High accuracy for demanding cleanup and formatting.",
            9000,
            16000,
            55,
            93,
        ),
        m(
            "qwen2.5:32b",
            "Qwen 2.5 32B",
            "32B",
            "Most accurate; needs a large GPU.",
            20000,
            24000,
            35,
            97,
        ),
    ]
}

#[cfg(windows)]
fn total_ram_mb() -> usize {
    use windows::Win32::System::SystemInformation::{GlobalMemoryStatusEx, MEMORYSTATUSEX};
    unsafe {
        let mut status = MEMORYSTATUSEX {
            dwLength: std::mem::size_of::<MEMORYSTATUSEX>() as u32,
            ..Default::default()
        };
        if GlobalMemoryStatusEx(&mut status).is_ok() {
            (status.ullTotalPhys / (1024 * 1024)) as usize
        } else {
            0
        }
    }
}

#[cfg(not(windows))]
fn total_ram_mb() -> usize {
    0
}

#[tauri::command]
#[specta::specta]
pub async fn get_system_capability() -> Result<SystemCapability, String> {
    let vram_mb =
        tauri::async_runtime::spawn_blocking(crate::managers::transcription::max_gpu_vram_mb)
            .await
            .map_err(|e| format!("VRAM query failed: {e}"))?;
    Ok(SystemCapability {
        vram_mb,
        ram_mb: total_ram_mb(),
        has_gpu: vram_mb > 0,
    })
}

/// Base URL of the local Ollama server, derived from the "custom" provider's
/// OpenAI base_url (strip the trailing `/v1`). Returns None when the custom
/// provider isn't an Ollama-style local endpoint.
fn ollama_base_url(app: &AppHandle) -> Option<String> {
    let settings = crate::settings::get_settings(app);
    let provider = settings.post_process_provider("custom")?;
    let base = provider.base_url.trim_end_matches('/');
    let root = base.strip_suffix("/v1").unwrap_or(base);
    Some(root.to_string())
}

async fn installed_ollama_models(base: &str) -> Vec<String> {
    #[derive(Deserialize)]
    struct Tag {
        name: String,
    }
    #[derive(Deserialize)]
    struct Tags {
        models: Vec<Tag>,
    }
    let url = format!("{base}/api/tags");
    match reqwest::Client::new().get(&url).send().await {
        Ok(resp) => match resp.json::<Tags>().await {
            Ok(tags) => tags.models.into_iter().map(|t| t.name).collect(),
            Err(_) => Vec::new(),
        },
        Err(_) => Vec::new(),
    }
}

#[tauri::command]
#[specta::specta]
pub async fn get_post_process_model_catalog(
    app: AppHandle,
) -> Result<Vec<PostProcessCatalogModel>, String> {
    let mut models = catalog();
    if let Some(base) = ollama_base_url(&app) {
        let installed = installed_ollama_models(&base).await;
        for model in &mut models {
            // Ollama reports "qwen2.5:3b"; also match a ":latest" alias.
            model.is_installed = installed.iter().any(|i| {
                i == &model.id
                    || i == &format!("{}:latest", model.id.split(':').next().unwrap_or(&model.id))
            });
        }
    }
    Ok(models)
}

#[derive(Serialize, Clone)]
struct PullProgress {
    model: String,
    status: String,
    completed: u64,
    total: u64,
    percentage: f64,
}

#[derive(Serialize, Clone)]
struct PullFailed {
    model: String,
    error: String,
}

/// Pull a post-processing model from the local Ollama server, streaming
/// progress to the frontend via `pp-model-download-*` events.
#[tauri::command]
#[specta::specta]
pub async fn pull_post_process_model(app: AppHandle, model: String) -> Result<(), String> {
    let base = ollama_base_url(&app)
        .ok_or_else(|| "Post-processing provider is not a local Ollama server".to_string())?;
    let url = format!("{base}/api/pull");

    let resp = reqwest::Client::new()
        .post(&url)
        .json(&serde_json::json!({ "model": model, "stream": true }))
        .send()
        .await
        .map_err(|e| format!("Failed to reach Ollama at {base}: {e}"))?;

    if !resp.status().is_success() {
        let status = resp.status();
        let body = resp.text().await.unwrap_or_default();
        let error = format!("Ollama returned {status}: {body}");
        let _ = app.emit(
            "pp-model-download-failed",
            PullFailed {
                model: model.clone(),
                error: error.clone(),
            },
        );
        return Err(error);
    }

    // Ollama streams newline-delimited JSON, one object per progress tick. Each
    // layer reports its own completed/total keyed by digest; aggregate across
    // digests for an overall percentage.
    let mut stream = resp.bytes_stream();
    let mut buf: Vec<u8> = Vec::new();
    let mut layer_totals: BTreeMap<String, (u64, u64)> = BTreeMap::new();

    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|e| {
            let error = format!("Download stream error: {e}");
            let _ = app.emit(
                "pp-model-download-failed",
                PullFailed {
                    model: model.clone(),
                    error: error.clone(),
                },
            );
            error
        })?;
        buf.extend_from_slice(&chunk);

        while let Some(pos) = buf.iter().position(|&b| b == b'\n') {
            let line: Vec<u8> = buf.drain(..=pos).collect();
            let line = &line[..line.len() - 1];
            if line.is_empty() {
                continue;
            }
            let value: serde_json::Value = match serde_json::from_slice(line) {
                Ok(v) => v,
                Err(_) => continue,
            };

            if let Some(err) = value.get("error").and_then(|e| e.as_str()) {
                let _ = app.emit(
                    "pp-model-download-failed",
                    PullFailed {
                        model: model.clone(),
                        error: err.to_string(),
                    },
                );
                return Err(err.to_string());
            }

            let status = value
                .get("status")
                .and_then(|s| s.as_str())
                .unwrap_or("")
                .to_string();

            if let (Some(digest), Some(total)) = (
                value.get("digest").and_then(|d| d.as_str()),
                value.get("total").and_then(|t| t.as_u64()),
            ) {
                let completed = value.get("completed").and_then(|c| c.as_u64()).unwrap_or(0);
                layer_totals.insert(digest.to_string(), (completed, total));
            }

            let (sum_completed, sum_total) = layer_totals
                .values()
                .fold((0u64, 0u64), |(c, t), (lc, lt)| (c + lc, t + lt));
            let percentage = if sum_total > 0 {
                (sum_completed as f64 / sum_total as f64) * 100.0
            } else {
                0.0
            };

            let _ = app.emit(
                "pp-model-download-progress",
                PullProgress {
                    model: model.clone(),
                    status,
                    completed: sum_completed,
                    total: sum_total,
                    percentage,
                },
            );
        }
    }

    let _ = app.emit("pp-model-download-complete", model.clone());
    Ok(())
}

#[tauri::command]
#[specta::specta]
pub async fn delete_post_process_model(app: AppHandle, model: String) -> Result<(), String> {
    let base = ollama_base_url(&app)
        .ok_or_else(|| "Post-processing provider is not a local Ollama server".to_string())?;
    let url = format!("{base}/api/delete");
    let resp = reqwest::Client::new()
        .delete(&url)
        .json(&serde_json::json!({ "model": model }))
        .send()
        .await
        .map_err(|e| format!("Failed to reach Ollama: {e}"))?;
    if resp.status().is_success() {
        Ok(())
    } else {
        Err(format!("Ollama returned {}", resp.status()))
    }
}
