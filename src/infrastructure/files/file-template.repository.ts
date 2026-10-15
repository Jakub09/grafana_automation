import fs from 'node:fs/promises';
import path from 'node:path';
import { TemplateRepository } from '../../application/ports';
import { NotFoundError } from '../../shared/errors';

export class FileTemplateRepository implements TemplateRepository {
    public async load(templatePath: string): Promise<string> {
        const absolute = path.resolve(templatePath);
        try {
            return await fs.readFile(absolute, 'utf-8');
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
                throw new NotFoundError(`Szablon ${absolute} nie istnieje`);
            }
            throw error;
        }
    }
}
