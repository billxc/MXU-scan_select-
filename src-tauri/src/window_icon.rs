//! Keep the Windows taskbar icon in sync with Tauri's window icon.
//!
//! Tauri 2's set_icon updates ICON_SMALL only. Windows uses a separate ICON_BIG
//! for the taskbar/Alt+Tab; copying it also gives us an independent lifetime.

#[tauri::command]
pub async fn sync_window_taskbar_icon(window: tauri::Window) -> Result<(), String> {
    #[cfg(windows)]
    {
        let (sender, receiver) = tokio::sync::oneshot::channel();
        let target = window.clone();
        // Run after Tauri's queued set_icon operation, on the window's thread.
        window
            .run_on_main_thread(move || {
                let result = target
                    .hwnd()
                    .map_err(|e| format!("Failed to get window handle: {e}"))
                    .and_then(|hwnd| {
                        let hwnd = unsafe { winsafe::HWND::from_ptr(hwnd.0) };
                        windows::sync(target.label(), &hwnd)
                    });
                let _ = sender.send(result);
            })
            .map_err(|e| format!("Failed to schedule taskbar icon update: {e}"))?;
        receiver
            .await
            .map_err(|e| format!("Taskbar icon update interrupted: {e}"))?
    }
    #[cfg(not(windows))]
    {
        let _ = window;
        Ok(())
    }
}

#[cfg(windows)]
pub fn release_taskbar_icon(label: &str) {
    windows::release(label);
}

#[cfg(windows)]
mod windows {
    use std::{cell::RefCell, collections::HashMap};
    use winsafe::{co, guard::DestroyIconGuard, msg, HICON, HWND};

    thread_local! {
        // Only accessed on the UI thread. Do not destroy an icon while a window
        // still references it, and never destroy Tauri's borrowed small icon.
        static ICONS: RefCell<HashMap<String, DestroyIconGuard>> = RefCell::new(HashMap::new());
    }

    fn copy_small_icon(hwnd: &HWND) -> Result<DestroyIconGuard, String> {
        let handle = unsafe {
            hwnd.SendMessage(msg::Wm::new(co::WM::GETICON, co::ICON_SZ::SMALL.raw() as _, 0))
        };
        if handle == 0 {
            return Err("Window has no small icon to use for the taskbar".into());
        }
        let small_icon = unsafe { HICON::from_ptr(handle as _) };
        small_icon
            .CopyIcon()
            .map_err(|e| format!("Failed to copy taskbar icon: {e}"))
    }

    pub(super) fn sync(label: &str, hwnd: &HWND) -> Result<(), String> {
        let icon = copy_small_icon(hwnd)?;
        unsafe {
            hwnd.SendMessage(msg::WmSetIcon {
                size: co::ICON_SZ::BIG,
                hicon: icon.raw_copy(),
            });
        }
        // WM_SETICON has replaced the old handle before its guard is dropped.
        ICONS.with(|icons| icons.borrow_mut().insert(label.to_owned(), icon));
        Ok(())
    }

    pub(super) fn release(label: &str) {
        ICONS.with(|icons| icons.borrow_mut().remove(label));
    }

    #[cfg(test)]
    mod tests {
        use super::*;
        use winsafe::{prelude::Handle, AtomStr, HINSTANCE, IdIdiStr, IdMenu, POINT, SIZE};

        struct TestWindow(HWND);

        impl TestWindow {
            fn new() -> Self {
                // STATIC is a system window class with a default window proc.
                Self(unsafe {
                    HWND::CreateWindowEx(
                        co::WS_EX::default(),
                        AtomStr::from_str("STATIC"),
                        None,
                        co::WS::OVERLAPPED,
                        POINT::default(),
                        SIZE::default(),
                        None,
                        IdMenu::None,
                        &HINSTANCE::NULL,
                        None,
                    )
                    .unwrap()
                })
            }

            fn icon(&self, size: co::ICON_SZ) -> isize {
                unsafe { self.0.SendMessage(msg::Wm::new(co::WM::GETICON, size.raw() as _, 0)) }
            }

            fn set_small_icon(&self, icon: &HICON) {
                unsafe {
                    self.0.SendMessage(msg::WmSetIcon {
                        size: co::ICON_SZ::SMALL,
                        hicon: icon.raw_copy(),
                    });
                }
            }
        }

        impl Drop for TestWindow {
            fn drop(&mut self) {
                self.0.DestroyWindow().unwrap();
                release("test");
            }
        }

        #[test]
        fn taskbar_icon_is_owned_replaced_and_released_independently() {
            let window = TestWindow::new();
            assert_eq!(window.icon(co::ICON_SZ::BIG), 0);
            let source = HINSTANCE::NULL
                .LoadIcon(IdIdiStr::Idi(co::IDI::APPLICATION))
                .unwrap();
            let first_small = source.CopyIcon().unwrap();
            window.set_small_icon(&first_small);
            sync("test", &window.0).unwrap();
            let first_big = window.icon(co::ICON_SZ::BIG);
            assert_ne!(first_big, 0);
            assert_ne!(first_big, window.icon(co::ICON_SZ::SMALL));

            // Tauri may drop its old small icon before the next sync command.
            let next_small = source.CopyIcon().unwrap();
            window.set_small_icon(&next_small);
            drop(first_small);
            let old_big = unsafe { HICON::from_ptr(first_big as _) };
            assert!(old_big.CopyIcon().is_ok());
            sync("test", &window.0).unwrap();
            let next_big = window.icon(co::ICON_SZ::BIG);
            assert_ne!(first_big, next_big);
            assert!(old_big.CopyIcon().is_err());
            assert_eq!(window.icon(co::ICON_SZ::SMALL), next_small.ptr() as isize);

            drop(window);
            let released = unsafe { HICON::from_ptr(next_big as _) };
            assert!(released.CopyIcon().is_err());
            assert!(next_small.CopyIcon().is_ok());
        }

        #[test]
        fn missing_small_icon_preserves_existing_taskbar_icon() {
            let window = TestWindow::new();
            let source = HINSTANCE::NULL
                .LoadIcon(IdIdiStr::Idi(co::IDI::APPLICATION))
                .unwrap();
            window.set_small_icon(&source);
            sync("test", &window.0).unwrap();
            let big = window.icon(co::ICON_SZ::BIG);
            window.set_small_icon(&HICON::NULL);
            assert!(sync("test", &window.0).is_err());
            assert_eq!(window.icon(co::ICON_SZ::BIG), big);
        }
    }
}
