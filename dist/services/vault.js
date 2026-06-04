"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.MAX_FILE_SIZE = exports.VAULT_PATH = void 0;
exports.resolveSafePath = resolveSafePath;
exports.listNotes = listNotes;
exports.readNote = readNote;
exports.writeNote = writeNote;
exports.appendToNote = appendToNote;
exports.deleteNote = deleteNote;
exports.searchNotes = searchNotes;
exports.listFolders = listFolders;
const fs_1 = require("fs");
const path_1 = __importDefault(require("path"));
exports.VAULT_PATH = process.env.VAULT_PATH || "/vault";
exports.MAX_FILE_SIZE = 500_000;
function resolveSafePath(notePath) {
    const resolved = path_1.default.resolve(exports.VAULT_PATH, notePath);
    if (!resolved.startsWith(path_1.default.resolve(exports.VAULT_PATH))) {
        throw new Error(`Path traversal not allowed: ${notePath}`);
    }
    return resolved;
}
async function listNotes(folder = "") {
    const basePath = folder ? resolveSafePath(folder) : path_1.default.resolve(exports.VAULT_PATH);
    const notes = [];
    async function walk(dir) {
        let entries = [];
        try {
            entries = await fs_1.promises.readdir(dir, { withFileTypes: true });
        }
        catch {
            return;
        }
        for (const entry of entries) {
            const fullPath = path_1.default.join(dir, entry.name);
            if (entry.isDirectory() && !entry.name.startsWith(".")) {
                await walk(fullPath);
            }
            else if (entry.isFile() && entry.name.endsWith(".md")) {
                const stat = await fs_1.promises.stat(fullPath);
                const relativePath = path_1.default.relative(exports.VAULT_PATH, fullPath);
                notes.push({
                    path: relativePath,
                    name: entry.name.replace(".md", ""),
                    size: stat.size,
                    modified: stat.mtime,
                    folder: path_1.default.relative(exports.VAULT_PATH, dir) || "/",
                });
            }
        }
    }
    await walk(basePath);
    return notes.sort((a, b) => b.modified.getTime() - a.modified.getTime());
}
async function readNote(notePath) {
    const fullPath = resolveSafePath(notePath);
    const stat = await fs_1.promises.stat(fullPath);
    if (stat.size > exports.MAX_FILE_SIZE) {
        throw new Error(`File too large (${stat.size} bytes). Max: ${exports.MAX_FILE_SIZE}`);
    }
    const content = await fs_1.promises.readFile(fullPath, "utf-8");
    const relativePath = path_1.default.relative(exports.VAULT_PATH, fullPath);
    return {
        path: relativePath,
        name: path_1.default.basename(notePath, ".md"),
        size: stat.size,
        modified: stat.mtime,
        folder: path_1.default.relative(exports.VAULT_PATH, path_1.default.dirname(fullPath)) || "/",
        content,
    };
}
async function writeNote(notePath, content) {
    const fullPath = resolveSafePath(notePath.endsWith(".md") ? notePath : `${notePath}.md`);
    await fs_1.promises.mkdir(path_1.default.dirname(fullPath), { recursive: true });
    await fs_1.promises.writeFile(fullPath, content, "utf-8");
    return readNote(path_1.default.relative(exports.VAULT_PATH, fullPath));
}
async function appendToNote(notePath, content) {
    const fullPath = resolveSafePath(notePath.endsWith(".md") ? notePath : `${notePath}.md`);
    let existing = "";
    try {
        existing = await fs_1.promises.readFile(fullPath, "utf-8");
    }
    catch { /* file doesn't exist yet */ }
    const newContent = existing ? `${existing.trimEnd()}\n\n${content}` : content;
    await fs_1.promises.mkdir(path_1.default.dirname(fullPath), { recursive: true });
    await fs_1.promises.writeFile(fullPath, newContent, "utf-8");
    return readNote(path_1.default.relative(exports.VAULT_PATH, fullPath));
}
async function deleteNote(notePath) {
    const fullPath = resolveSafePath(notePath);
    await fs_1.promises.unlink(fullPath);
}
async function searchNotes(query, folder = "", maxResults = 20) {
    const notes = await listNotes(folder);
    const results = [];
    const queryLower = query.toLowerCase();
    for (const note of notes) {
        if (results.length >= maxResults)
            break;
        if (note.name.toLowerCase().includes(queryLower)) {
            results.push({ ...note, excerpt: `[Titre] ${note.name}` });
            continue;
        }
        try {
            const fullPath = resolveSafePath(note.path);
            const stat = await fs_1.promises.stat(fullPath);
            if (stat.size > exports.MAX_FILE_SIZE)
                continue;
            const content = await fs_1.promises.readFile(fullPath, "utf-8");
            const idx = content.toLowerCase().indexOf(queryLower);
            if (idx !== -1) {
                const start = Math.max(0, idx - 80);
                const end = Math.min(content.length, idx + query.length + 80);
                const excerpt = content.slice(start, end).replace(/\n/g, " ").trim();
                results.push({ ...note, excerpt: `...${excerpt}...` });
            }
        }
        catch {
            continue;
        }
    }
    return results;
}
async function listFolders(parent = "") {
    const basePath = parent ? resolveSafePath(parent) : path_1.default.resolve(exports.VAULT_PATH);
    const folders = [];
    try {
        const entries = await fs_1.promises.readdir(basePath, { withFileTypes: true });
        for (const entry of entries) {
            if (entry.isDirectory() && !entry.name.startsWith(".")) {
                folders.push(path_1.default.join(parent, entry.name));
            }
        }
    }
    catch {
        return [];
    }
    return folders.sort();
}
//# sourceMappingURL=vault.js.map