export type QueueJobStatus = 'pending' | 'processing' | 'done' | 'failed' | 'duplicate';

export const QUEUE_STATUSES: readonly QueueJobStatus[] = ['pending', 'processing', 'done', 'failed', 'duplicate'];

/** Powiadomienie z Grafany zapisane przed przetworzeniem - przeżywa restart i jest ponawiane przy błędzie */
export interface QueueJob {
    /** Identyfikator zadania = taskId z odpowiedzi webhooka = pole "op" w logu */
    id: string;
    receivedAt: Date;
    updatedAt: Date;
    status: QueueJobStatus;
    /** Liczba rozpoczętych prób przetworzenia */
    attempts: number;
    /** Kiedy najwcześniej podjąć kolejną próbę (pending) */
    nextAttemptAt: Date | null;
    /** Skrót treści powiadomienia - ten sam dla powtórzeń tego samego powiadomienia */
    dedupeKey: string;
    /** Oryginalna treść webhooka */
    payload: unknown;
    /** Krótki opis do list (status, liczba alertów, reguły) */
    summary: string;
    /** Odbiorcy (klucz zestawu adresów), do których e-mail już wyszedł - nie są powtarzani przy ponowieniu */
    sentTo: string[];
    lastError: string | null;
    /** Dla duplikatów: zadanie, które obsłużyło to samo powiadomienie */
    duplicateOf: string | null;
}

export interface NewQueueJob {
    id: string;
    receivedAt: Date;
    status: 'pending' | 'duplicate';
    dedupeKey: string;
    payload: unknown;
    summary: string;
    duplicateOf?: string;
}

/**
 * Trwała kolejka powiadomień o alertach. Implementacja: SQLite (infrastructure/queue).
 * Metody są synchroniczne - operacje są lokalne i krótkie.
 */
export interface NotificationQueue {
    add(job: NewQueueJob): QueueJob;
    get(id: string): QueueJob | null;
    /** Ostatnie zadanie (nie duplikat) z tym kluczem otrzymane po `since` */
    findByDedupeKey(key: string, since: Date): QueueJob | null;
    /** Pobiera najstarsze zadanie gotowe do przetworzenia i oznacza je jako "processing" (attempts + 1) */
    claimNext(now: Date): QueueJob | null;
    markSent(id: string, recipientKey: string): void;
    complete(id: string): void;
    reschedule(id: string, nextAttemptAt: Date, error: string): void;
    fail(id: string, error: string): void;
    /** Ponowienie zadania nieudanego (albo dowolnego - np. ponowna wysyłka): pending od teraz, licznik prób od zera */
    retry(id: string): QueueJob;
    /** Zadania przerwane restartem ("processing") wracają do kolejki; zwraca ich liczbę */
    recoverInterrupted(): number;
    list(filter?: { status?: QueueJobStatus; limit?: number }): QueueJob[];
    counts(): Record<QueueJobStatus, number>;
    /** Usuwa zakończone zadania (done, duplicate, failed) starsze niż `before`; zwraca liczbę */
    purge(before: Date): number;
    close(): void;
}
