//! MuMuManager adapter. Never target `all` or infer an ADB port from an index.
use std::path::{Path, PathBuf};
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc,
};
use std::time::Duration;

use serde::{Deserialize, Serialize};
use tauri::State;

use super::types::{ControllerConfig, MaaState};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MuMuBinding {
    pub path: String,
    pub index: u32,
}

fn path_identity(path: &str) -> String {
    path.replace('\\', "/").trim_end_matches('/').to_lowercase()
}

impl MuMuBinding {
    pub fn matches(&self, other: &Self) -> bool {
        self.index == other.index && path_identity(&self.path) == path_identity(&other.path)
    }

    pub fn validate_controller(&self, config: Option<&ControllerConfig>) -> Result<(), String> {
        if let Some(ControllerConfig::Adb { config, .. }) = config {
            if let Ok(value) = serde_json::from_str::<serde_json::Value>(config) {
                if let Some(mumu) = value.pointer("/extras/mumu") {
                    if let Ok(binding) = serde_json::from_value::<Self>(mumu.clone()) {
                        if mumu.get("enable").and_then(|v| v.as_bool()) == Some(true)
                            && self.matches(&binding)
                        {
                            return Ok(());
                        }
                    }
                }
            }
        }
        Err(
            "MUMU_BINDING_MISMATCH: active controller extras.mumu does not match shutdown binding"
                .into(),
        )
    }
}

fn manager_candidates(path: &Path) -> Vec<PathBuf> {
    if path.file_name().is_some_and(|name| {
        name.to_string_lossy()
            .eq_ignore_ascii_case("MuMuManager.exe")
    }) {
        return vec![path.to_owned()];
    }
    vec![
        path.join("MuMuManager.exe"),
        path.join("nx_main/MuMuManager.exe"),
        path.join("shell/MuMuManager.exe"),
    ]
}

pub fn manager_path(binding: &MuMuBinding) -> Result<PathBuf, String> {
    if !cfg!(target_os = "windows") {
        return Err("MUMU_UNSUPPORTED_PLATFORM: MuMuManager requires Windows".into());
    }
    if binding.path.trim().is_empty() {
        return Err("MUMU_MANAGER_NOT_FOUND: empty path".into());
    }
    manager_candidates(Path::new(&binding.path))
        .into_iter()
        .find(|p| p.is_file())
        .ok_or_else(|| format!("MUMU_MANAGER_NOT_FOUND: {}", binding.path))
}

#[derive(Debug, Deserialize)]
struct MuMuInfo {
    #[serde(deserialize_with = "deserialize_index")]
    index: u32,
    #[serde(default)]
    is_android_started: bool,
    #[serde(default)]
    is_process_started: bool,
    #[serde(default)]
    launch_err_code: i64,
    #[serde(default)]
    launch_err_msg: String,
}

fn deserialize_index<'de, D: serde::Deserializer<'de>>(deserializer: D) -> Result<u32, D::Error> {
    let value = serde_json::Value::deserialize(deserializer)?;
    match value {
        serde_json::Value::String(s) => s.parse().map_err(serde::de::Error::custom),
        serde_json::Value::Number(n) => n
            .as_u64()
            .and_then(|n| u32::try_from(n).ok())
            .ok_or_else(|| serde::de::Error::custom("invalid MuMu index")),
        _ => Err(serde::de::Error::custom("invalid MuMu index")),
    }
}

fn parse_info(output: &str, index: u32) -> Result<MuMuInfo, String> {
    let info: MuMuInfo = serde_json::from_str(output.trim_start_matches('\u{feff}').trim())
        .map_err(|e| format!("MUMU_START_FAILED: invalid manager info: {e}"))?;
    if info.index != index {
        return Err(format!(
            "MUMU_BINDING_MISMATCH: expected index {index}, received {}",
            info.index
        ));
    }
    if info.launch_err_code != 0 {
        return Err(format!(
            "MUMU_START_FAILED: {} {}",
            info.launch_err_code, info.launch_err_msg
        ));
    }
    Ok(info)
}

