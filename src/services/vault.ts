import { promises as fs } from "fs";
import { Dirent } from "fs";
import path from "path";

export const VAULT_PATH = process.env.VAULT_PATH || "/vault";
export const MAX_FILE_SIZE = 500_000;

export interface NoteInfo {
  [key: string]: unknown;
  path: string;
  name: string;
  size: number;
  modified: Date;
  folder: string;
}

export interface NoteContent extends NoteInfo {
  content: string;
}

export function resolveSafePath(notePath: string): string {
  const resolved = path.resolve(VAULT_PATH, notePath);
  if (!resolved.startsWith(path.resolve(VAULT_PATH))) {
    throw new Error(`Path traversal not allowed: ${notePath}`);
  }
  return resolved;
}

export async function listNotes(folder = ""): Promise<NoteInfo[]> {
  const basePath = folder ? resolveSafePath(folder) : path.resolve(VAULT_PATH);
  const notes: NoteInfo[] = [];

  async function walk(dir: string): Promise<void> {
    let entries: Dirent[] = [];
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory() && !entry.name.startsWith(".")) {
        await walk(fullPath);
      } else if (entry.isFile() && entry.name.endsWith(".md")) {
        const stat = await fs.stat(fullPath);
        const relativePath = path.relative(VAULT_PATH, fullPath);
        notes.push({
          path: relativePath,
          name: entry.name.replace(".md", ""),
          size: stat.size,
          modified: stat.mtime,
          folder: path.relative(VAULT_PATH, dir) || "/",
        });
      }
    }
  }

  await walk(basePath);
  return notes.sort((a, b) => (b.modified as Date).getTime() - (a.modified as Date).getTime());
}

export async function readNote(notePath: string): Promise<NoteContent> {
  const fullPath = resolveSafePath(notePath);
  const stat = await fs.stat(fullPath);
  if (stat.size > MAX_FILE_SIZE) {
    throw new Error(`File too large (${stat.size} bytes). Max: ${MAX_FILE_SIZE}`);
  }
  const content = await fs.readFile(fullPath, "utf-8");
  const relativePath = path.relative(VAULT_PATH, fullPath);
  return {
    path: relativePath,
    name: path.basename(notePath, ".md"),
    size: stat.size,
    modified: stat.mtime,
    folder: path.relative(VAULT_PATH, path.dirname(fullPath)) || "/",
    content,
  };
}

export async function writeNote(notePath: string, content: string): Promise<NoteContent> {
  const fullPath = resolveSafePath(notePath.endsWith(".md") ? notePath : `${notePath}.md`);
  await fs.mkdir(path.dirname(fullPath), { recursive: true });
  await fs.writeFile(fullPath, content, "utf-8");
  return readNote(path.relative(VAULT_PATH, fullPath));
}

export async function appendToNote(notePath: string, content: string): Promise<NoteContent> {
  const fullPath = resolveSafePath(notePath.endsWith(".md") ? notePath : `${notePath}.md`);
  let existing = "";
  try {
    existing = await fs.readFile(fullPath, "utf-8");
  } catch { /* file doesn't exist yet */ }
  const newContent = existing ? `${existing.trimEnd()}\n\n${content}` : content;
  await fs.mkdir(path.dirname(fullPath), { recursive: true });
  await fs.writeFile(fullPath, newContent, "utf-8");
  return readNote(path.relative(VAULT_PATH, fullPath));
}

export async function deleteNote(notePath: string): Promise<void> {
  const fullPath = resolveSafePath(notePath);
  await fs.unlink(fullPath);
}

export async function searchNotes(
  query: string,
  folder = "",
  maxResults = 20
): Promise<Array<NoteInfo & { excerpt: string }>> {
  const notes = await listNotes(folder);
  const results: Array<NoteInfo & { excerpt: string }> = [];
  const queryLower = query.toLowerCase();

  for (const note of notes) {
    if (results.length >= maxResults) break;
    if ((note.name as string).toLowerCase().includes(queryLower)) {
      results.push({ ...note, excerpt: `[Titre] ${note.name as string}` });
      continue;
    }
    try {
      const fullPath = resolveSafePath(note.path as string);
      const stat = await fs.stat(fullPath);
      if (stat.size > MAX_FILE_SIZE) continue;
      const content = await fs.readFile(fullPath, "utf-8");
      const idx = content.toLowerCase().indexOf(queryLower);
      if (idx !== -1) {
        const start = Math.max(0, idx - 80);
        const end = Math.min(content.length, idx + query.length + 80);
        const excerpt = content.slice(start, end).replace(/\n/g, " ").trim();
        results.push({ ...note, excerpt: `...${excerpt}...` });
      }
    } catch { continue; }
  }
  return results;
}

export async function listFolders(parent = ""): Promise<string[]> {
  const basePath = parent ? resolveSafePath(parent) : path.resolve(VAULT_PATH);
  const folders: string[] = [];
  try {
    const entries = await fs.readdir(basePath, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isDirectory() && !entry.name.startsWith(".")) {
        folders.push(path.join(parent, entry.name));
      }
    }
  } catch { return []; }
  return folders.sort();
}
