/**
 * Generuje schemas/*.schema.json z walidatorów plików konfiguracyjnych (zod).
 * Pliki konfiguracyjne odwołują się do nich polem "$schema" - edytor (np. VS Code)
 * podpowiada klucze, opisy i wartości domyślne oraz podkreśla błędy.
 *   npm run schemas
 */
import fs from 'node:fs';
import path from 'node:path';
import { zodToJsonSchema } from 'zod-to-json-schema';
import { blueprintFileSchema, reportFileSchema } from '../src/infrastructure/files/file-schemas';

export const SCHEMAS = {
    'report.schema.json': { schema: reportFileSchema, title: 'Definicja raportu (reports/<id>/report.json)' },
    'blueprint.schema.json': { schema: blueprintFileSchema, title: 'Blueprint schematu danych (blueprints/<nazwa>.json)' },
};

export function renderSchema(name: keyof typeof SCHEMAS): string {
    const { schema, title } = SCHEMAS[name];
    const json = zodToJsonSchema(schema, { target: 'jsonSchema7', $refStrategy: 'none' });
    return JSON.stringify({ ...json, title }, null, 2) + '\n';
}

if (require.main === module) {
    const dir = path.resolve(__dirname, '../schemas');
    fs.mkdirSync(dir, { recursive: true });
    for (const name of Object.keys(SCHEMAS) as (keyof typeof SCHEMAS)[]) {
        fs.writeFileSync(path.join(dir, name), renderSchema(name));
        console.log(`Zapisano schemas/${name}`);
    }
}
