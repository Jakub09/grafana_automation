import fs from 'node:fs';
import path from 'node:path';
import type { DatabaseSync, SQLInputValue } from 'node:sqlite';
import {
    NewQueueJob, NotificationQueue, QUEUE_STATUSES, QueueJob, QueueJobStatus,
} from '../../application/alerting/notification-queue';
import { ConflictError, NotFoundError } from '../../shared/errors';

/**
 * node:sqlite jest wbudowany w Node (22.13+), ale Node 22 oznacza go jako eksperymentalny i wypisuje
 * ostrzeżenie przy pierwszym użyciu - tylko to jedno ostrzeżenie jest wyciszane.
 */
function loadSqlite(): typeof import('node:sqlite') {
    const original = process.emitWarning;
    process.emitWarning = ((warning: string | Error, ...rest: unknown[]) => {
        if (String(typeof warning === 'string' ? warning : warning.message).includes('SQLite')) return;
        return (original as (...args: unknown[]) => void).call(process, warning, ...rest);
    }) as typeof process.emitWarning;
    try {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        return require('node:sqlite') as typeof import('node:sqlite');
    } finally {
        process.emitWarning = original;
    }
}

interface Row {
    id: string;
    received_at: string;
    updated_at: string;
    status: QueueJobStatus;
    attempts: number;
    next_attempt_at: string | null;
    dedupe_key: string;
    payload: string;
    summary: string;
    sent_to: string;
    last_error: string | null;
    duplicate_of: string | null;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS notification_jobs (
    id TEXT PRIMARY KEY,
    received_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    status TEXT NOT NULL,
    attempts INTEGER NOT NULL DEFAULT 0,
    next_attempt_at TEXT,
    dedupe_key TEXT NOT NULL,
    payload TEXT NOT NULL,
    summary TEXT NOT NULL,
    sent_to TEXT NOT NULL DEFAULT '[]',
    last_error TEXT,
    duplicate_of TEXT
);
CREATE INDEX IF NOT EXISTS idx_jobs_status_next ON notification_jobs (status, next_attempt_at);
CREATE INDEX IF NOT EXISTS idx_jobs_dedupe ON notification_jobs (dedupe_key, received_at);
`;

const toJob = (r: Row): QueueJob => ({
    id: r.id,
    receivedAt: new Date(r.received_at),
    updatedAt: new Date(r.updated_at),
    status: r.status,
    attempts: r.attempts,
    nextAttemptAt: r.next_attempt_at ? new Date(r.next_attempt_at) : null,
    dedupeKey: r.dedupe_key,
    payload: JSON.parse(r.payload),
    summary: r.summary,
    sentTo: JSON.parse(r.sent_to),
    lastError: r.last_error,
    duplicateOf: r.duplicate_of,
});

const iso = (d: Date) => d.toISOString();

/**
 * Kolejka powiadomień w pliku SQLite (tryb WAL - serwer i CLI mogą korzystać jednocześnie).
 * ":memory:" - kolejka w pamięci (testy).
 */
export class SqliteNotificationQueue implements NotificationQueue {
    private readonly db: DatabaseSync;

    constructor(readonly filePath: string) {
        if (filePath !== ':memory:') fs.mkdirSync(path.dirname(path.resolve(filePath)), { recursive: true });
        const { DatabaseSync } = loadSqlite();
        this.db = new DatabaseSync(filePath);
        this.db.exec('PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;');
        this.db.exec(SCHEMA);
    }

    private row(sql: string, ...params: SQLInputValue[]): Row | undefined {
        return this.db.prepare(sql).get(...params) as Row | undefined;
    }

    private run(sql: string, ...params: SQLInputValue[]): number {
        return Number(this.db.prepare(sql).run(...params).changes);
    }

    private require(id: string): QueueJob {
        const job = this.get(id);
        if (!job) throw new NotFoundError(`Zadanie ${id} nie istnieje w kolejce`);
        return job;
    }

    public add(job: NewQueueJob): QueueJob {
        const now = iso(job.receivedAt);
        this.run(
            `INSERT INTO notification_jobs (id, received_at, updated_at, status, attempts, next_attempt_at, dedupe_key, payload, summary, duplicate_of)
             VALUES (?, ?, ?, ?, 0, ?, ?, ?, ?, ?)`,
            job.id, now, now, job.status, job.status === 'pending' ? now : null, job.dedupeKey,
            JSON.stringify(job.payload), job.summary, job.duplicateOf ?? null,
        );
        return this.require(job.id);
    }

    public get(id: string): QueueJob | null {
        const r = this.row('SELECT * FROM notification_jobs WHERE id = ?', id);
        return r ? toJob(r) : null;
    }

    public findByDedupeKey(key: string, since: Date): QueueJob | null {
        const r = this.row(
            `SELECT * FROM notification_jobs WHERE dedupe_key = ? AND received_at >= ? AND status != 'duplicate'
             ORDER BY received_at DESC LIMIT 1`,
            key, iso(since),
        );
        return r ? toJob(r) : null;
    }

    public claimNext(now: Date): QueueJob | null {
        const r = this.row(
            `UPDATE notification_jobs SET status = 'processing', attempts = attempts + 1, updated_at = ?
             WHERE id = (SELECT id FROM notification_jobs WHERE status = 'pending' AND next_attempt_at <= ?
                         ORDER BY next_attempt_at, received_at LIMIT 1)
             RETURNING *`,
            iso(now), iso(now),
        );
        return r ? toJob(r) : null;
    }

    public markSent(id: string, recipientKey: string): void {
        const job = this.require(id);
        if (job.sentTo.includes(recipientKey)) return;
        this.run('UPDATE notification_jobs SET sent_to = ?, updated_at = ? WHERE id = ?',
            JSON.stringify([...job.sentTo, recipientKey]), iso(new Date()), id);
    }

    public complete(id: string): void {
        this.run(`UPDATE notification_jobs SET status = 'done', next_attempt_at = NULL, last_error = NULL, updated_at = ? WHERE id = ?`,
            iso(new Date()), id);
    }

    public reschedule(id: string, nextAttemptAt: Date, error: string): void {
        this.run(`UPDATE notification_jobs SET status = 'pending', next_attempt_at = ?, last_error = ?, updated_at = ? WHERE id = ?`,
            iso(nextAttemptAt), error, iso(new Date()), id);
    }

    public fail(id: string, error: string): void {
        this.run(`UPDATE notification_jobs SET status = 'failed', next_attempt_at = NULL, last_error = ?, updated_at = ? WHERE id = ?`,
            error, iso(new Date()), id);
    }

    public retry(id: string): QueueJob {
        const job = this.require(id);
        if (job.status === 'processing') throw new ConflictError(`Zadanie ${id} jest właśnie przetwarzane`);
        const now = iso(new Date());
        this.run(`UPDATE notification_jobs SET status = 'pending', attempts = 0, next_attempt_at = ?, updated_at = ? WHERE id = ?`,
            now, now, id);
        return this.require(id);
    }

    public recoverInterrupted(): number {
        const now = iso(new Date());
        return this.run(`UPDATE notification_jobs SET status = 'pending', next_attempt_at = ?, updated_at = ? WHERE status = 'processing'`,
            now, now);
    }

    public list(filter: { status?: QueueJobStatus; limit?: number } = {}): QueueJob[] {
        const limit = filter.limit ?? 50;
        const rows = (filter.status
            ? this.db.prepare('SELECT * FROM notification_jobs WHERE status = ? ORDER BY received_at DESC LIMIT ?').all(filter.status, limit)
            : this.db.prepare('SELECT * FROM notification_jobs ORDER BY received_at DESC LIMIT ?').all(limit)) as unknown as Row[];
        return rows.map(toJob);
    }

    public counts(): Record<QueueJobStatus, number> {
        const rows = this.db.prepare('SELECT status, COUNT(*) AS n FROM notification_jobs GROUP BY status').all() as { status: QueueJobStatus; n: number }[];
        const counts = Object.fromEntries(QUEUE_STATUSES.map(s => [s, 0])) as Record<QueueJobStatus, number>;
        for (const r of rows) counts[r.status] = Number(r.n);
        return counts;
    }

    public purge(before: Date): number {
        return this.run(`DELETE FROM notification_jobs WHERE status IN ('done', 'duplicate', 'failed') AND updated_at < ?`, iso(before));
    }

    public close(): void {
        if (this.db.isOpen) this.db.close();
    }
}
