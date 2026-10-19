import { DatabaseSync } from 'node:sqlite';

// 保留 D1 的异步调用接口和返回结构，业务 SQL 无需修改。
export function openDatabase(path) {
    const sqlite = new DatabaseSync(path, { enableDoubleQuotedStringLiterals: true });
    sqlite.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');

    function prepare(sql, params = []) {
        return {
            bind(...values) { return prepare(sql, values); },
            async all() { return { success: true, results: sqlite.prepare(sql).all(...params) }; },
            async first(column) {
                const row = sqlite.prepare(sql).get(...params);
                return row ? (column === undefined ? row : row[column]) : null;
            },
            async run() { return run(); },
            execute: run,
        };

        function run() {
            const result = sqlite.prepare(sql).run(...params);
            return { success: true, results: [], meta: { changes: Number(result.changes), last_row_id: Number(result.lastInsertRowid) } };
        }
    }

    return {
        prepare,
        async exec(sql) { sqlite.exec(sql); return { success: true }; },
        async batch(statements) {
            sqlite.exec('BEGIN IMMEDIATE');
            try {
                const results = statements.map(statement => statement.execute());
                sqlite.exec('COMMIT');
                return results;
            } catch (error) {
                sqlite.exec('ROLLBACK');
                throw error;
            }
        },
        close() { sqlite.close(); },
    };
}
