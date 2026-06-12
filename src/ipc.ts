// Typed wrappers around the Rust core's Tauri commands. All disk I/O goes
// through here; the frontend never touches raw bytes.
import { invoke } from "@tauri-apps/api/core";

export interface OpenedDocument {
  path: string;
  content: string;
  encoding: string;
  hadBom: boolean;
  malformed: boolean;
  lineEnding: string;
}

export interface SaveResult {
  unmappable: boolean;
}

export function openDocument(
  path: string,
  encoding?: string,
): Promise<OpenedDocument> {
  return invoke<OpenedDocument>("open_document", { path, encoding });
}

export function saveDocument(args: {
  path: string;
  content: string;
  encoding: string;
  withBom: boolean;
  lineEnding: string;
}): Promise<SaveResult> {
  return invoke<SaveResult>("save_document", args);
}

export interface SessionFile {
  path: string;
  encoding: string;
}

export interface SessionData {
  files: SessionFile[];
  active: number;
}

export function loadSession(): Promise<SessionData | null> {
  return invoke<SessionData | null>("load_session");
}

export function saveSession(session: SessionData): Promise<void> {
  return invoke<void>("save_session", { session });
}

export interface Preferences {
  fontFamily: string;
  fontSize: number;
  theme: string;
  defaultEncoding: string;
  defaultBom: boolean;
}

export function loadPreferences(): Promise<Preferences> {
  return invoke<Preferences>("load_preferences");
}

export function savePreferences(preferences: Preferences): Promise<void> {
  return invoke<void>("save_preferences", { preferences });
}
