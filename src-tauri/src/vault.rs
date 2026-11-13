//! Le coffre : un dossier « Grimoire » contenant un fichier Markdown par note.
//! Chaque fichier s'appelle `titre-lisible--<id>.md` et commence par un en-tête :
//! ---
//! id: n123
//! title: Ma note
//! pinned: false
//! created: 1700000000000
//! updated: 1700000000000
//! ---
use serde::{Deserialize, Serialize};
use std::{fs, io, path::{Path, PathBuf}};

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct Note {
    pub id: String,
    #[serde(default)]
    pub title: String,
    #[serde(default)]
    pub body: String,
    #[serde(default)]
    pub pinned: bool,
    #[serde(default)]
    pub created: f64,
    #[serde(default)]
    pub updated: f64,
}

fn bad(msg: &str) -> io::Error {
    io::Error::new(io::ErrorKind::InvalidInput, msg.to_string())
}

/// Un id sert de nom de fichier : on n'accepte que des caractères sûrs.
pub fn valid_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 120
        && !id.starts_with('.')
        && id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_' || c == '.')
        && !id.contains("--")
}

pub fn slug(title: &str) -> String {
    let mut out = String::new();
    let mut dash = true;
    for c in title.chars() {
        if c.is_alphanumeric() {
            out.push(c);
            dash = false;
        } else if !dash {
            out.push('-');
            dash = true;
        }
        if out.chars().count() >= 60 {
            break;
        }
    }
    let out = out.trim_matches('-').to_string();
    if out.is_empty() { "sans-titre".to_string() } else { out }
}

fn find_file(dir: &Path, id: &str) -> io::Result<Option<PathBuf>> {
    let suffix = format!("--{id}.md");
    if !dir.exists() {
        return Ok(None);
    }
    for entry in fs::read_dir(dir)? {
        let path = entry?.path();
        if let Some(name) = path.file_name().and_then(|n| n.to_str()) {
            if name.ends_with(&suffix) && !name.starts_with('.') {
                return Ok(Some(path));
            }
        }
    }
    Ok(None)
}

pub fn serialize(n: &Note) -> String {
    let title = n.title.replace(['\n', '\r'], " ");
    format!(
        "---\nid: {}\ntitle: {}\npinned: {}\ncreated: {}\nupdated: {}\n---\n{}",
        n.id, title, n.pinned, n.created as u64, n.updated as u64, n.body
    )
}

pub fn parse(text: &str) -> Option<Note> {
    let text = text.replace("\r\n", "\n");
    let rest = text.strip_prefix("---\n")?;
    let (head, body) = match rest.find("\n---\n") {
        Some(i) => (&rest[..i], &rest[i + 5..]),
        None => (rest.strip_suffix("\n---")?, ""),
    };
    let mut n = Note { id: String::new(), title: String::new(), body: body.to_string(), pinned: false, created: 0.0, updated: 0.0 };
    for line in head.lines() {
        let Some((k, v)) = line.split_once(':') else { continue };
        let v = v.strip_prefix(' ').unwrap_or(v);
        match k.trim() {
            "id" => n.id = v.trim().to_string(),
            "title" => n.title = v.to_string(),
            "pinned" => n.pinned = v.trim() == "true",
            "created" => n.created = v.trim().parse().unwrap_or(0.0),
            "updated" => n.updated = v.trim().parse().unwrap_or(0.0),
            _ => {}
        }
    }
    if valid_id(&n.id) { Some(n) } else { None }
}

pub fn read_all(dir: &Path) -> io::Result<Vec<Note>> {
    fs::create_dir_all(dir)?;
    let mut notes: Vec<Note> = Vec::new();
    for entry in fs::read_dir(dir)? {
        let path = entry?.path();
        let name = path.file_name().and_then(|n| n.to_str()).unwrap_or("");
        if name.starts_with('.') || !name.ends_with(".md") || !path.is_file() {
            continue;
        }
        let Ok(text) = fs::read_to_string(&path) else { continue };
        if let Some(n) = parse(&text) {
            // Deux fichiers pour le même id (copie manuelle) : on garde le plus récent.
            match notes.iter_mut().find(|o| o.id == n.id) {
                Some(o) => { if n.updated > o.updated { *o = n; } }
                None => notes.push(n),
            }
        }
    }
    Ok(notes)
}

pub fn write_note(dir: &Path, n: &Note) -> io::Result<()> {
    if !valid_id(&n.id) {
        return Err(bad("identifiant de note invalide"));
    }
    fs::create_dir_all(dir)?;
    let target = dir.join(format!("{}--{}.md", slug(&n.title), n.id));
    let tmp = dir.join(format!(".{}.tmp", n.id));
    fs::write(&tmp, serialize(n))?;
    if let Some(old) = find_file(dir, &n.id)? {
        if old != target {
            fs::remove_file(old)?;
        }
    }
    fs::rename(tmp, target)
}

pub fn delete_note(dir: &Path, id: &str) -> io::Result<()> {
    if !valid_id(id) {
        return Err(bad("identifiant de note invalide"));
    }
    while let Some(p) = find_file(dir, id)? {
        fs::remove_file(p)?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp(name: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("grimoire-test-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&d);
        d
    }
    fn note(id: &str, title: &str, body: &str) -> Note {
        Note { id: id.into(), title: title.into(), body: body.into(), pinned: true, created: 1700000000000.0, updated: 1700000000500.0 }
    }

    #[test]
    fn roundtrip_and_rename() {
        let d = tmp("rt");
        let mut n = note("nabc123", "Été : idées / plans", "ligne 1\n---\nligne 3\n");
        write_note(&d, &n).unwrap();
        assert_eq!(read_all(&d).unwrap(), vec![n.clone()]);
        n.title = "Nouveau titre".into();
        write_note(&d, &n).unwrap();
        let files: Vec<_> = fs::read_dir(&d).unwrap().map(|e| e.unwrap().file_name().into_string().unwrap()).collect();
        assert_eq!(files, vec!["Nouveau-titre--nabc123.md".to_string()]);
        assert_eq!(read_all(&d).unwrap(), vec![n.clone()]);
        delete_note(&d, "nabc123").unwrap();
        assert!(read_all(&d).unwrap().is_empty());
    }

    #[test]
    fn empty_title_and_body() {
        let d = tmp("empty");
        let n = note("seed-x", "", "");
        write_note(&d, &n).unwrap();
        assert_eq!(read_all(&d).unwrap(), vec![n]);
    }

    #[test]
    fn rejects_unsafe_ids() {
        let d = tmp("ids");
        for id in ["../x", "a/b", "", ".hidden", "a--b", "a b"] {
            assert!(write_note(&d, &note(id, "t", "b")).is_err(), "{id}");
            assert!(delete_note(&d, id).is_err(), "{id}");
        }
    }

    #[test]
    fn ignores_foreign_files_and_crlf() {
        let d = tmp("foreign");
        fs::create_dir_all(&d).unwrap();
        fs::write(d.join("autre.md"), "# pas une note Grimoire").unwrap();
        fs::write(d.join("x--w1.md"), "---\r\nid: w1\r\ntitle: Windows\r\npinned: false\r\ncreated: 1\r\nupdated: 2\r\n---\r\ncorps").unwrap();
        let all = read_all(&d).unwrap();
        assert_eq!(all.len(), 1);
        assert_eq!(all[0].title, "Windows");
        assert_eq!(all[0].body, "corps");
    }
}
