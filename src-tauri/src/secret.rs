//! Jeton GitHub dans le coffre sécurisé du système (PC).
//! Windows : Gestionnaire d'identifiants (via la crate `keyring` 4.x, feature `v1` qui active
//! `windows-native-keyring-store`). Il n'y a aucun repli en mémoire : si le coffre n'est pas
//! disponible, on renvoie une erreur et l'interface garde l'ancien stockage.
//! Android : la crate n'est pas compilée, le jeton passe par le pont Kotlin (Android Keystore).
//! Les erreurs renvoyées ne contiennent jamais la valeur du jeton.

pub const SERVICE: &str = "Grimoire";
pub const USER: &str = "github-token";

/// Code d'erreur unique côté interface : le détail système n'est pas utile et ne doit rien divulguer.
pub const UNAVAILABLE: &str = "indisponible";

#[cfg(not(target_os = "android"))]
fn entry() -> Result<keyring::Entry, String> {
    keyring::Entry::new(SERVICE, USER).map_err(|_| UNAVAILABLE.to_string())
}

#[cfg(not(target_os = "android"))]
pub fn get() -> Result<Option<String>, String> {
    match entry()?.get_password() {
        Ok(v) => Ok(Some(v)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(_) => Err(UNAVAILABLE.to_string()),
    }
}

#[cfg(not(target_os = "android"))]
pub fn set(value: &str) -> Result<(), String> {
    entry()?.set_password(value).map_err(|_| UNAVAILABLE.to_string())
}

#[cfg(not(target_os = "android"))]
pub fn delete() -> Result<(), String> {
    match entry()?.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(_) => Err(UNAVAILABLE.to_string()),
    }
}

#[cfg(target_os = "android")]
pub fn get() -> Result<Option<String>, String> { Err(UNAVAILABLE.to_string()) }
#[cfg(target_os = "android")]
pub fn set(_value: &str) -> Result<(), String> { Err(UNAVAILABLE.to_string()) }
#[cfg(target_os = "android")]
pub fn delete() -> Result<(), String> { Err(UNAVAILABLE.to_string()) }

/// Preuve de persistance sur le vrai Gestionnaire d'identifiants Windows.
/// Trois tests à lancer chacun dans son propre processus (la CI le fait) :
///   cargo test persist_1_ecrit -- --ignored
///   cargo test persist_2_relit -- --ignored      (autre processus : un coffre en mémoire échouerait ici)
///   cargo test persist_3_efface -- --ignored
/// Ils utilisent une entrée de test distincte, jamais celle du vrai jeton.
#[cfg(all(test, windows))]
mod persistance {
    use keyring::Entry;
    const VALEUR: &str = "valeur-de-test-grimoire";
    fn e() -> Entry { Entry::new("Grimoire-test", "persistance").expect("coffre Windows initialisé") }

    #[test] #[ignore]
    fn persist_1_ecrit() { e().set_password(VALEUR).expect("écriture"); }

    #[test] #[ignore]
    fn persist_2_relit() { assert_eq!(e().get_password().expect("relecture dans un autre processus"), VALEUR); }

    #[test] #[ignore]
    fn persist_3_efface() {
        e().delete_credential().expect("suppression");
        assert!(matches!(e().get_password(), Err(keyring::Error::NoEntry)));
    }
}
