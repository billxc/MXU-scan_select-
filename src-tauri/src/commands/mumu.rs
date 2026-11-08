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

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MuMuStatus {
    pub exists: bool,
    pub is_process_started: bool,
    pub is_android_started: bool,
    pub name: Option<String>,
    pub adb_port: Option<u16>,
    pub adb_host_ip: Option<String>,
}

#[derive(Debug, Deserialize)]
struct MuMuInfo {
    #[serde(deserialize_with = "deserialize_index")]
    index: u32,
    #[serde(default)]
    name: Option<String>,
    #[serde(default)]
    adb_port: Option<u16>,
    #[serde(default)]
    adb_host_ip: Option<String>,
    #[serde(default)]
    is_android_started: bool,
    #[serde(default)]
    is_process_started: bool,
    #[serde(default)]
    launch_err_code: i64,
    #[serde(default)]
    launch_err_msg: String,
    #[serde(default)]
    pid: Option<u32>,
    #[serde(default)]
    main_wnd: Option<String>,
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

#[cfg(target_os = "windows")]
fn try_launch_via_explorer_medium_token(manager: &Path, args: &[String]) -> Result<(), String> {
    use std::ffi::c_void;
    use std::os::windows::ffi::OsStrExt;
    use winsafe::co::{CREATE, PROCESS, TOKEN};
    use winsafe::{HACCESSTOKEN, HPROCESS, HWND, PROCESS_INFORMATION, STARTUPINFO};

    #[link(name = "advapi32")]
    extern "system" {
        fn DuplicateTokenEx(
            hExistingToken: *mut c_void,
            dwDesiredAccess: u32,
            lpTokenAttributes: *const c_void,
            ImpersonationLevel: u32,
            TokenType: u32,
            phNewToken: *mut *mut c_void,
        ) -> i32;

        fn CreateProcessWithTokenW(
            hToken: *mut c_void,
            dwLogonFlags: u32,
            lpApplicationName: *const u16,
            lpCommandLine: *mut u16,
            dwCreationFlags: u32,
            lpEnvironment: *const c_void,
            lpCurrentDirectory: *const u16,
            lpStartupInfo: *mut c_void,
            lpProcessInformation: *mut c_void,
        ) -> i32;
    }

    #[link(name = "kernel32")]
    extern "system" {
        fn CloseHandle(hObject: *mut c_void) -> i32;
    }

    let shell_wnd = HWND::GetShellWindow().ok_or_else(|| "GetShellWindow returned None".to_string())?;
    let (_, shell_pid) = shell_wnd.GetWindowThreadProcessId();
    if shell_pid == 0 {
        return Err("shell_pid is 0".into());
    }

    let shell_proc = HPROCESS::OpenProcess(PROCESS::QUERY_LIMITED_INFORMATION, false, shell_pid)
        .map_err(|e| format!("OpenProcess(explorer) failed: {e}"))?;
    let shell_token = shell_proc
        .OpenProcessToken(TOKEN::DUPLICATE)
        .map_err(|e| format!("OpenProcessToken(explorer) failed: {e}"))?;

    // TOKEN_ASSIGN_PRIMARY (0x0001) | TOKEN_DUPLICATE (0x0002) | TOKEN_QUERY (0x0008)
    // | TOKEN_ADJUST_DEFAULT (0x0080) | TOKEN_ADJUST_SESSIONID (0x0100) | READ_CONTROL (0x00020000)
    const DESIRED_ACCESS: u32 = 0x0002_018B;
    const SECURITY_IMPERSONATION: u32 = 2;
    const TOKEN_TYPE_PRIMARY: u32 = 1;

    let mut primary_raw: *mut c_void = std::ptr::null_mut();
    let dup_ok = unsafe {
        DuplicateTokenEx(
            shell_token.ptr(),
            DESIRED_ACCESS,
            std::ptr::null(),
            SECURITY_IMPERSONATION,
            TOKEN_TYPE_PRIMARY,
            &mut primary_raw,
        )
    };
    if dup_ok == 0 || primary_raw.is_null() {
        return Err("DuplicateTokenEx failed".into());
    }
    let primary_token = unsafe { HACCESSTOKEN::from_ptr(primary_raw) };

    let mut cmd_line = format!("\"{}\"", manager.display());
    for arg in args {
        cmd_line.push(' ');
        if arg.contains(' ') || arg.contains('"') {
            cmd_line.push('"');
            cmd_line.push_str(&arg.replace('"', "\\\""));
            cmd_line.push('"');
        } else {
            cmd_line.push_str(arg);
        }
    }
    let mut cmd_wide: Vec<u16> = std::ffi::OsStr::new(&cmd_line)
        .encode_wide()
        .chain(std::iter::once(0))
        .collect();
    let work_dir_wide: Option<Vec<u16>> = manager.parent().map(|p| {
        p.as_os_str()
            .encode_wide()
            .chain(std::iter::once(0))
            .collect()
    });

    let mut si = STARTUPINFO::default();
    let mut pi = PROCESS_INFORMATION::default();
    let create_ok = unsafe {
        CreateProcessWithTokenW(
            primary_token.ptr(),
            0,
            std::ptr::null(),
            cmd_wide.as_mut_ptr(),
            CREATE::NO_WINDOW.raw(),
            std::ptr::null(),
            work_dir_wide
                .as_ref()
                .map_or(std::ptr::null(), |v| v.as_ptr()),
            &mut si as *mut _ as *mut c_void,
            &mut pi as *mut _ as *mut c_void,
        )
    };
    unsafe {
        let _ = CloseHandle(primary_raw);
    }
    if create_ok == 0 {
        return Err("CreateProcessWithTokenW failed".into());
    }

    let _ = pi.hProcess.WaitForSingleObject(Some(10_000));
    unsafe {
        if !pi.hThread.ptr().is_null() {
            let _ = CloseHandle(pi.hThread.ptr());
        }
        if !pi.hProcess.ptr().is_null() {
            let _ = CloseHandle(pi.hProcess.ptr());
        }
    }
    Ok(())
}

async fn run_manager(
    manager: &Path,
    args: &[String],
    cancel: &AtomicBool,
) -> Result<String, String> {
    #[cfg(target_os = "windows")]
    if args.iter().any(|a| a == "launch") {
        let manager_buf = manager.to_path_buf();
        let args_vec = args.to_vec();
        let via_explorer = tokio::task::spawn_blocking(move || {
            try_launch_via_explorer_medium_token(&manager_buf, &args_vec)
        })
        .await;
        match via_explorer {
            Ok(Ok(())) => {
                log::info!("Launched MuMuManager via interactive desktop Explorer token");
                return Ok(String::new());
            }
            Ok(Err(err)) => {
                log::warn!("Explorer token MuMu launch fallback to direct spawn: {err}");
            }
            Err(err) => {
                log::warn!("Explorer token MuMu launch task join error: {err}");
            }
        }
    }

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

fn parse_hide_window_output(output: &str) -> bool {
    let trimmed = output.trim_start_matches('\u{feff}').trim();
    if trimmed.is_empty() {
        return true;
    }
    let Ok(value) = serde_json::from_str::<serde_json::Value>(trimmed) else {
        return false;
    };
    let check_obj = |obj: &serde_json::Map<String, serde_json::Value>| -> bool {
        let code = obj.get("errcode").or_else(|| obj.get("error_code"));
        match code {
            Some(v) => v
                .as_i64()
                .or_else(|| v.as_str().and_then(|s| s.parse::<i64>().ok()))
                == Some(0),
            None => true,
        }
    };
    if let Some(obj) = value.as_object() {
        if obj.contains_key("errcode") || obj.contains_key("error_code") {
            return check_obj(obj);
        }
        return obj
            .values()
            .filter_map(|v| v.as_object())
            .all(check_obj);
    }
    false
}

async fn hide_window(manager: &Path, index: &str, cancel: &AtomicBool) -> bool {
    match run_manager(
        manager,
        &[
            "control".into(),
            "-v".into(),
            index.to_string(),
            "hide_window".into(),
        ],
        cancel,
    )
    .await
    {
        Ok(output) => parse_hide_window_output(&output),
        Err(_) => false,
    }
}

async fn ensure_mumu_adb_ready(
    manager: &Path,
    index: &str,
    info: &MuMuInfo,
    cancel: &AtomicBool,
) -> Result<(), String> {
    let _ = run_manager(
        manager,
        &[
            "adb".into(),
            "-v".into(),
            index.to_string(),
            "-c".into(),
            "connect".into(),
        ],
        cancel,
    )
    .await;

    let Some(port) = info.adb_port else {
        return Ok(());
    };
    let host = info.adb_host_ip.as_deref().unwrap_or("127.0.0.1");
    let address = format!("{host}:{port}");
    let Some(adb_exe) = manager
        .parent()
        .map(|p| p.join("adb.exe"))
        .filter(|p| p.is_file())
    else {
        return Ok(());
    };

    let deadline = tokio::time::Instant::now() + Duration::from_secs(30);
    loop {
        if cancel.load(Ordering::Acquire) {
            return Err("MUMU_START_CANCELLED".into());
        }

        let mut connect_cmd = tokio::process::Command::new(&adb_exe);
        connect_cmd.args(["connect", &address]).kill_on_drop(true);
        #[cfg(target_os = "windows")]
        connect_cmd.creation_flags(0x08000000);
        let _ = tokio::time::timeout(Duration::from_secs(4), connect_cmd.output()).await;

        let mut check_cmd = tokio::process::Command::new(&adb_exe);
        check_cmd
            .args(["-s", &address, "shell", "getprop", "sys.boot_completed"])
            .kill_on_drop(true);
        #[cfg(target_os = "windows")]
        check_cmd.creation_flags(0x08000000);
        if let Ok(Ok(out)) =
            tokio::time::timeout(Duration::from_secs(4), check_cmd.output()).await
        {
            if out.status.success() {
                let text = String::from_utf8_lossy(&out.stdout);
                if text.trim() == "1" {
                    return Ok(());
                }
            }
        }

        if tokio::time::Instant::now() >= deadline {
            log::warn!(
                "MuMu index {} ADB readiness check timed out on {}, proceeding anyway",
                index,
                address
            );
            return Ok(());
        }

        tokio::select! {
            _ = cancelled(cancel) => return Err("MUMU_START_CANCELLED".into()),
            _ = tokio::time::sleep(Duration::from_millis(800)) => {}
        }
    }
}

async fn prepare(manager: &Path, binding: &MuMuBinding, cancel: &AtomicBool) -> Result<(), String> {
    sanitize_mumu_environment(Some(manager)).await;
    let index = binding.index.to_string();
    let info_args = ["info".into(), "-v".into(), index.clone()];
    let raw_info = run_manager(manager, &info_args, cancel).await?;
    let info = match parse_info(&raw_info, binding.index) {
        Ok(info) => info,
        Err(err)
            if err.contains("VERR_VIRTUALBOX_ACCESSDENIED")
                || err.contains("-32218")
                || err.contains("-30110") =>
        {
            log::warn!(
                "MuMu index {} is stuck in error state ({}); shutting down and cleaning up lingering processes before retry",
                binding.index,
                err
            );
            let _ = run_manager(
                manager,
                &["control".into(), "-v".into(), index.clone(), "shutdown".into()],
                cancel,
            )
            .await;
            #[cfg(target_os = "windows")]
            cleanup_lingering_mumu_processes(binding, None, true).await;
            tokio::time::sleep(Duration::from_millis(800)).await;
            parse_info(
                &run_manager(manager, &info_args, cancel).await?,
                binding.index,
            )?
        }
        Err(err) => return Err(err),
    };
    if info.is_android_started && info.is_process_started {
        ensure_mumu_adb_ready(manager, &index, &info, cancel).await?;
        return Ok(());
    }
    // Before launching, ensure no zombie MuMuNxDevice.exe for this index or Session 0 MuMuNxMain is holding VBox COM locks
    if !info.is_process_started {
        #[cfg(target_os = "windows")]
        cleanup_lingering_mumu_processes(binding, info.name.as_deref(), false).await;
        run_manager(
            manager,
            &["control".into(), "-v".into(), index.clone(), "launch".into()],
            cancel,
        )
        .await?;
    }
    let mut window_hidden = if info.is_process_started {
        hide_window(manager, &index, cancel).await
    } else {
        false
    };
    let mut recovered_in_loop = false;
    loop {
        let poll_interval = if window_hidden {
            Duration::from_millis(1000)
        } else {
            Duration::from_millis(250)
        };
        tokio::select! {
            _ = cancelled(cancel) => return Err("MUMU_START_CANCELLED".into()),
            _ = tokio::time::sleep(poll_interval) => {}
        }
        let raw_poll = run_manager(manager, &info_args, cancel).await?;
        let info = match parse_info(&raw_poll, binding.index) {
            Ok(info) => info,
            Err(err)
                if !recovered_in_loop
                    && (err.contains("VERR_VIRTUALBOX_ACCESSDENIED")
                        || err.contains("-32218")
                        || err.contains("-30110")) =>
            {
                recovered_in_loop = true;
                log::warn!(
                    "MuMu index {} hit launch error during polling ({}); performing one-time recovery and relaunch",
                    binding.index,
                    err
                );
                let _ = run_manager(
                    manager,
                    &["control".into(), "-v".into(), index.clone(), "shutdown".into()],
                    cancel,
                )
                .await;
                #[cfg(target_os = "windows")]
                cleanup_lingering_mumu_processes(binding, None, true).await;
                tokio::time::sleep(Duration::from_millis(1000)).await;
                run_manager(
                    manager,
                    &["control".into(), "-v".into(), index.clone(), "launch".into()],
                    cancel,
                )
                .await?;
                window_hidden = false;
                continue;
            }
            Err(err) => return Err(err),
        };
        if info.is_process_started && !window_hidden {
            window_hidden = hide_window(manager, &index, cancel).await;
        }
        if info.is_android_started && info.is_process_started {
            if !window_hidden {
                let _ = hide_window(manager, &index, cancel).await;
            }
            ensure_mumu_adb_ready(manager, &index, &info, cancel).await?;
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

pub async fn query_mumu_status_impl(binding: &MuMuBinding) -> Result<MuMuStatus, String> {
    let Ok(manager) = manager_path(binding) else {
        return Ok(MuMuStatus {
            exists: false,
            is_process_started: false,
            is_android_started: false,
            name: None,
            adb_port: None,
            adb_host_ip: None,
        });
    };
    let cancel = AtomicBool::new(false);
    let info_args = ["info".into(), "-v".into(), binding.index.to_string()];
    let Ok(output) = run_manager(&manager, &info_args, &cancel).await else {
        return Ok(MuMuStatus {
            exists: false,
            is_process_started: false,
            is_android_started: false,
            name: None,
            adb_port: None,
            adb_host_ip: None,
        });
    };
    let Ok(info) = parse_info(&output, binding.index) else {
        return Ok(MuMuStatus {
            exists: false,
            is_process_started: false,
            is_android_started: false,
            name: None,
            adb_port: None,
            adb_host_ip: None,
        });
    };
    Ok(MuMuStatus {
        exists: true,
        is_process_started: info.is_process_started,
        is_android_started: info.is_android_started,
        name: info.name,
        adb_port: info.adb_port,
        adb_host_ip: info.adb_host_ip,
    })
}

#[tauri::command]
pub async fn query_mumu_status(binding: MuMuBinding) -> Result<MuMuStatus, String> {
    query_mumu_status_impl(&binding).await
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

pub struct ReleasedMuMuResources {
    pub affected_ids: Vec<String>,
    pub adb_endpoints: Vec<(String, String)>,
}

pub fn release_mumu_controllers(state: &MaaState, binding: &MuMuBinding) -> ReleasedMuMuResources {
    let (affected_ids, adb_endpoints, mut dropped_taskers, mut dropped_controllers) = {
        let Ok(mut instances) = state.instances.lock() else {
            return ReleasedMuMuResources {
                affected_ids: Vec::new(),
                adb_endpoints: Vec::new(),
            };
        };
        let mut ids = Vec::new();
        let mut endpoints = Vec::new();
        let mut taskers = Vec::new();
        let mut controllers = Vec::new();
        for (id, inst) in instances.iter_mut() {
            let matches_ctrl = binding
                .validate_controller(inst.controller_config.as_ref())
                .is_ok();
            let matches_shutdown = inst
                .mumu_shutdown_binding
                .as_ref()
                .is_some_and(|b| binding.matches(b));
            if matches_ctrl || matches_shutdown {
                ids.push(id.clone());
                if let Some(ControllerConfig::Adb {
                    adb_path, address, ..
                }) = inst.controller_config.as_ref()
                {
                    if !adb_path.trim().is_empty() && !address.trim().is_empty() {
                        let pair = (adb_path.clone(), address.clone());
                        if !endpoints.contains(&pair) {
                            endpoints.push(pair);
                        }
                    }
                }
                if let Some(t) = inst.tasker.take() {
                    taskers.push(t);
                }
                if let Some(c) = inst.controller.take() {
                    controllers.push(c);
                }
                inst.controller_config = None;
            }
        }
        (ids, endpoints, taskers, controllers)
    };

    for id in &affected_ids {
        state.screenshot_service.stop_instance(id);
    }

    let mut dropped_pooled = Vec::new();
    if let Ok(mut pool) = state.controller_pool.lock() {
        pool.retain(|cfg, ctrl| {
            if binding.validate_controller(Some(cfg)).is_ok() {
                dropped_pooled.push(ctrl.clone());
                false
            } else {
                true
            }
        });
    }

    // Explicitly drop taskers before controllers outside the lock so MaaFramework
    // calls nemu_disconnect() and closes adb shell MaaTouch pipes immediately.
    dropped_taskers.clear();
    dropped_controllers.clear();
    dropped_pooled.clear();

    ReleasedMuMuResources {
        affected_ids,
        adb_endpoints,
    }
}

async fn disconnect_mumu_adb(binding: &MuMuBinding, adb_endpoints: &[(String, String)]) {
    if let Ok(manager) = manager_path(binding) {
        let cancel = AtomicBool::new(false);
        let _ = run_manager(
            &manager,
            &[
                "adb".into(),
                "-v".into(),
                binding.index.to_string(),
                "-c".into(),
                "disconnect".into(),
            ],
            &cancel,
        )
        .await;
    }

    for (adb_path, address) in adb_endpoints {
        let mut cmd = tokio::process::Command::new(adb_path);
        cmd.args(["disconnect", address]).kill_on_drop(true);
        #[cfg(target_os = "windows")]
        cmd.creation_flags(0x08000000); // CREATE_NO_WINDOW
        let _ = tokio::time::timeout(Duration::from_secs(3), cmd.output()).await;
    }
}

#[cfg(target_os = "windows")]
async fn run_taskkill(args: &[&str]) {
    let mut cmd = tokio::process::Command::new("taskkill.exe");
    cmd.args(args).kill_on_drop(true).creation_flags(0x08000000);
    let _ = tokio::time::timeout(Duration::from_secs(3), cmd.output()).await;
}

#[cfg(target_os = "windows")]
fn discover_mumu_manager_path(manager_hint: Option<&Path>) -> Option<PathBuf> {
    if let Some(hint) = manager_hint {
        if let Some(found) = manager_candidates(hint).into_iter().find(|p| p.is_file()) {
            return Some(found);
        }
    }
    const COMMON_ROOTS: &[&str] = &[
        r"F:\Program Files\Netease\MuMu",
        r"C:\Program Files\Netease\MuMu",
        r"D:\Program Files\Netease\MuMu",
        r"E:\Program Files\Netease\MuMu",
        r"G:\Program Files\Netease\MuMu",
        r"C:\Program Files\Netease\MuMuPlayer-12.0",
        r"D:\Program Files\Netease\MuMuPlayer-12.0",
        r"E:\Program Files\Netease\MuMuPlayer-12.0",
        r"F:\Program Files\Netease\MuMuPlayer-12.0",
        r"G:\Program Files\Netease\MuMuPlayer-12.0",
    ];
    for root in COMMON_ROOTS {
        if let Some(found) = manager_candidates(Path::new(root))
            .into_iter()
            .find(|p| p.is_file())
        {
            return Some(found);
        }
    }
    None
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ZombieVmReport {
    pub index: u32,
    pub pid: Option<u32>,
    pub reason: String,
}

/// Pure classifier for `MuMuManager.exe info -v all` JSON output:
/// returns `(zombie_vms, any_healthy_running_vm)`.
pub fn classify_mumu_all_info(raw: &str, ignore_index: Option<u32>) -> (Vec<ZombieVmReport>, bool) {
    let trimmed = raw.trim_start_matches('\u{feff}').trim();
    let Ok(map) = serde_json::from_str::<serde_json::Map<String, serde_json::Value>>(trimmed) else {
        // If output is a single VM object (when only 1 VM exists in some MuMu versions)
        if let Ok(single) = serde_json::from_str::<MuMuInfo>(trimmed) {
            let mut m = serde_json::Map::new();
            if let Ok(val) = serde_json::from_str::<serde_json::Value>(trimmed) {
                m.insert(single.index.to_string(), val);
                return classify_mumu_map(&m, ignore_index);
            }
        }
        return (Vec::new(), true);
    };
    classify_mumu_map(&map, ignore_index)
}

fn classify_mumu_map(
    map: &serde_json::Map<String, serde_json::Value>,
    ignore_index: Option<u32>,
) -> (Vec<ZombieVmReport>, bool) {
    let mut zombies = Vec::new();
    let mut any_healthy_running = false;

    for val in map.values() {
        let Ok(info) = serde_json::from_value::<MuMuInfo>(val.clone()) else {
            continue;
        };
        if ignore_index == Some(info.index) {
            continue;
        }
        let has_pid = info.pid.unwrap_or(0) > 0;
        let has_wnd = info
            .main_wnd
            .as_deref()
            .is_some_and(|w| !w.trim().is_empty() && w.trim() != "0");

        if info.launch_err_code != 0 {
            zombies.push(ZombieVmReport {
                index: info.index,
                pid: info.pid,
                reason: format!("launch_err_code={} ({})", info.launch_err_code, info.launch_err_msg),
            });
        } else if !info.is_process_started && (info.is_android_started || has_pid || has_wnd) {
            zombies.push(ZombieVmReport {
                index: info.index,
                pid: info.pid,
                reason: format!(
                    "is_process_started=false but is_android_started={}, pid={:?}, main_wnd={:?}",
                    info.is_android_started, info.pid, info.main_wnd
                ),
            });
        } else if info.is_process_started {
            any_healthy_running = true;
        }
    }

    (zombies, any_healthy_running)
}

/// Unified, zero-PowerShell MuMu environment sanitizer.
/// - Purges any Session 0 MuMu processes (`MuMuNxMain`, `MuMuNxService`, `MuMuNxDevice`, `MuMuVMMHeadless`).
/// - Queries `MuMuManager.exe info -v all` to detect and reap any zombie/half-dead VMs (where `MuMuVMMHeadless` died
///   or `launch_err_code != 0`, leaving an orphan `MuMuNxDevice.exe` that causes ADB port drift `16480 -> 16481`).
/// - When zero healthy VMs are running, sweeps all remaining orphan `MuMuNxDevice.exe` and `MuMuVMMHeadless.exe` processes.
pub async fn sanitize_mumu_environment(manager_hint: Option<&Path>) {
    #[cfg(not(target_os = "windows"))]
    {
        let _ = manager_hint;
    }
    #[cfg(target_os = "windows")]
    {
        // Step 1: Fast Session 0 purge (<50ms via taskkill.exe, no PowerShell needed)
        run_taskkill(&[
            "/F",
            "/FI",
            "SESSION eq 0",
            "/IM",
            "MuMuNxMain.exe",
            "/IM",
            "MuMuNxService.exe",
            "/IM",
            "MuMuNxDevice.exe",
            "/IM",
            "MuMuVMMHeadless.exe",
        ])
        .await;

        // Step 2: Locate MuMuManager.exe and inspect `info -v all`
        let Some(manager) = discover_mumu_manager_path(manager_hint) else {
            return;
        };
        let cancel = AtomicBool::new(false);
        let Ok(raw) = run_manager(&manager, &["info".into(), "-v".into(), "all".into()], &cancel).await else {
            return;
        };

        let (zombies, any_healthy_running) = classify_mumu_all_info(&raw, None);

        // Step 3: Reap any zombie VM entries reported by MuMuManager
        for z in &zombies {
            log::warn!(
                "Sanitizing zombie MuMu instance {} (pid={:?}, reason={})",
                z.index,
                z.pid,
                z.reason
            );
            let _ = run_manager(
                &manager,
                &[
                    "control".into(),
                    "-v".into(),
                    z.index.to_string(),
                    "shutdown".into(),
                ],
                &cancel,
            )
            .await;
            if let Some(pid) = z.pid.filter(|&p| p > 0) {
                let pid_str = pid.to_string();
                run_taskkill(&["/F", "/PID", &pid_str, "/T"]).await;
            }
        }

        // Step 4: If zero healthy VMs are running across all indices, any remaining
        // MuMuNxDevice.exe or MuMuVMMHeadless.exe in the system is 100% an unindexed orphan/ghost.
        if !any_healthy_running {
            run_taskkill(&[
                "/F",
                "/IM",
                "MuMuNxDevice.exe",
                "/IM",
                "MuMuVMMHeadless.exe",
            ])
            .await;
        }
    }
}

#[cfg(target_os = "windows")]
async fn cleanup_lingering_mumu_processes(
    binding: &MuMuBinding,
    _vm_name: Option<&str>,
    reset_vmm_svc: bool,
) {
    let manager = manager_path(binding).ok();
    if let Some(ref mgr) = manager {
        let cancel = AtomicBool::new(false);
        if let Ok(raw) = run_manager(
            mgr,
            &["info".into(), "-v".into(), binding.index.to_string()],
            &cancel,
        )
        .await
        {
            if let Ok(info) = serde_json::from_str::<MuMuInfo>(raw.trim_start_matches('\u{feff}').trim()) {
                if let Some(pid) = info.pid.filter(|&p| p > 0) {
                    let pid_str = pid.to_string();
                    run_taskkill(&["/F", "/PID", &pid_str, "/T"]).await;
                }
            }
        }
    }

    sanitize_mumu_environment(manager.as_deref()).await;

    if reset_vmm_svc {
        if let Some(ref mgr) = manager {
            let cancel = AtomicBool::new(false);
            if let Ok(raw) = run_manager(mgr, &["info".into(), "-v".into(), "all".into()], &cancel).await {
                let (_, any_other_running) = classify_mumu_all_info(&raw, Some(binding.index));
                if !any_other_running {
                    run_taskkill(&[
                        "/F",
                        "/IM",
                        "MuMuNxDevice.exe",
                        "/IM",
                        "MuMuVMMHeadless.exe",
                        "/IM",
                        "MuMuVMMSVC.exe",
                    ])
                    .await;
                }
            }
        }
    }
}

pub async fn shutdown(binding: &MuMuBinding) -> Result<(), String> {
    let result = async {
        let manager = manager_path(binding)?;
        let cancel = AtomicBool::new(false);
        let initial_raw = run_manager(
            &manager,
            &["info".into(), "-v".into(), binding.index.to_string()],
            &cancel,
        )
        .await
        .ok();
        let initial_info = initial_raw
            .as_deref()
            .and_then(|r| serde_json::from_str::<MuMuInfo>(r.trim_start_matches('\u{feff}').trim()).ok());
        let initial_pid = initial_info.as_ref().and_then(|i| i.pid).filter(|&p| p > 0);
        let vm_name = initial_info.as_ref().and_then(|i| i.name.clone());

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

        // Poll up to 8 seconds for is_process_started to become false
        let deadline = tokio::time::Instant::now() + Duration::from_secs(8);
        let mut stopped = false;
        while tokio::time::Instant::now() < deadline {
            tokio::time::sleep(Duration::from_millis(500)).await;
            if let Ok(status) = query_mumu_status_impl(binding).await {
                if !status.is_process_started && !status.is_android_started {
                    stopped = true;
                    break;
                }
            }
        }

        if !stopped {
            log::warn!(
                "MuMu index {} still running 8s after shutdown; retrying shutdown and cleaning up lingering processes",
                binding.index
            );
            let _ = run_manager(
                &manager,
                &[
                    "control".into(),
                    "-v".into(),
                    binding.index.to_string(),
                    "shutdown".into(),
                ],
                &AtomicBool::new(false),
            )
            .await;
        }

        #[cfg(target_os = "windows")]
        {
            if let Some(pid) = initial_pid {
                let pid_str = pid.to_string();
                run_taskkill(&["/F", "/PID", &pid_str, "/T"]).await;
            }
            cleanup_lingering_mumu_processes(binding, vm_name.as_deref(), false).await;
        }

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
            Ok(Some(binding)) => {
                // Step 1: Stop screenshot streams and drop all MaaFramework Controller/Tasker handles
                // (including ControllerPool) BEFORE shutting down MuMu so external_renderer_ipc.dll
                // shared memory and MaaTouch ADB pipes are cleanly released first.
                let released = release_mumu_controllers(&state, &binding);
                for id in &released.affected_ids {
                    super::utils::emit_callback_event(
                        &app,
                        "Controller.MuMu.Disconnected".to_string(),
                        serde_json::json!({"instance_id": id}).to_string(),
                    );
                }
                // Step 2: Explicitly disconnect ADB from the target MuMu instance before shutdown
                disconnect_mumu_adb(&binding, &released.adb_endpoints).await;
                // Step 3: Shutdown MuMu and verify process exit (with zombie cleanup fallback)
                let res = shutdown(&binding).await;
                for id in &released.affected_ids {
                    super::utils::emit_state_changed(&app, id, "disconnected");
                }
                res
            }
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

    #[test]
    fn release_mumu_controllers_clears_matching_instances_and_extracts_adb_endpoints() {
        let state = MaaState::default();
        let target_binding = MuMuBinding {
            path: r#"F:\Program Files\Netease\MuMu"#.into(),
            index: 3,
        };
        let other_binding = MuMuBinding {
            path: r#"F:\Program Files\Netease\MuMu"#.into(),
            index: 1,
        };
        let target_config = ControllerConfig::Adb {
            adb_path: r#"F:\Program Files\Netease\MuMu\nx_main\adb.exe"#.into(),
            address: "127.0.0.1:16480".into(),
            screencap_methods: "1".into(),
            input_methods: "1".into(),
            config: r#"{"extras":{"mumu":{"enable":true,"path":"F:/Program Files/Netease/MuMu","index":3}}}"#.into(),
            display_short_side: None,
        };
        let other_config = ControllerConfig::Adb {
            adb_path: r#"F:\Program Files\Netease\MuMu\nx_main\adb.exe"#.into(),
            address: "127.0.0.1:16416".into(),
            screencap_methods: "1".into(),
            input_methods: "1".into(),
            config: r#"{"extras":{"mumu":{"enable":true,"path":"F:/Program Files/Netease/MuMu","index":1}}}"#.into(),
            display_short_side: None,
        };

        {
            let mut instances = state.instances.lock().unwrap();
            let mut inst_a = super::super::types::InstanceRuntime::default();
            inst_a.controller_config = Some(target_config);
            inst_a.mumu_shutdown_binding = Some(target_binding.clone());
            instances.insert("inst-a".into(), inst_a);

            let mut inst_b = super::super::types::InstanceRuntime::default();
            inst_b.controller_config = Some(other_config.clone());
            inst_b.mumu_shutdown_binding = Some(other_binding);
            instances.insert("inst-b".into(), inst_b);
        }

        let released = release_mumu_controllers(&state, &target_binding);
        assert_eq!(released.affected_ids, vec!["inst-a".to_string()]);
        assert_eq!(
            released.adb_endpoints,
            vec![(
                r#"F:\Program Files\Netease\MuMu\nx_main\adb.exe"#.to_string(),
                "127.0.0.1:16480".to_string()
            )]
        );

        let instances = state.instances.lock().unwrap();
        assert!(instances.get("inst-a").unwrap().controller_config.is_none());
        assert_eq!(
            instances.get("inst-b").unwrap().controller_config,
            Some(other_config)
        );
    }

    #[test]
    fn parses_hide_window_output_correctly() {
        assert!(parse_hide_window_output(""));
        assert!(parse_hide_window_output("   \n "));
        assert!(parse_hide_window_output(r#"{"errcode":0,"errmsg":"success"}"#));
        assert!(parse_hide_window_output("\u{feff}{\"errcode\":0,\"errmsg\":\"success\"}"));
        assert!(parse_hide_window_output(r#"{"3":{"errcode":0,"errmsg":"success"}}"#));
        assert!(!parse_hide_window_output(r#"{"errcode":-201,"errmsg":"window not ready"}"#));
        assert!(!parse_hide_window_output(r#"{"3":{"errcode":-201,"errmsg":"not started"}}"#));
        assert!(!parse_hide_window_output("not valid json"));
    }

    #[test]
    fn classifies_zombie_and_healthy_vms_from_all_info() {
        let raw_with_zombie = r#"{
            "0": {"index":"0","is_android_started":false,"is_process_started":false,"name":"MuMu安卓设备"},
            "1": {"index":"1","is_android_started":false,"is_process_started":false,"name":"小号"},
            "3": {"index":"3","is_android_started":true,"is_process_started":false,"name":"大号","pid":33588}
        }"#;
        let (zombies, any_healthy) = classify_mumu_all_info(raw_with_zombie, None);
        assert_eq!(zombies.len(), 1);
        assert_eq!(zombies[0].index, 3);
        assert_eq!(zombies[0].pid, Some(33588));
        assert!(!any_healthy);

        let raw_with_err = r#"{
            "1": {"index":"1","is_android_started":true,"is_process_started":true,"name":"小号","pid":1200},
            "3": {"index":"3","is_android_started":false,"is_process_started":true,"launch_err_code":-32218,"launch_err_msg":"VERR_VIRTUALBOX_ACCESSDENIED","pid":5312}
        }"#;
        let (zombies2, any_healthy2) = classify_mumu_all_info(raw_with_err, None);
        assert_eq!(zombies2.len(), 1);
        assert_eq!(zombies2[0].index, 3);
        assert_eq!(zombies2[0].pid, Some(5312));
        assert!(any_healthy2);
    }
}
