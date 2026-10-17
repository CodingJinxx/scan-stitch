import { AbstractInputSuggest, prepareFuzzySearch, renderResults, TFile, TFolder } from 'obsidian';
import type { App, SearchResult } from 'obsidian';

interface Scored<T> {
  item: T;
  match: SearchResult;
}

function fuzzy<T>(items: T[], query: string, textOf: (i: T) => string, limit: number): Scored<T>[] {
  if (query.trim() === '') {
    return items.slice(0, limit).map((item) => ({ item, match: { score: 0, matches: [] } }));
  }
  const search = prepareFuzzySearch(query.trim());
  const out: Scored<T>[] = [];
  for (const item of items) {
    const match = search(textOf(item));
    if (match) out.push({ item, match });
  }
  out.sort((a, b) => b.match.score - a.match.score);
  return out.slice(0, limit);
}

/** Fuzzy folder picker attached to a text input. The vault root is offered as `/`. */
export class FolderSuggest extends AbstractInputSuggest<TFolder> {
  private scored = new Map<TFolder, SearchResult>();

  constructor(
    app: App,
    inputEl: HTMLInputElement,
    private readonly onPick: (path: string) => void,
  ) {
    super(app, inputEl);
  }

  protected getSuggestions(query: string): TFolder[] {
    // Vault.getAllFolders needs a newer app version than minAppVersion allows.
    const folders = this.app.vault.getAllLoadedFiles().filter((f): f is TFolder => f instanceof TFolder);
    const res = fuzzy(folders, query, (f) => (f.isRoot() ? '/' : f.path), 50);
    this.scored = new Map(res.map((r) => [r.item, r.match]));
    return res.map((r) => r.item);
  }

  renderSuggestion(folder: TFolder, el: HTMLElement): void {
    const text = folder.isRoot() ? '/' : folder.path;
    const match = this.scored.get(folder);
    if (match && match.matches.length > 0) renderResults(el, text, match);
    else el.setText(text);
  }

  selectSuggestion(folder: TFolder): void {
    const path = folder.isRoot() ? '/' : folder.path;
    this.setValue(path);
    this.onPick(path);
    this.close();
  }
}

/** Fuzzy PDF picker (vault files ending in .pdf) attached to a text input. */
export class PdfSuggest extends AbstractInputSuggest<TFile> {
  private scored = new Map<TFile, SearchResult>();

  constructor(
    app: App,
    inputEl: HTMLInputElement,
    private readonly onPick: (path: string) => void,
  ) {
    super(app, inputEl);
  }

  protected getSuggestions(query: string): TFile[] {
    const pdfs = this.app.vault.getFiles().filter((f) => f.extension.toLowerCase() === 'pdf');
    const res = fuzzy(pdfs, query, (f) => f.path, 50);
    this.scored = new Map(res.map((r) => [r.item, r.match]));
    return res.map((r) => r.item);
  }

  renderSuggestion(file: TFile, el: HTMLElement): void {
    const match = this.scored.get(file);
    if (match && match.matches.length > 0) renderResults(el, file.path, match);
    else el.setText(file.path);
  }

  selectSuggestion(file: TFile): void {
    this.setValue(file.path);
    this.onPick(file.path);
    this.close();
  }
}
