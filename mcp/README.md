# Grimoire MCP

Connecte tes notes Grimoire à Claude ou à tout agent compatible MCP.
Le serveur lit et écrit `grimoire-notes.json` dans ton dépôt GitHub privé, le même fichier que l'appli :
ce que l'agent écrit apparaît dans Grimoire en moins d'une minute, et inversement.

Prérequis : Node 18 ou plus, et la synchronisation GitHub activée dans Grimoire.

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

Le jeton donne accès à toutes tes notes : ne le mets pas dans un dépôt public.
