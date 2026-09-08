#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    // 已有知记在运行时，唤起旧窗口并退出；否则第二个实例会白屏一闪而过。
    if zhiji_desktop_lib::focus_existing_instance() {
        return;
    }
    zhiji_desktop_lib::run();
}
