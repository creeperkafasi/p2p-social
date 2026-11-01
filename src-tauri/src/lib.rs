// Tauri shell: hosts the webview UI and runs the Bare backend as a child process.
// UI -> `send` command -> backend stdin (one JSON object per line)
// backend stdout -> "backend" event -> UI

use std::io::{BufRead, BufReader, Write};
use std::path::PathBuf;
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::Mutex;
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter, Manager, RunEvent, State};

#[derive(Default)]
struct Backend {
    stdin: Mutex<Option<ChildStdin>>,
    child: Mutex<Option<Child>>,
}

#[tauri::command]
fn send(msg: String, backend: State<Backend>) -> Result<(), String> {
    let mut stdin = backend.stdin.lock().unwrap();
    let stdin = stdin.as_mut().ok_or("backend is not running")?;
    writeln!(stdin, "{msg}").map_err(|e| e.to_string())
}

fn project_root() -> PathBuf {
    std::env::var_os("P2P_SOCIAL_ROOT")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from(concat!(env!("CARGO_MANIFEST_DIR"), "/..")))
}

// The prebuilt Bare binary that npm put in node_modules (no Node needed to run it).
fn bundled_bare(root: &std::path::Path) -> PathBuf {
    let os = match std::env::consts::OS {
        "macos" => "darwin",
        "windows" => "win32",
        os => os,
    };
    let arch = match std::env::consts::ARCH {
        "x86_64" => "x64",
        "aarch64" => "arm64",
        arch => arch,
    };
    let exe = if cfg!(windows) { "bare.exe" } else { "bare" };
    root.join(format!("node_modules/bare-runtime-{os}-{arch}/bin/{exe}"))
}

fn spawn_backend(app: &AppHandle) -> Result<(), Box<dyn std::error::Error>> {
    let root = project_root();
    let bare = std::env::var_os("BARE_BIN")
        .map(PathBuf::from)
        .unwrap_or_else(|| bundled_bare(&root));
    let storage = match std::env::var_os("P2P_SOCIAL_STORAGE") {
        Some(dir) => PathBuf::from(dir),
        None => app.path().app_data_dir()?.join("storage"),
    };
    std::fs::create_dir_all(&storage)?;

    let mut cmd = Command::new(&bare);
    cmd.arg(root.join("backend/index.js")).arg(&storage);
    if let Ok(bootstrap) = std::env::var("P2P_SOCIAL_BOOTSTRAP") {
        cmd.arg(bootstrap);
    }
    let mut child = cmd
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::inherit())
        .spawn()
        .map_err(|e| format!("failed to start {}: {e}", bare.display()))?;

    let stdout = child.stdout.take().unwrap();
    let handle = app.clone();
    std::thread::spawn(move || {
        for line in BufReader::new(stdout).lines().map_while(Result::ok) {
            let _ = handle.emit("backend", line);
        }
        let _ = handle.emit("backend-exit", ());
    });

    let state = app.state::<Backend>();
    *state.stdin.lock().unwrap() = child.stdin.take();
    *state.child.lock().unwrap() = Some(child);
    Ok(())
}

// Closing stdin tells the backend to flush and exit; kill it if it takes too long.
fn stop_backend(app: &AppHandle) {
    let state = app.state::<Backend>();
    state.stdin.lock().unwrap().take();
    let Some(mut child) = state.child.lock().unwrap().take() else { return };
    let deadline = Instant::now() + Duration::from_secs(3);
    while Instant::now() < deadline {
        if let Ok(Some(_)) = child.try_wait() {
            return;
        }
        std::thread::sleep(Duration::from_millis(50));
    }
    let _ = child.kill();
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(Backend::default())
        .invoke_handler(tauri::generate_handler![send])
        .setup(|app| {
            spawn_backend(app.handle())?;
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app, event| {
            if let RunEvent::Exit = event {
                stop_backend(app);
            }
        });
}
