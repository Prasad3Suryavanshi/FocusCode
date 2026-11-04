'use strict';

const vscode = require('vscode');

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const CONF = {
    opacity: 'focus.opacity',
    opacityLight: 'focus.opacityLight',
    opacityDark: 'focus.opacityDark',
    fade: 'focus.fadeDuration',
    range: 'focus.highlightRange',
    lines: 'focus.highlightLines',
    level: 'focus.autoMatchLevel',
    statusBar: 'focus.showStatusBar',
};

/** Settings that require the decoration type to be rebuilt. */
const DECORATION_KEYS = [CONF.opacity, CONF.opacityLight, CONF.opacityDark, CONF.fade];

const RANGE_MODE = Object.freeze({
    BLOCK: 'block',
    FIXED: 'fixed',
    NONE: 'none',
});

const CMD = {
    toFixed: 'focus.switchToFixedLevel',
    toBlock: 'focus.switchToBlockLevel',
    turnOff: 'focus.turnOff',
    toggle: 'focus.toggle',
};

const STATE_LAST_MODE = 'focus.lastActiveMode';

const DEFAULT_OPACITY = 0.4;
const DEBOUNCE_MS = 100;
const PROVIDER_RETRY_MS = 800; // language servers (clangd, Pylance) start late
const MAX_PROVIDER_RETRIES = 3;
const MAX_CLOSING_TAG_SCAN = 100;
const MAX_SIGNATURE_LINES = 6; // how far up we look for an Allman-style signature

