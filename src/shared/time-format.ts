const pad = (n: number) => String(n).padStart(2, '0');

/** "YYYY-MM-DD HH:MM:SS" w czasie lokalnym serwera */
export function formatDataTimestamp(date: Date): string {
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} `
        + `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

/** "DD.MM.YYYY HH:MM" */
export function formatDisplayDate(date: Date): string {
    return `${pad(date.getDate())}.${pad(date.getMonth() + 1)}.${date.getFullYear()} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/** "YYYY-MM-DD" */
export function formatIsoDay(date: Date): string {
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/** "YYYYMMDD-HHMMSS" - do nazw plików/katalogów */
export function formatFileStamp(date: Date): string {
    return formatDataTimestamp(date).replace(/[-:]/g, '').replace(' ', '-');
}

/** "DD.MM.YYYY" */
export function formatDisplayDay(date: Date): string {
    return `${pad(date.getDate())}.${pad(date.getMonth() + 1)}.${date.getFullYear()}`;
}
