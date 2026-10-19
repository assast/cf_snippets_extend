import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:net';
import { once } from 'node:events';
import { openDatabase } from '../server/database.mjs';
import { createApplication } from '../server/app.mjs';
import { connect } from '../server/sockets.mjs';
import { importD1 } from '../server/import-d1.mjs';

test('D1 adapter preserves SQLite values and rolls back failed batches', async () => {
    const db = openDatabase(':memory:');
    try {
        await db.exec('CREATE TABLE records (id INTEGER PRIMARY KEY, value TEXT UNIQUE, created_at TEXT)');
        const inserted = await db.prepare('INSERT INTO records (value, created_at) VALUES (?, datetime("now"))').bind('中文').run();
        assert.equal(inserted.meta.last_row_id, 1);
        assert.equal(inserted.meta.changes, 1);
        assert.equal(await db.prepare('SELECT value FROM records WHERE id = ?').bind(1).first('value'), '中文');
        await assert.rejects(db.batch([
            db.prepare('INSERT INTO records (value) VALUES (?)').bind('rolled back'),
            db.prepare('INSERT INTO records (value) VALUES (?)').bind('中文'),
        ]));
        assert.equal((await db.prepare('SELECT * FROM records').all()).results.length, 1);
    } finally {
        db.close();
    }
});

test('Docker HTTP runtime authenticates, serves subscriptions and persists D1 imports', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'cf-snippets-test-'));
    const databasePath = join(directory, 'app.sqlite');
    const sqlPath = join(directory, 'd1.sql');
    await writeFile(sqlPath, `CREATE TABLE cf_ips (id INTEGER PRIMARY KEY, address TEXT, port INTEGER, remark TEXT, sort_order INTEGER, created_at TEXT, updated_at TEXT);
        INSERT INTO cf_ips VALUES (42, '104.16.1.1', 443, '迁移记录', 0, '2026-01-01', '2026-01-01');`);
    await importD1(sqlPath, databasePath);
    await assert.rejects(importD1(sqlPath, databasePath), /already exists/);
    let app;
    try {
        app = await createApplication({ databasePath, apiKey: 'test-secret' });
        app.server.listen(0, '127.0.0.1');
        await once(app.server, 'listening');
        let origin = `http://127.0.0.1:${app.server.address().port}`;
        const call = (path, init) => fetch(origin + path, init);
        assert.equal((await call('/healthz')).status, 200);
        assert.match(await (await call('/')).text(), /<html/i);
        assert.equal((await call('/_worker.js')).status, 404);
        assert.equal((await call('/api/cfip')).status, 401);
        assert.equal((await call('/api/auth/login', { method: 'POST', body: JSON.stringify({ apiKey: 'wrong' }) })).status, 401);
        const login = await (await call('/api/auth/login', { method: 'POST', body: JSON.stringify({ apiKey: 'test-secret' }) })).json();
        const headers = { 'X-API-Key': login.apiKey, 'Content-Type': 'application/json' };
        const cfips = await (await call('/api/cfip', { headers })).json();
        assert.equal(cfips.data[0].id, 42);
        assert.equal(cfips.data[0].remark, '迁移记录');
        const added = await (await call('/api/proxyip', { method: 'POST', headers, body: JSON.stringify({ address: '1.2.3.4', remark: '持久化' }) })).json();
        assert.equal(added.success, true);
        const config = await (await call('/api/subscribe/config', { method: 'POST', headers, body: JSON.stringify({ type: 'vless', uuid: '11111111-1111-4111-8111-111111111111', snippetsDomain: 'example.com', proxyPath: '/proxyip=' }) })).json();
        assert.equal(config.success, true);
        const subscription = await call(`/sub/token/${config.data.token}`);
        assert.equal(subscription.status, 200);
        assert.match(Buffer.from(await subscription.text(), 'base64').toString(), /vless:\/\//);
        assert.equal((await call('/api/internal/cfip', { headers: { 'X-Internal-Key': 'test-secret' } })).status, 200);
        await new Promise(resolve => app.server.close(resolve));
        app.db.close();
        app = await createApplication({ databasePath, apiKey: 'test-secret' });
        app.server.listen(0, '127.0.0.1');
        await once(app.server, 'listening');
        origin = `http://127.0.0.1:${app.server.address().port}`;
        const persisted = await (await call('/api/proxyip', { headers })).json();
        assert.equal(persisted.data[0].remark, '持久化');
        assert.equal((await call(`/sub/token/${config.data.token}`)).status, 200);
    } finally {
        if (app) {
            await new Promise(resolve => app.server.close(resolve));
            app.db.close();
        }
        await rm(directory, { recursive: true, force: true });
    }
});

test('Cloudflare socket adapter supports TCP Web Streams and connection errors', async () => {
    const server = createServer(socket => socket.pipe(socket));
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const port = server.address().port;
    const socket = connect({ hostname: '127.0.0.1', port });
    const writer = socket.writable.getWriter();
    const reader = socket.readable.getReader();
    try {
        await writer.write(new TextEncoder().encode('SOCKS5 test'));
        assert.equal(new TextDecoder().decode((await reader.read()).value), 'SOCKS5 test');
    } finally {
        socket.close();
        await new Promise(resolve => server.close(resolve));
    }
    const refused = connect({ hostname: '127.0.0.1', port });
    await assert.rejects(refused.readable.getReader().read(), /ECONNREFUSED/);
    refused.close();
});
