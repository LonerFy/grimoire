mod secret;
mod vault;

use std::io::Write;
use std::path::PathBuf;
use tauri::Manager;
use tauri_plugin_dialog::DialogExt;
use tauri_plugin_fs::{FsExt, OpenOptions};
use vault::Note;

/// Dossier des notes, créé automatiquement.
/// PC : Documents/Grimoire. Android : Documents/Grimoire si l'accès aux fichiers est accordé,
/// sinon le stockage privé de l'appli (les notes y sont reprises dès que l'accès est accordé).
fn private_dir(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    #[cfg(mobile)]
    let base = app.path().app_data_dir();
    #[cfg(not(mobile))]
    let base = app.path().document_dir();
    Ok(base.map_err(|e| e.to_string())?.join("Grimoire"))
}

#[cfg(target_os = "android")]
fn shared_dir() -> Option<PathBuf> {
    let dir = PathBuf::from("/storage/emulated/0/Documents/Grimoire");
    std::fs::create_dir_all(&dir).ok()?;
    let probe = dir.join(".ecriture");
    std::fs::write(&probe, b"ok").ok()?;
    let _ = std::fs::remove_file(probe);
    Some(dir)
}

fn vault_dir(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    #[cfg(target_os = "android")]
    if let Some(shared) = shared_dir() {
        let private = private_dir(app)?;
        // Si la reprise échoue, les anciens fichiers restent en place et sont réessayés au prochain appel.
        let _ = vault::migrate(&private, &shared);
        return Ok(shared);
    }
    private_dir(app)
}

#[tauri::command]
fn vault_path(app: tauri::AppHandle) -> Result<String, String> {
    Ok(vault_dir(&app)?.to_string_lossy().into_owned())
}

#[tauri::command]
fn vault_list(app: tauri::AppHandle) -> Result<Vec<Note>, String> {
    vault::read_all(&vault_dir(&app)?).map_err(|e| e.to_string())
}

#[tauri::command]
fn vault_write(app: tauri::AppHandle, note: Note) -> Result<(), String> {
    vault::write_note(&vault_dir(&app)?, &note).map_err(|e| e.to_string())
}

#[tauri::command]
fn vault_delete(app: tauri::AppHandle, id: String) -> Result<(), String> {
    vault::delete_note(&vault_dir(&app)?, &id).map_err(|e| e.to_string())
}

/// Jeton GitHub dans le coffre du système. Les erreurs ne contiennent jamais la valeur.
#[tauri::command]
fn secret_get() -> Result<Option<String>, String> { secret::get() }

#[tauri::command]
fn secret_set(value: String) -> Result<(), String> { secret::set(&value) }

#[tauri::command]
fn secret_delete() -> Result<(), String> { secret::delete() }

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
        .invoke_handler(tauri::generate_handler![vault_path, vault_list, vault_write, vault_delete, export_file, secret_get, secret_set, secret_delete])
        .run(tauri::generate_context!())
        .expect("erreur au lancement de Grimoire");
}
