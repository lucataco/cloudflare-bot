#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::{sync::Mutex, time::{Duration, Instant}};
use tauri::{Manager, WebviewUrl, WebviewWindow, WebviewWindowBuilder, menu::{Menu, MenuItem, Submenu}, tray::TrayIconBuilder};
use tauri_plugin_notification::NotificationExt;
use url::Url;

#[derive(Default)]
struct DesktopState {
    origin: Mutex<Option<Url>>,
    last_notification: Mutex<Option<Instant>>,
}

fn workshop_url(value: &str) -> Result<Url, String> {
    let mut url = Url::parse(value).map_err(|_| "Enter a Workshop URL")?;
    let loopback = matches!(url.host_str(), Some("localhost" | "127.0.0.1" | "[::1]"));
    if !url.username().is_empty() || url.password().is_some() ||
        !(url.scheme() == "https" || url.scheme() == "http" && loopback) {
        return Err("Use HTTPS, or HTTP on localhost for development".into());
    }
    url.set_path("/"); url.set_query(None); url.set_fragment(None);
    Ok(url)
}

fn show(app: &tauri::AppHandle, path: Option<&str>) {
    if let Some(window) = app.get_webview_window("workshop") {
        if let Some(path) = path {
            if let Some(origin) = app.state::<DesktopState>().origin.lock().unwrap().as_ref() {
                if let Ok(url) = origin.join(path) { let _ = window.navigate(url); }
            }
        }
        let _ = window.show(); let _ = window.unminimize(); let _ = window.set_focus();
    } else if let Some(window) = app.get_webview_window("setup") { let _ = window.show(); let _ = window.set_focus(); }
}

#[tauri::command]
fn open_workshop(app: tauri::AppHandle, window: WebviewWindow, value: String) -> Result<(), String> {
    if window.label() != "setup" { return Err("Setup window required".into()); }
    let origin = workshop_url(&value)?;
    if app.get_webview_window("workshop").is_some() { return Err("Workshop already open".into()); }
    *app.state::<DesktopState>().origin.lock().unwrap() = Some(origin.clone());
    let permitted = origin.origin();
    let workshop = WebviewWindowBuilder::new(&app, "workshop", WebviewUrl::External(origin))
        .title("Cloudflare OS").inner_size(1200.0, 800.0)
        .on_navigation(move |url| url.origin() == permitted)
        .build().map_err(|_| "Could not open Workshop")?;
    let handle = workshop.clone();
    workshop.on_window_event(move |event| {
        if let tauri::WindowEvent::CloseRequested { api, .. } = event { api.prevent_close(); let _ = handle.hide(); }
    });
    window.hide().map_err(|_| "Could not close setup")?;
    Ok(())
}

#[tauri::command]
fn notify_attention(app: tauri::AppHandle, window: WebviewWindow) -> Result<(), String> {
    let state = app.state::<DesktopState>();
    let configured = state.origin.lock().unwrap();
    let current = window.url().map_err(|_| "Window unavailable")?;
    if window.label() != "workshop" || configured.as_ref().is_none_or(|url| url.origin() != current.origin()) {
        return Err("Workshop window required".into());
    }
    let mut last = state.last_notification.lock().unwrap();
    if last.is_some_and(|time| time.elapsed() < Duration::from_secs(15)) { return Ok(()); }
    *last = Some(Instant::now());
    app.notification().builder().title("Cloudflare OS")
        .body("You have a workspace update. Open your inbox to review it.")
        .show().map_err(|_| "Notification unavailable".into())
}

fn main() {
    tauri::Builder::default()
        .manage(DesktopState::default())
        .plugin(tauri_plugin_notification::init())
        .invoke_handler(tauri::generate_handler![open_workshop, notify_attention])
        .setup(|app| {
            let open = MenuItem::with_id(app, "open", "Open Workshop", true, None::<&str>)?;
            let new_bot = MenuItem::with_id(app, "new-bot", "New bot", true, Some("CmdOrCtrl+N"))?;
            let inbox = MenuItem::with_id(app, "inbox", "Inbox and approvals", true, None::<&str>)?;
            let quit = MenuItem::with_id(app, "quit", "Quit", true, Some("CmdOrCtrl+Q"))?;
            let submenu = Submenu::with_items(app, "Workshop", true, &[&open, &new_bot, &inbox, &quit])?;
            app.set_menu(Menu::with_items(app, &[&submenu])?)?;
            app.on_menu_event(|app, event| match event.id.as_ref() {
                "new-bot" => show(app, Some("/agents?create=bot")),
                "inbox" => show(app, Some("/attention")),
                "open" => show(app, None),
                "quit" => app.exit(0),
                _ => (),
            });
            let tray_menu = Menu::with_items(app, &[&open, &new_bot, &inbox, &quit])?;
            let icon = tauri::image::Image::from_bytes(include_bytes!("../icons/32x32.png"))?;
            TrayIconBuilder::new().icon(icon).tooltip("Cloudflare OS").menu(&tray_menu).build(app)?;
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("Desktop initialization failed");
}

#[cfg(test)]
mod tests {
    use super::workshop_url;
    #[test]
    fn pins_origin_and_rejects_credentials_and_non_web_schemes() {
        assert_eq!(workshop_url("https://os.example/agents?token=x#secret").unwrap().as_str(), "https://os.example/");
        for bad in ["https://user:secret@os.example", "http://remote.example", "file:///tmp/x", "javascript:alert(1)"] { assert!(workshop_url(bad).is_err()); }
        assert!(workshop_url("http://localhost:8787").is_ok());
    }
}
