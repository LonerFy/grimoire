// Évite la fenêtre console sur Windows en release.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    grimoire_lib::run()
}
