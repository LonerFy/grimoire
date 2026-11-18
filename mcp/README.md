# Grimoire MCP

Connecte tes notes Grimoire à Claude ou à tout agent compatible MCP.
Le serveur lit et écrit les fichiers `notes/<id>.md` de ton dépôt GitHub privé, comme l'appli (un dépôt encore à l'ancien format `grimoire-notes.json` reste géré à l'ancienne tant que l'appli ne l'a pas migré) :
ce que l'agent écrit apparaît dans Grimoire en moins d'une minute, et inversement.

Prérequis : le dépôt Grimoire cloné en entier (le serveur partage `src/sync-core.js` avec l'appli), Node 18 ou plus, et la synchronisation GitHub activée dans Grimoire.

## Installer
```bash
cd ~/grimoire-app/mcp
npm install
```

## Brancher sur Claude Code
```bash
claude mcp add grimoire \
  -e GRIMOIRE_REPO=LonerFy/grimoire-notes \
  -e GRIMOIRE_TOKEN=github_pat_xxx \
  -- node ~/grimoire-app/mcp/server.js
```

## Brancher sur Claude Desktop (Windows, serveur dans WSL)
Dans `claude_desktop_config.json` (Paramètres → Développeur → Modifier la configuration) :
```json
{
  "mcpServers": {
    "grimoire": {
      "command": "wsl.exe",
      "args": ["bash", "-lc", "GRIMOIRE_REPO=LonerFy/grimoire-notes GRIMOIRE_TOKEN=github_pat_xxx node ~/grimoire-app/mcp/server.js"]
    }
  }
}
```
Tout autre client MCP (Cursor, Gemini CLI, etc.) : même commande `node server.js` avec les mêmes variables.

## Variables
| Variable | Rôle |
| --- | --- |
| `GRIMOIRE_REPO` | Dépôt des notes, `proprietaire/nom` |
| `GRIMOIRE_TOKEN` | Jeton GitHub limité à ce dépôt, droit Contents lecture et écriture |
| `GRIMOIRE_FILE` | À la place des deux précédentes : chemin d'un export `.json` local |
| `GRIMOIRE_READ_ONLY` | `1` pour interdire toute écriture à l'agent |

## Outils
`list_notes`, `search_notes`, `read_note`, `create_note`, `update_note`, `append_to_note`, `delete_note`, `list_tags`, `graph_overview`.

### Modifier sans écraser : `base_version`
`read_note` renvoie un champ `version`. `update_note` et `delete_note` exigent ce champ en `base_version` ; `append_to_note` l'accepte en option. Si la note a changé depuis la lecture (modifiée dans l'appli, par exemple), l'écriture est refusée avec un message clair et rien n'est modifié : relis la note, puis réessaie.

Le jeton donne accès à toutes tes notes : ne le mets pas dans un dépôt public.
