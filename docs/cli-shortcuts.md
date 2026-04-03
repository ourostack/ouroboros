# CLI Keyboard Shortcuts

## Navigation
| Shortcut | Action |
|----------|--------|
| `←` / `→` | Move cursor left/right |
| `Option+←` / `Option+→` | Jump between words |
| `Ctrl+A` | Jump to start of line |
| `Ctrl+E` | Jump to end of line |
| `↑` / `↓` | Browse input history (includes previous sessions) |

## Editing
| Shortcut | Action |
|----------|--------|
| `Backspace` | Delete character before cursor |
| `Option+Backspace` | Delete word before cursor |
| `Option+D` | Delete word after cursor |
| `Escape` | Clear entire input |
| `Alt+Enter` | Insert newline (multi-line input) |

## Session
| Shortcut | Action |
|----------|--------|
| `Enter` | Send message |
| `Ctrl-C` | Abort current generation / clear input |
| `Ctrl-C` twice (within 2s) | Exit |

## Commands
| Command | Action |
|---------|--------|
| `/help` | Show keyboard shortcuts |
| `/commands` | List all available commands |
| `/new` | Start a new conversation |
| `/exit` | Quit |

## Notes
- Input is never blocked during agent generation — type your next message while the agent responds
- Input history persists across sessions (seeded from conversation history)
- The agent uses TTFA (Trust The Fucking Agent) — no permission prompts