async fn cancelled(cancel: &AtomicBool) {
    while !cancel.load(Ordering::Acquire) {
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
}

async fn run_manager(
    manager: &Path,
    args: &[String],
    cancel: &AtomicBool,
) -> Result<String, String> {
    let mut command = tokio::process::Command::new(manager);
    command.args(args).kill_on_drop(true);
    #[cfg(target_os = "windows")]
    command.creation_flags(0x08000000); // CREATE_NO_WINDOW
    let output = tokio::select! {
        _ = cancelled(cancel) => return Err("MUMU_START_CANCELLED".into()),
        result = tokio::time::timeout(Duration::from_secs(10), command.output()) => {
            result.map_err(|_| "MUMU_START_FAILED: manager command timed out".to_string())?
                .map_err(|e| format!("MUMU_START_FAILED: {e}"))?
        }
    };
    if !output.status.success() {
        return Err(format!(
            "MUMU_START_FAILED: manager exited {}: {}",
            output.status,
            String::from_utf8_lossy(&output.stderr)
        ));
    }
    String::from_utf8(output.stdout)
        .map_err(|e| format!("MUMU_START_FAILED: invalid UTF-8 output: {e}"))
}

async fn prepare(manager: &Path, binding: &MuMuBinding, cancel: &AtomicBool) -> Result<(), String> {
    let index = binding.index.to_string();
    let info_args = ["info".into(), "-v".into(), index.clone()];
    let info = parse_info(
        &run_manager(manager, &info_args, cancel).await?,
        binding.index,
    )?;
    if info.is_android_started && info.is_process_started {
        return Ok(());
    }
    // Do not launch again while a process is already booting.
    if !info.is_process_started {
        run_manager(
            manager,
            &["control".into(), "-v".into(), index, "launch".into()],
            cancel,
        )
        .await?;
    }
    loop {
        tokio::select! {
            _ = cancelled(cancel) => return Err("MUMU_START_CANCELLED".into()),
            _ = tokio::time::sleep(Duration::from_secs(1)) => {}
        }
        let info = parse_info(
            &run_manager(manager, &info_args, cancel).await?,
            binding.index,
        )?;
        if info.is_android_started && info.is_process_started {
            return Ok(());
        }
    }
}

pub async fn prepare_mumu_impl(
    state: &MaaState,
    instance_id: String,
    binding: MuMuBinding,
) -> Result<(), String> {
    let cancel = Arc::new(AtomicBool::new(false));
    {
        let mut starts = state.mumu_starts.lock().map_err(|e| e.to_string())?;
        if starts.contains_key(&instance_id) {
            return Err("MUMU_START_FAILED: preparation already in progress".into());
        }
        starts.insert(instance_id.clone(), cancel.clone());
    }
    let result = async {
        let manager = manager_path(&binding)?;
        tokio::time::timeout(
            Duration::from_secs(120),
            prepare(&manager, &binding, &cancel),
        )
        .await
        .map_err(|_| "MUMU_START_TIMEOUT: Android did not become ready within 120s".to_string())?
    }
    .await;
    state
        .mumu_starts
        .lock()
        .map_err(|e| e.to_string())?
        .remove(&instance_id);
    result
}

pub fn cancel_mumu_start_impl(state: &MaaState, instance_id: &str) -> Result<(), String> {
    if let Some(cancel) = state
        .mumu_starts
        .lock()
        .map_err(|e| e.to_string())?
        .get(instance_id)
    {
        cancel.store(true, Ordering::Release);
    }
    Ok(())
}

#[tauri::command]
pub async fn prepare_mumu(
    state: State<'_, Arc<MaaState>>,
    instance_id: String,
    binding: MuMuBinding,
) -> Result<(), String> {
    prepare_mumu_impl(&state, instance_id, binding).await
}

#[tauri::command]
pub fn cancel_mumu_start(
    state: State<'_, Arc<MaaState>>,
    instance_id: String,
) -> Result<(), String> {
    cancel_mumu_start_impl(&state, &instance_id)
}

pub async fn shutdown(binding: &MuMuBinding) -> Result<(), String> {
    let result = async {
        let manager = manager_path(binding)?;
        run_manager(
            &manager,
            &[
                "control".into(),
                "-v".into(),
                binding.index.to_string(),
                "shutdown".into(),
            ],
            &AtomicBool::new(false),
        )
        .await?;
        Ok::<_, String>(())
    }
    .await;
    result.map_err(|e| format!("MUMU_SHUTDOWN_FAILED: {e}"))
}

/// Only opt-in MuMu runs use deferred completion. The once claim is taken under
/// the instances lock in the callback, before this worker is scheduled.
pub fn finalize_run(state: Arc<MaaState>, app: tauri::AppHandle, instance_id: String) {
    tauri::async_runtime::spawn(async move {
        loop {
            let stopped = match state.instances.lock() {
                Ok(instances) => match instances.get(&instance_id) {
                    Some(instance) => !instance.tasker.as_ref().is_some_and(|t| t.running()),
                    None => return,
                },
                Err(_) => return,
            };
            if stopped {
                break;
            }
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
        let cleanup_state = state.clone();
        let cleanup_id = instance_id.clone();
        let cleanup = tauri::async_runtime::spawn_blocking(move || {
            super::maa_agent::stop_agent_impl(&cleanup_state, &cleanup_id)
        })
        .await;
        if !matches!(cleanup, Ok(Ok(()))) {
            log::warn!("MuMu finalization agent cleanup failed: {:?}", cleanup);
        }

        let binding = (|| {
            let instances = state.instances.lock().map_err(|e| e.to_string())?;
            let Some(instance) = instances.get(&instance_id) else {
                return Ok(None);
            };
            if instance.run_cancelled || instance.stop_in_progress {
                return Ok(None);
            }
            let Some(binding) = instance.mumu_shutdown_binding.as_ref() else {
                return Ok(None);
            };
            binding.validate_controller(instance.controller_config.as_ref())?;
            // A shared controller may have started after this run was armed.
            if instances.iter().any(|(id, other)| {
                id != &instance_id
                    && other.is_running()
                    && (other.controller_config == instance.controller_config
                        || other
                            .mumu_shutdown_binding
                            .as_ref()
                            .is_some_and(|b| binding.matches(b)))
            }) {
                return Err("MUMU_SHUTDOWN_FAILED: another running instance shares this controller or MuMu target".into());
            }
            Ok::<_, String>(Some(binding.clone()))
        })();
        let shutdown_result = match binding {
            Ok(Some(binding)) => shutdown(&binding).await,
            Ok(None) => Ok(()),
            Err(error) => Err(format!("MUMU_SHUTDOWN_FAILED: {error}")),
        };
        if let Err(error) = shutdown_result {
            log::warn!("{}", error);
            super::utils::emit_callback_event(
                &app,
                "MuMu.Shutdown.Failed".to_string(),
                serde_json::json!({"instance_id": instance_id, "error": error}).to_string(),
            );
        }
        let completed = if let Ok(mut instances) = state.instances.lock() {
            if let Some(instance) = instances.get_mut(&instance_id) {
                instance.finalizing = false;
                if !instance.run_cancelled {
                    instance.task_run_state.overall_status = Some(
                        if instance.run_has_failed {
                            "Failed"
                        } else {
                            "Succeeded"
                        }
                        .into(),
                    );
                }
                !instance.run_cancelled
            } else {
                false
            }
        } else {
            false
        };
        if completed {
            super::utils::emit_state_changed(&app, &instance_id, "tasks-completed");
        } else {
            super::utils::emit_state_changed(&app, &instance_id, "task-stopped");
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn resolves_only_manager_locations() {
        let paths = manager_candidates(Path::new("MuMu"));
        assert_eq!(paths[1], Path::new("MuMu/nx_main/MuMuManager.exe"));
        assert_eq!(paths[2], Path::new("MuMu/shell/MuMuManager.exe"));
        assert_eq!(
            manager_candidates(Path::new("MuMuManager.exe")),
            vec![PathBuf::from("MuMuManager.exe")]
        );
    }

    #[test]
    fn parses_documented_info_and_rejects_wrong_index_or_launch_error() {
        let raw = r#"{"index":"2","is_android_started":true,"is_process_started":true,"launch_err_code":0,"launch_err_msg":""}"#;
        assert!(parse_info(raw, 2).unwrap().is_android_started);
        assert!(parse_info(raw, 1)
            .unwrap_err()
            .contains("MUMU_BINDING_MISMATCH"));
        assert!(parse_info(
            &raw.replace("\"launch_err_code\":0", "\"launch_err_code\":3"),
            2
        )
        .is_err());
        assert!(parse_info(r#"{"index":"all"}"#, 0).is_err());
        assert!(parse_info(&raw.replace("\"2\"", "2"), 2).is_ok());
        let stopped = parse_info(r#"{"index":"0","name":"MuMu"}"#, 0).unwrap();
        assert!(!stopped.is_android_started && !stopped.is_process_started);
    }

    #[test]
    fn binding_matches_controller_not_stale_saved_device() {
        let binding = MuMuBinding {
            path: r#"C:\MuMu\"#.into(),
            index: 2,
        };
        let config = ControllerConfig::Adb {
            adb_path: String::new(),
            address: String::new(),
            screencap_methods: "0".into(),
            input_methods: "0".into(),
            config: r#"{"extras":{"mumu":{"enable":true,"path":"c:/mumu","index":2}}}"#.into(),
            display_short_side: None,
        };
        assert!(binding.validate_controller(Some(&config)).is_ok());
        let mut disabled = config.clone();
        if let ControllerConfig::Adb { config, .. } = &mut disabled {
            *config = config.replace("\"enable\":true", "\"enable\":false");
        }
        assert!(binding.validate_controller(Some(&disabled)).is_err());
        if let ControllerConfig::Adb { config, .. } = &mut disabled {
            *config = "{}".into();
        }
        assert!(binding.validate_controller(Some(&disabled)).is_err());
        assert!(MuMuBinding {
            index: 1,
            ..binding
        }
        .validate_controller(Some(&config))
        .is_err());
    }

    #[test]
    fn finalizer_claim_is_once_and_never_for_manual_stop_or_default_runs() {
        let mut instance = super::super::types::InstanceRuntime::default();
        instance.task_run_state.pending_task_ids = vec![1, 2];
        instance.completed_task_ids.extend([1, 2]);
        assert!(!instance.claim_finalization());
        instance.mumu_shutdown_binding = Some(MuMuBinding {
            path: "MuMu".into(),
            index: 0,
        });
        instance.run_cancelled = true;
        assert!(!instance.claim_finalization());
        instance.run_cancelled = false;
        instance.stop_in_progress = true;
        assert!(!instance.claim_finalization());
        instance.stop_in_progress = false;
        instance.completed_task_ids.remove(&2);
        assert!(!instance.claim_finalization());
        instance.completed_task_ids.insert(2);
        assert!(instance.claim_finalization());
        assert!(instance.finalizing && instance.is_running());
        assert!(!instance.claim_finalization());
        instance.finalizing = false;
        assert!(!instance.claim_finalization());
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn cancellation_interrupts_a_manager_subprocess() {
        let cancel = Arc::new(AtomicBool::new(false));
        let signal = cancel.clone();
        tokio::spawn(async move {
            tokio::time::sleep(Duration::from_millis(50)).await;
            signal.store(true, Ordering::Release);
        });
        let error = tokio::time::timeout(
            Duration::from_secs(2),
            run_manager(
                Path::new("/bin/sh"),
                &["-c".into(), "exec sleep 30".into()],
                &cancel,
            ),
        )
        .await
        .unwrap()
        .unwrap_err();
        assert_eq!(error, "MUMU_START_CANCELLED");
    }

    #[tokio::test]
    async fn cancellation_is_instance_scoped() {
        let state = MaaState::default();
        let a = Arc::new(AtomicBool::new(false));
        let b = Arc::new(AtomicBool::new(false));
        state
            .mumu_starts
            .lock()
            .unwrap()
            .extend([("a".into(), a.clone()), ("b".into(), b.clone())]);
        cancel_mumu_start_impl(&state, "a").unwrap();
        assert!(a.load(Ordering::Acquire));
        assert!(!b.load(Ordering::Acquire));
        tokio::time::timeout(Duration::from_millis(200), cancelled(&a))
            .await
            .unwrap();
    }
}
