import { DatabaseSync } from 'node:sqlite';
import { access, chmod, mkdir, readFile, rename, rm } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export async function importD1(sqlPath, databasePath) {
    await mkdir(dirname(databasePath), { recursive: true });
    try {
        await access(databasePath);
    } catch (error) {
        if (error.code !== 'ENOENT') throw error;
        return createDatabase();
    }
    throw new Error('Destination database already exists; import into a new file');

    async function createDatabase() {
        const temporaryPath = `${databasePath}.${process.pid}.tmp`;
        const sqlite = new DatabaseSync(temporaryPath, { enableDoubleQuotedStringLiterals: true });
        try {
            await chmod(temporaryPath, 0o600);
            sqlite.exec(await readFile(sqlPath, 'utf8'));
            const integrity = sqlite.prepare('PRAGMA integrity_check').get();
            if (integrity.integrity_check !== 'ok') throw new Error('SQLite integrity check failed');
            const tables = sqlite.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%'").all();
            const counts = Object.fromEntries(tables.map(({ name }) => [name, sqlite.prepare(`SELECT COUNT(*) AS count FROM "${name.replaceAll('"', '""')}"`).get().count]));
            sqlite.close();
            await rename(temporaryPath, databasePath);
            return counts;
        } catch (error) {
            if (sqlite.isOpen) sqlite.close();
            await rm(temporaryPath, { force: true });
            throw error;
        }
    }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
    const [sqlPath, databasePath] = process.argv.slice(2);
    if (!sqlPath || !databasePath) throw new Error('Usage: npm run import:d1 -- backup.sql /data/snippets.sqlite');
    console.log(JSON.stringify(await importD1(sqlPath, databasePath), null, 2));
}
