import nodemailer, { SendMailOptions, Transporter } from 'nodemailer';
import sharp from 'sharp';
import { MailSender } from '../../application/ports';
import { EmailMessage } from '../../domain/notification/email-message';
import { ExternalServiceError } from '../../shared/errors';
import { elapsedMs, logger } from '../../shared/logger';
import { metrics } from '../../shared/metrics';
import { AppConfig } from '../config/app.config';
import { htmlToText } from './html-to-text';

/**
 * Składa wiadomość: HTML + wersja tekstowa + wykresy jako obrazy PNG osadzone w wiadomości (CID).
 *
 * Dlaczego CID: Outlook (desktop) nie wyświetla obrazów "data:" w <img>, a obrazy z zewnętrznych
 * adresów domyślnie blokuje. Obraz-załącznik inline z Content-ID jest częścią wiadomości
 * i wyświetla się od razu. SVG konwertujemy do PNG - Outlook nie renderuje SVG.
 */
export async function composeMail(message: EmailMessage, sender: string): Promise<SendMailOptions> {
    const attachments = await Promise.all(message.inlineImages.map(async (img, i) => ({
        filename: `wykres-${i + 1}.png`,
        content: await sharp(img.filePath, { density: 144 }).png().toBuffer(),
        contentType: 'image/png',
        cid: img.contentId,
        contentDisposition: 'inline' as const,
    })));

    const files = (message.attachments ?? []).map(a => ({
        filename: a.fileName,
        path: a.filePath,
        contentType: a.contentType,
    }));

    return {
        from: sender,
        to: message.to,
        subject: message.subject,
        html: message.html,
        text: htmlToText(message.html),
        attachments: [...attachments, ...files],
    };
}

export class NodemailerMailSender implements MailSender {
    private constructor(
        private readonly transporter: Transporter,
        private readonly sender: string,
        private readonly service: string,
    ) {}

    public static smtp(config: AppConfig['email']['smtp'], sender: string): NodemailerMailSender {
        return new NodemailerMailSender(nodemailer.createTransport({
            host: config.host,
            port: config.port,
            secure: config.secure,
            auth: config.user ? { user: config.user, pass: config.password } : undefined,
            // krótkie limity: niedostępny serwer poczty nie blokuje kolejki powiadomień na minuty (ponowienie i tak nastąpi)
            connectionTimeout: 15_000,
            greetingTimeout: 15_000,
            socketTimeout: 60_000,
        }), sender, 'SMTP');
    }

    /** Lokalny sendmail (postfix, msmtp...) - nodemailer wywołuje go z odbiorcami z koperty */
    public static sendmail(sendmailPath: string, sender: string): NodemailerMailSender {
        return new NodemailerMailSender(nodemailer.createTransport({
            sendmail: true,
            path: sendmailPath,
            newline: 'unix',
        }), sender, 'sendmail');
    }

    public async send(message: EmailMessage): Promise<void> {
        const started = process.hrtime.bigint();
        const options = await composeMail(message, this.sender);
        const summary = {
            transport: this.service,
            to: message.to,
            subject: message.subject,
            inlineImages: message.inlineImages.length,
            attachments: (message.attachments ?? []).map(a => a.fileName),
            htmlBytes: Buffer.byteLength(message.html),
        };
        try {
            const info = await this.transporter.sendMail(options);
            metrics.inc('emails_total', { transport: this.service, result: 'ok' });
            logger.info(`E-mail "${message.subject}" wysłany do ${message.to.join(', ')}`, {
                email: { ...summary, messageId: info.messageId, response: info.response, durationMs: elapsedMs(started) },
            });
        } catch (error) {
            metrics.inc('emails_total', { transport: this.service, result: 'error' });
            logger.error(`E-mail "${message.subject}" - wysyłka nie powiodła się`, { email: summary }, error);
            throw new ExternalServiceError(this.service, `Wysyłka nie powiodła się: ${(error as Error).message}`, { cause: error });
        }
    }
}
