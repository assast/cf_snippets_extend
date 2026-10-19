import { createServer } from 'node:http';
import { mkdir, readFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { openDatabase } from './database.mjs';
import { worker } from './worker.mjs';

export async function createApplication({ databasePath, apiKey, pagesHostname = '' }) {
    if (!apiKey) throw new Error('API_KEY is required');
    if (databasePath !== ':memory:') await mkdir(dirname(databasePath), { recursive: true });
    const db = openDatabase(databasePath);
    const html = await readFile(new URL('../public/index.html', import.meta.url));
    const env = {
        DB: db,
        API_KEY: apiKey,
        PAGES_HOSTNAME: pagesHostname,
        ASSETS: {
            async fetch(request) {
                const path = new URL(request.url).pathname;
                if (path !== '/' && path !== '/index.html') return new Response('Not Found', { status: 404 });
                return new Response(html, { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
            },
        },
    };
    try {
        // 在开始接收请求前完成建表和旧数据结构迁移。
        await worker.fetch(new Request('http://localhost/'), env);
    } catch (error) {
        db.close();
        throw error;
    }

    const server = createServer(async (incoming, outgoing) => {
        try {
            if (incoming.url === '/healthz' && incoming.method === 'GET') {
                await db.prepare('SELECT 1').first();
                outgoing.writeHead(200, { 'Content-Type': 'application/json' });
                outgoing.end('{"status":"ok"}');
                return;
            }
            const protocol = incoming.headers['x-forwarded-proto']?.split(',')[0].trim() || 'http';
            const host = incoming.headers['x-forwarded-host']?.split(',')[0].trim() || incoming.headers.host;
            const controller = new AbortController();
            incoming.on('aborted', () => controller.abort());
            const request = new Request(new URL(incoming.url, `${protocol}://${host}`), {
                method: incoming.method,
                headers: incoming.headers,
                body: ['GET', 'HEAD'].includes(incoming.method) ? undefined : Readable.toWeb(incoming),
                duplex: 'half',
                signal: controller.signal,
            });
            const response = await worker.fetch(request, env);
            outgoing.writeHead(response.status, Object.fromEntries(response.headers));
            if (incoming.method === 'HEAD' || !response.body) outgoing.end();
            else await pipeline(Readable.fromWeb(response.body), outgoing);
        } catch (error) {
            console.error('Request failed:', error.message);
            if (!outgoing.headersSent) {
                outgoing.writeHead(500, { 'Content-Type': 'application/json' });
                outgoing.end('{"error":"Internal Server Error"}');
            } else outgoing.destroy();
        }
    });
    return { server, db };
}
