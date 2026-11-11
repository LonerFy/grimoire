use std::io::Write;
use tauri_plugin_dialog::DialogExt;
use tauri_plugin_fs::{FsExt, OpenOptions};

/// Ouvre la boîte « Enregistrer sous » du système (PC et Android) et y écrit le fichier.
/// Renvoie false si l'utilisateur annule.
#[tauri::command]
async fn export_file(app: tauri::AppHandle, name: String, content: String) -> Result<bool, String> {
    let Some(path) = app.dialog().file().set_file_name(&name).blocking_save_file() else {
        return Ok(false);
    };
    let mut opts = OpenOptions::new();
    opts.write(true).create(true).truncate(true);
    let mut file = app.fs().open(path, opts).map_err(|e| e.to_string())?;
    file.write_all(content.as_bytes()).map_err(|e| e.to_string())?;
    Ok(true)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .invoke_handler(tauri::generate_handler![export_file])
        .run(tauri::generate_context!())
        .expect("erreur au lancement de Grimoire");
}
