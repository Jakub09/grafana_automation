import { Blueprint } from './blueprint';

export interface BlueprintRepository {
    list(): Promise<Blueprint[]>;
    findByName(name: string): Promise<Blueprint | null>;
    /** Zapisuje szkic nowego blueprintu (plik do uzupełnienia przez użytkownika); @returns ścieżka pliku */
    saveDraft(name: string, draft: Record<string, unknown>, overwrite?: boolean): Promise<string>;
}