/** A line that contains only closing brackets, e.g. `}`, `});`, `],` */
const CLOSER_LINE = /^[}\])]+[;,]?$/;
/** A line that starts with an opening tag, e.g. `<div class="x">` or `<Foo.Bar` */
const OPEN_TAG = /^\s*<([A-Za-z][\w.\-]*)/;
const SELF_CLOSING_LINE = /\/>\s*$/;
/** Lines that belong to the block header but sit above it. */
const PREFIX_LINE = /^\s*(?:@\w|template\s*<|\[\[)/; // decorators, C++ templates, attributes
/** Ranges that start like a docstring or a block comment are "weak". */
const WEAK_START = /^\s*(?:[rRbBuUfF]{0,2}(?:"""|''')|\/\*)/;

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

const getConfig = () => vscode.workspace.getConfiguration();
const escapeRegExp = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const indentOf = text => text.length - text.trimStart().length;

/** Parse a 0..1 opacity; fall back when missing or invalid. */
function parseOpacity(value, fallback) {
    if (value === undefined || value === null || value === '') return fallback;
    const n = Number(value);
    return Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : fallback;
}

/**
 * Build the decoration type.
 * - `light` / `dark` render options give per-theme opacity.
 * - Fade is best-effort: a CSS transition is appended to the opacity value
 *   (VS Code has no official API for it), so it only animates when VS Code
 *   reuses the underlying DOM element.
 */
function createBaseDecoration() {
    const cfg = getConfig();
    const base = parseOpacity(cfg.get(CONF.opacity), DEFAULT_OPACITY);
    const light = parseOpacity(cfg.get(CONF.opacityLight), base);
    const dark = parseOpacity(cfg.get(CONF.opacityDark), base);
    const fadeMs = Math.max(0, Math.min(5000, Math.floor(Number(cfg.get(CONF.fade)) || 0)));

    const css = v => (fadeMs > 0 ? `${v}; transition: opacity ${fadeMs}ms ease-in-out` : String(v));

    return vscode.window.createTextEditorDecorationType({
        opacity: css(base),
        light: { opacity: css(light) },
        dark: { opacity: css(dark) },
    });
}

/** True for lines that merely close a block: `}`, `</div>`, `);` ... */
function isCloserLine(text) {
    const t = text.trim();
    return t.startsWith('</') || CLOSER_LINE.test(t);
}

/**
 * Does `closerLine` close *this* range (rather than an outer block)?
 * A closing brace belongs to the range when it is not indented deeper than
 * the line that opened it. This avoids swallowing the `}` of a parent block
 * when blocks are nested.
 */
function ownsCloser(document, range, closerLine) {
    if (closerLine < 0 || closerLine >= document.lineCount) return false;
    const text = document.lineAt(closerLine).text;
    return isCloserLine(text) && indentOf(text) <= indentOf(document.lineAt(range.start).text);
}

/** Merge overlapping / adjacent inclusive line intervals. */
function mergeIntervals(intervals) {
    const sorted = [...intervals].sort((a, b) => a[0] - b[0]);
    const merged = [];
    for (const [start, end] of sorted) {
        const last = merged[merged.length - 1];
        if (last && start <= last[1] + 1) {
            last[1] = Math.max(last[1], end);
        } else {
            merged.push([start, end]);
        }
    }
    return merged;
}

/** Convert "keep bright" line intervals into "dim" ranges. */
function invertToDimRanges(document, keep) {
    const lineCount = document.lineCount;
    const ranges = [];
    let cursor = 0;

    for (const [start, end] of mergeIntervals(keep)) {
        if (start > cursor) ranges.push(new vscode.Range(cursor, 0, start, 0));
        cursor = Math.max(cursor, end + 1);
    }
    if (cursor < lineCount) ranges.push(new vscode.Range(cursor, 0, lineCount, 0));
    return ranges;
}

// ---------------------------------------------------------------------------
// Fixed mode
// ---------------------------------------------------------------------------

function computeFixedIntervals(editor) {
    const configured = Number(getConfig().get(CONF.lines)) || 1;
    const radius = Math.max(0, Math.floor((configured - 1) / 2));
    const lastLine = editor.document.lineCount - 1;

    return editor.selections.map(sel => [
        Math.max(0, sel.start.line - radius),
        Math.min(lastLine, sel.end.line + radius),
    ]);
}

// ---------------------------------------------------------------------------
// Block mode
// ---------------------------------------------------------------------------

/**
 * @returns {Promise<Array<[number, number]> | null>}
 *          null means the folding provider returned nothing (not ready yet).
 */
async function computeBlockIntervals(editor) {
    const { document } = editor;
    const foldingRanges =
        (await vscode.commands.executeCommand('vscode.executeFoldingRangeProvider', document.uri)) || [];

    if (foldingRanges.length === 0 && document.lineCount > 1) return null;

    const level = Math.max(1, Math.floor(Math.abs(Number(getConfig().get(CONF.level)) || 1)));
    const intervals = [];

    for (const sel of editor.selections) {
        const block = findBlock(document, foldingRanges, sel.active.line, level);
        if (block) intervals.push(block);
    }
    return intervals;
}

/**
 * Find the block around `line` as an inclusive [start, end] pair.
 * `level` 1 = innermost block, 2 = its parent, and so on.
 */
function findBlock(document, foldingRanges, line, level) {
    // Python / TS decorators sit above the block they decorate: probe the def line.
    let probe = line;
    while (probe < document.lineCount - 1 && document.lineAt(probe).text.trim().startsWith('@')) {
        probe++;
    }
    const cursorIsCloser = isCloserLine(document.lineAt(probe).text);

    const containing = foldingRanges.filter(r => {
        // Ignore single-line blank ranges (empty-line highlighting bug in C++).
        if (r.start === r.end && document.lineAt(r.start).isEmptyOrWhitespace) return false;
        if (probe >= r.start && probe <= r.end) return true;
        // Cursor on the closing line that sits right after the folding range.
        return probe === r.end + 1 && cursorIsCloser && ownsCloser(document, r, probe);
    });
    if (containing.length === 0) return null;

    // Prefer real code blocks over docstrings, comments and import groups, so a
    // cursor inside a docstring still highlights the surrounding function.
    const isWeak = r =>
        r.kind === vscode.FoldingRangeKind.Comment ||
        r.kind === vscode.FoldingRangeKind.Imports ||
        WEAK_START.test(document.lineAt(r.start).text);
    const strong = containing.filter(r => !isWeak(r));
    const pool = strong.length > 0 ? strong : containing;

    pool.sort((a, b) => a.end - a.start - (b.end - b.start)); // innermost first
    const target = pool[Math.min(level - 1, pool.length - 1)];

    const start = computeStart(document, target);
    const end = computeEnd(document, target);
    return [start, Math.min(end, document.lineCount - 1)];
}

/**
 * Extend the start upwards to include the full block header:
 * - Allman braces: a lone `{` pulls in the signature lines above it
 * - decorators, `template<...>` lines and `[[attributes]]`
 */
function computeStart(document, range) {
    let start = range.start;

    if (document.lineAt(start).text.trim() === '{') {
        let steps = 0;
        while (start > 0 && steps < MAX_SIGNATURE_LINES) {
            const prev = document.lineAt(start - 1).text.trim();
            if (!prev || /[;{}]$/.test(prev) || /^(#|\/\/)/.test(prev)) break;
            start--;
            steps++;
        }
    }

    while (start > 0 && PREFIX_LINE.test(document.lineAt(start - 1).text)) start--;
    return start;
}

/**
 * Folding ranges usually stop one line before the closing `}` / `</tag>`.
 * Find the real last line of the block.
 */
function computeEnd(document, range) {
    const firstLineText = document.lineAt(range.start).text;
    const tagMatch = OPEN_TAG.exec(firstLineText);

    if (tagMatch && !SELF_CLOSING_LINE.test(firstLineText)) {
        const closing = findMatchingClosingTag(document, range, tagMatch[1]);
        if (closing !== -1) return closing;
    }

    // Brace-style languages: include the block's *own* closer, nothing more.
    if (ownsCloser(document, range, range.end)) return range.end;
    if (ownsCloser(document, range, range.end + 1)) return range.end + 1;

    // Indentation-style languages (Python): don't highlight trailing blank lines.
    let end = Math.min(range.end, document.lineCount - 1);
    while (end > range.start && document.lineAt(end).isEmptyOrWhitespace) end--;
    return end;
}

/** Line of the closing tag matching the opening tag, honouring nesting. -1 if none. */
function findMatchingClosingTag(document, range, tagName) {
    const name = escapeRegExp(tagName);
    const opens = new RegExp(`<${name}(?=[\\s>/]|$)`, 'g');
    const closes = new RegExp(`</${name}\\s*>`, 'g');

    const last = Math.min(range.end + MAX_CLOSING_TAG_SCAN, document.lineCount - 1);
    let depth = 0;

    for (let i = range.start; i <= last; i++) {
        const text = document.lineAt(i).text;
        const openCount = (text.match(opens) || []).length;
        const closeCount = (text.match(closes) || []).length;
        const selfClosed = SELF_CLOSING_LINE.test(text) && i !== range.start ? openCount : 0;

        depth += openCount - closeCount - selfClosed;
        if (depth <= 0 && i >= range.end) return i;
    }
    return -1;
}

// ---------------------------------------------------------------------------
// Extension lifecycle
// ---------------------------------------------------------------------------

/** @param {vscode.ExtensionContext} context */
function activate(context) {
    let baseDecoration = createBaseDecoration();
    let timer = null;
    let runId = 0; // discards stale async results
    let retries = 0; // folding-provider "not ready" retries

    // ---- status bar -------------------------------------------------------

    const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
    status.command = CMD.toggle;

    function refreshStatusBar() {
        const cfg = getConfig();
        if (cfg.get(CONF.statusBar) === false) {
            status.hide();
            return;
        }
        const mode = cfg.get(CONF.range);
        status.text =
            mode === RANGE_MODE.NONE
                ? '$(eye-closed) Focus: Off'
                : `$(eye) Focus: ${mode === RANGE_MODE.FIXED ? 'Fixed' : 'Block'}`;
        status.tooltip = 'Click to toggle Focus';
        status.show();
    }

    // ---- decoration update ------------------------------------------------

    async function updateDecorations() {
        const editor = vscode.window.activeTextEditor;
        if (!editor) return;

        const myRun = ++runId;
        let keep = null;

        try {
            switch (getConfig().get(CONF.range)) {
                case RANGE_MODE.BLOCK:
                    keep = await computeBlockIntervals(editor);
                    if (keep === null && myRun === runId && retries < MAX_PROVIDER_RETRIES) {
                        // Language server probably still starting: try again shortly.
                        retries++;
                        clearTimeout(timer);
                        timer = setTimeout(updateDecorations, PROVIDER_RETRY_MS);
                    }
                    break;
                case RANGE_MODE.FIXED:
                    keep = computeFixedIntervals(editor);
                    break;
                default:
                    keep = null;
            }
        } catch (err) {
            console.error('[focus] failed to compute ranges:', err);
            keep = null;
        }

        // A newer update started, or the active editor changed while awaiting.
        if (myRun !== runId || editor !== vscode.window.activeTextEditor) return;

        const dim = keep && keep.length > 0 ? invertToDimRanges(editor.document, keep) : [];
        editor.setDecorations(baseDecoration, dim);
    }

    function scheduleUpdate() {
        retries = 0;
        clearTimeout(timer);
        timer = setTimeout(updateDecorations, DEBOUNCE_MS);
    }

    // ---- commands ---------------------------------------------------------

    async function setMode(mode) {
        const current = getConfig().get(CONF.range);
        if (current && current !== RANGE_MODE.NONE) {
            await context.globalState.update(STATE_LAST_MODE, current);
        }
        await getConfig().update(CONF.range, mode, vscode.ConfigurationTarget.Global);
    }

    async function toggle() {
        const current = getConfig().get(CONF.range);
        if (current === RANGE_MODE.NONE) {
            const last = context.globalState.get(STATE_LAST_MODE) || RANGE_MODE.BLOCK;
            await setMode(last);
        } else {
            await setMode(RANGE_MODE.NONE);
        }
    }

    context.subscriptions.push(
        status,

        vscode.window.onDidChangeTextEditorSelection(scheduleUpdate),

        vscode.window.onDidChangeActiveTextEditor(editor => {
            if (editor) scheduleUpdate();
        }),

        vscode.workspace.onDidChangeConfiguration(e => {
            if (DECORATION_KEYS.some(key => e.affectsConfiguration(key))) {
                baseDecoration.dispose();
                baseDecoration = createBaseDecoration();
            }
            if (Object.values(CONF).some(key => e.affectsConfiguration(key))) {
                refreshStatusBar();
                if (vscode.window.activeTextEditor) scheduleUpdate();
            }
        }),

        vscode.commands.registerCommand(CMD.toBlock, () => setMode(RANGE_MODE.BLOCK)),
        vscode.commands.registerCommand(CMD.toFixed, () => setMode(RANGE_MODE.FIXED)),
        vscode.commands.registerCommand(CMD.turnOff, () => setMode(RANGE_MODE.NONE)),
        vscode.commands.registerCommand(CMD.toggle, toggle),

        {
            dispose() {
                clearTimeout(timer);
                runId++;
                baseDecoration.dispose();
            },
        }
    );

    refreshStatusBar();
    if (vscode.window.activeTextEditor) scheduleUpdate();
}

function deactivate() {}

module.exports = { activate, deactivate };