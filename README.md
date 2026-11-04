# FocusCode

Stay focused on the code you're working on. FocusCode dims everything outside your active code block, so the function, loop, class or tag you're editing stands out and the rest fades into the background.

It is aimed at Python, C/C++, HTML, JavaScript/TypeScript (including JSX/React) and Go. Block detection relies on the folding ranges your language extension provides, so results can vary by language (see [Known limitations](#known-limitations)).

## Table of contents

- [Features](#features)
- [Installation](#installation)
- [Usage](#usage)
- [Settings](#settings)
- [How it works](#how-it-works)
- [Known limitations](#known-limitations)
- [Troubleshooting](#troubleshooting)
- [Contributing](#contributing)
- [License](#license)

## Features

- **Block mode:** highlights the block around your cursor (function, loop, `if`, class, tag and so on) and dims everything else.
- **Fixed mode:** keeps the cursor line plus a few lines above and below it bright. It doesn't depend on language support.
- **Multi-cursor support:** every cursor keeps its own block bright.
- **Block levels:** focus on the innermost block, its parent, its grandparent and so on.
- **Per-theme opacity:** use different dimming strengths for light and dark themes.
- **Optional fade:** a best-effort fade transition (see the note under [Settings](#settings)).
- **Status bar toggle:** one click turns FocusCode off, and another click restores your last mode.
- **Language-aware block detection:**
  - **C/C++:** pulls in the signature above an Allman-style `{`, plus `template<...>` lines and `[[attributes]]`, and uses indentation to avoid highlighting a parent block's closing brace.
  - **Python:** includes decorators with the function they decorate, and prefers the surrounding function or class over a docstring or comment block when your language server reports one.

## Installation

### Option 1: Download the `.vsix` from GitHub Releases (easiest)

1. Open the **Releases** page of this repository:
   `https://github.com/<your-username>/focuscode/releases`
2. Download the latest `focuscode-x.y.z.vsix` file.
3. Install it using either method:
   - **VS Code UI:** open the Extensions view, click the `…` menu at the top, choose **Install from VSIX…** and select the downloaded file.
   - **Terminal:**
     ```bash
     code --install-extension focuscode-x.y.z.vsix
     ```
4. Run **Developer: Reload Window** from the Command Palette (`Cmd/Ctrl+Shift+P`).

### Option 2: Build it from source

Requirements: [Node.js](https://nodejs.org/) and VS Code.

```bash
# 1. Get the code
git clone https://github.com/<your-username>/focuscode.git
cd focuscode

# 2. Install the packaging tool
npm install -g @vscode/vsce

# 3. Build the .vsix
vsce package --allow-missing-repository

# 4. Install it
code --install-extension focuscode-1.1.0.vsix
```

Then run **Developer: Reload Window**.

> **macOS:** if the `code` command isn't found, open the Command Palette and run **Shell Command: Install 'code' command in PATH**.

### Updating

Pull the latest changes (or download the newest release), then build and install the new `.vsix` the same way and reload the window. Installing over an older version upgrades it.

> **Coming from an earlier "Spotlight" build?** The extension was renamed to FocusCode. Uninstall the old Spotlight extension from the Extensions view first, so the two don't run side by side.

### Uninstalling

Open the Extensions view, find **FocusCode** and click **Uninstall**.

## Usage

After installing, FocusCode starts automatically. You'll see **Focus: Block** in the status bar. Move your cursor around and the active block stays bright while the rest is dimmed.

Clicking the status bar item turns FocusCode off. Click it again to go back to the mode you were using.

### Commands

Open the Command Palette (`Cmd/Ctrl+Shift+P`) and type "FocusCode":

| Command | What it does |
| --- | --- |
| `FocusCode: Toggle On/Off` | Turns FocusCode off, or restores your last mode |
| `FocusCode: Switch To Block Level` | Highlights the active code block |
| `FocusCode: Switch To Fixed Level` | Highlights a fixed number of lines |
| `FocusCode: Turn Off` | Disables dimming |

### Keyboard shortcut

| Platform | Shortcut | Action |
| --- | --- | --- |
| macOS | `Cmd+Alt+F` | Toggle FocusCode |
| Windows / Linux | `Ctrl+Alt+F` | Toggle FocusCode |

To change it, open **Keyboard Shortcuts** and search for "FocusCode".

## Settings

Open **Settings** and search for "FocusCode", or edit `settings.json` directly.

| Setting | Default | Description |
| --- | --- | --- |
| `focus.highlightRange` | `block` | `block`, `fixed` or `none` |
| `focus.autoMatchLevel` | `1` | Which block to focus on: `1` is the innermost, `2` is its parent, and so on |
| `focus.highlightLines` | `5` | Size of the bright window in `fixed` mode. It is split evenly above and below the cursor, so an even value behaves like the next lower odd number (for example `4` keeps 3 lines) |
| `focus.opacity` | `0.7` | Opacity of dimmed lines, from `0` to `1` |
| `focus.opacityLight` | empty | Opacity for light themes (empty uses `focus.opacity`) |
| `focus.opacityDark` | empty | Opacity for dark themes (empty uses `focus.opacity`) |
| `focus.fadeDuration` | `0` | Fade time in milliseconds (`0` disables it) |
| `focus.showStatusBar` | `true` | Show the status bar toggle |

Example `settings.json`:

```json
{
  "focus.highlightRange": "block",
  "focus.autoMatchLevel": 1,
  "focus.opacityLight": "0.55",
  "focus.opacityDark": "0.35"
}
```

> **Note on fade:** VS Code has no official API for animating decorations, so `focus.fadeDuration` uses a CSS transition trick. It only animates when VS Code reuses the same element, so it may work in some cases and not in others.

## How it works

In **block mode**, FocusCode asks VS Code for the folding ranges of the current file (the same ranges you use to collapse code), picks the one that contains your cursor, and dims every line outside it. Because it relies on the folding ranges your language extension provides, the result depends on how well that extension describes your code's structure.

A few adjustments make the result match what you'd expect to see:

- Closing lines such as `}` or `</div>` are included in the block, but only when they belong to that block.
- Lines that belong to the block's header, such as decorators or `template<...>`, are included.
- Docstrings, comment blocks and import groups are deprioritised when choosing the block, so a cursor inside one highlights the surrounding block. If there is no surrounding block (for example a comment at the top of a file), the comment or import group itself is highlighted.

In **fixed mode**, FocusCode keeps each selection bright plus (`focus.highlightLines` − 1) ÷ 2 lines on each side, rounded down. This mode doesn't need folding ranges.

## Known limitations

- **Depends on folding ranges.** If your language extension provides none, or hasn't finished starting, block mode dims nothing. Fixed mode still works.
- **Not every language has been tested.** C/C++ and Python were the focus; Go, React/JSX and others are expected to work but are unverified.
- **`} else {` lines.** A closing brace on the same line as another opening brace (`} else {`, `} catch {`) isn't counted as part of the earlier block.
- **K&R multi-line signatures.** When a function signature spans several lines and the `{` is on the last one, only that last line is included. The lines above are only pulled in for Allman-style braces.
- **Decorators.** Only lines starting with `@` that sit directly above the block are included.
- **Inconsistent indentation.** The closing-brace detection compares indentation, so oddly indented code may highlight imperfectly.
- **Fade is best effort** (see the note under [Settings](#settings)).

## Troubleshooting

- **Nothing is dimmed right after opening a C/C++ or Python file.** FocusCode needs your language server (for example Pylance, clangd or the C/C++ extension) for block information. It retries a few times while the server starts. Make sure the language extension for your file type is installed.
- **Block mode dims nothing in a language.** Its extension may not provide folding ranges. Switch to fixed mode with `FocusCode: Switch To Fixed Level`.
- **Block highlighting looks wrong in a specific language.** Please open an issue and include a short code sample.
- **The status bar item is missing.** Check that `focus.showStatusBar` is `true`, then reload the window.
- **Nothing happens after installing.** Run **Developer: Reload Window**.
- **Opacity setting is rejected.** Use a value from `0` to `1`, such as `0.5` or `1`.

## Contributing

Issues and pull requests are welcome. To work on the extension locally:

1. Clone the repository and open the folder in VS Code.
2. Press `F5` to launch an Extension Development Host. If VS Code asks for a launch configuration, choose **VS Code Extension Development**.
3. Open a `.cpp` or `.py` file in the new window and try your changes.

When reporting a bug, please include your VS Code version, the language of the file, and a short code snippet that reproduces it.

## License

Released under the [MIT License](LICENSE). Copyright (c) 2026 Prasad Suryavanshi.