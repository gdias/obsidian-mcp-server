export declare const VAULT_PATH: string;
export declare const MAX_FILE_SIZE = 500000;
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
export declare function resolveSafePath(notePath: string): string;
export declare function listNotes(folder?: string): Promise<NoteInfo[]>;
export declare function readNote(notePath: string): Promise<NoteContent>;
export declare function writeNote(notePath: string, content: string): Promise<NoteContent>;
export declare function appendToNote(notePath: string, content: string): Promise<NoteContent>;
export declare function deleteNote(notePath: string): Promise<void>;
export declare function searchNotes(query: string, folder?: string, maxResults?: number): Promise<Array<NoteInfo & {
    excerpt: string;
}>>;
export declare function listFolders(parent?: string): Promise<string[]>;
//# sourceMappingURL=vault.d.ts.map