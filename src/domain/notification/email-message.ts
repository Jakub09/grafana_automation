import { ValidationError } from '../../shared/errors';

export interface InlineImage {
    contentId: string; // odwołanie w HTML: <img src="cid:...">
    filePath: string;
}

/** Zwykły załącznik (np. raport PDF) */
export interface Attachment {
    fileName: string;
    filePath: string;
    contentType: string;
}

export interface EmailMessage {
    to: string[];
    subject: string;
    html: string;
    inlineImages: InlineImage[];
    attachments?: Attachment[];
}

const EMAIL = /^[^\s@,;<>]+@[^\s@,;<>]+$/;

/** Lista adresów z tekstu ("a@x, b@x; c@x") lub tablicy - walidacja i deduplikacja */
export function parseRecipients(value: string | readonly string[]): string[] {
    const items = (typeof value === 'string' ? [value] : value)
        .flatMap(v => v.split(/[,;]/))
        .map(v => v.trim())
        .filter(Boolean);

    const invalid = items.filter(a => !EMAIL.test(a));
    if (invalid.length) {
        throw new ValidationError(`Niepoprawne adresy e-mail: ${invalid.join(', ')}`);
    }
    return [...new Set(items)];
}

export function createEmailMessage(message: EmailMessage): EmailMessage {
    if (message.to.length === 0) throw new ValidationError('Wiadomość nie ma odbiorców');
    if (!message.subject.trim()) throw new ValidationError('Wiadomość nie ma tematu');
    return { ...message, to: parseRecipients(message.to) };
}
