import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import vm from 'node:vm';

async function loadWorkerInternals() {
    let source = await fs.readFile(new URL('../public/_worker.js', import.meta.url), 'utf8');
    source = source.replace("import { connect } from 'cloudflare:sockets';", "const connect = () => { throw new Error('connect is not available in tests'); };");
    source = source.replace('export default {', 'const __workerDefault = {');
    source += '\n;globalThis.__testExports = { handleGetCFIPs, handleSubscribe, handleArgoSubscribe, handleSetCFIPBlacklist, handleBatchDeleteCFIPByFailCount };';

    const context = {
        console,
        Response,
        Request,
        URL,
        URLSearchParams,
        Headers,
        TextEncoder,
        TextDecoder,
        crypto,
        setTimeout,
        clearTimeout,
        escape: globalThis.escape,
        unescape: globalThis.unescape,
        btoa: (value) => Buffer.from(value, 'binary').toString('base64'),
        atob: (value) => Buffer.from(value, 'base64').toString('binary'),
    };

    vm.createContext(context);
    new vm.Script(source, { filename: 'public/_worker.js' }).runInContext(context);
    return context.__testExports;
}

class MockPreparedStatement {
    constructor(db, query) {
        this.db = db;
        this.query = query;
        this.params = [];
    }

    bind(...params) {
        this.params = params;
        return this;
    }

    async all() {
        if (this.query.includes('FROM cf_ips')) {
            return { results: this.db.queryCfips(this.query, this.params) };
        }
        if (this.query.includes('FROM proxy_ips')) {
            return { results: [] };
        }
        if (this.query.includes('FROM outbounds')) {
            return { results: [] };
        }
        if (this.query.includes('FROM argo_subscribe')) {
            return { results: this.db.queryArgoSubscribes(this.query, this.params) };
        }
        throw new Error(`Unsupported all() query: ${this.query}`);
    }

    async first() {
        const results = (await this.all()).results;
        return results[0] || null;
    }

    async run() {
        if (this.query.startsWith('DELETE FROM cf_ips WHERE COALESCE(fail_count, 0) >= ?')) {
            const failCount = Number(this.params[0]);
            const before = this.db.cfips.length;
            this.db.cfips = this.db.cfips.filter(item => Number(item.fail_count || 0) < failCount);
            return { meta: { changes: before - this.db.cfips.length } };
        }

        if (this.query.startsWith('UPDATE cf_ips SET ')) {
            const fieldMatch = this.query.match(/UPDATE cf_ips SET (\w+) = \?, updated_at/);
            if (!fieldMatch) throw new Error(`Unsupported update query: ${this.query}`);
            const field = fieldMatch[1];
            const value = this.params[0];
            const id = this.params[1];
            let changes = 0;
            this.db.cfips = this.db.cfips.map(item => {
                if (item.id !== id) return item;
                changes += 1;
                return { ...item, [field]: value };
            });
            return { meta: { changes } };
        }

        throw new Error(`Unsupported run() query: ${this.query}`);
    }
}

class MockDb {
    constructor(cfips, argoSubscribes = []) {
        this.cfips = cfips;
        this.argoSubscribes = argoSubscribes;
        this.queries = [];
    }

    prepare(query) {
        this.queries.push(query);
        return new MockPreparedStatement(this, query);
    }

    queryCfips(query, params) {
        let results = [...this.cfips];

        if (query.includes('id IN (')) {
            const ids = new Set(params.map(Number));
            results = results.filter(item => ids.has(Number(item.id)));
        }

        const statusChecks = [];
        if (query.includes("status = 'enabled' OR status IS NULL")) statusChecks.push(item => !item.status || item.status === 'enabled');
        if (query.includes("status = 'disabled'")) statusChecks.push(item => item.status === 'disabled');
        if (query.includes("status = 'invalid'")) statusChecks.push(item => item.status === 'invalid');
        if (statusChecks.length > 0) {
            results = results.filter(item => statusChecks.some(check => check(item)));
        }

        if (query.includes('(sync_blacklisted = 0 OR sync_blacklisted IS NULL)')) {
            results = results.filter(item => Number(item.sync_blacklisted || 0) === 0);
        }
        if (query.includes('(node_blacklisted = 0 OR node_blacklisted IS NULL)')) {
            results = results.filter(item => Number(item.node_blacklisted || 0) === 0);
        }

        if (query.includes('ORDER BY speed DESC, sort_order, id')) {
            results.sort((a, b) => (b.speed || 0) - (a.speed || 0) || (a.sort_order || 0) - (b.sort_order || 0) || a.id - b.id);
        } else if (query.includes('ORDER BY latency ASC, sort_order, id')) {
            results.sort((a, b) => (a.latency || 0) - (b.latency || 0) || (a.sort_order || 0) - (b.sort_order || 0) || a.id - b.id);
        } else if (query.includes('ORDER BY sort_order, id')) {
            results.sort((a, b) => (a.sort_order || 0) - (b.sort_order || 0) || a.id - b.id);
        }

        if (query.includes('LIMIT ? OFFSET ?')) {
            const limit = Number(params[params.length - 2]);
            const offset = Number(params[params.length - 1]);
            results = results.slice(offset, offset + limit);
        }

        return results;
    }

    queryArgoSubscribes(query, params) {
        let results = [...this.argoSubscribes];

        if (query.includes('token = ?')) {
            results = results.filter(item => item.token === params[0]);
        }
        if (query.includes('enabled = 1')) {
            results = results.filter(item => Number(item.enabled) === 1);
        }

        return results;
    }
}

function createCfips() {
    return [
        { id: 1, address: 'dns-blacklisted.example.com', port: 443, remark: 'dns-only', name: 'dns-only', status: 'enabled', sync_blacklisted: 1, node_blacklisted: 0, sort_order: 1, speed: 3000, fail_count: 3 },
        { id: 2, address: 'node-blacklisted.example.com', port: 443, remark: 'node-only', name: 'node-only', status: 'enabled', sync_blacklisted: 0, node_blacklisted: 1, sort_order: 2, speed: 2000, fail_count: 5 },
        { id: 3, address: 'clean.example.com', port: 443, remark: 'clean', name: 'clean', status: 'enabled', sync_blacklisted: 0, node_blacklisted: 0, sort_order: 3, speed: 1000, fail_count: 0 },
    ];
}

test('sync-only CFIP query excludes DNS blacklist but keeps node blacklist', async () => {
    const { handleGetCFIPs } = await loadWorkerInternals();
    const db = new MockDb(createCfips());

    const response = await handleGetCFIPs(db, { syncOnly: true });
    const payload = await response.json();
    const addresses = payload.data.map(item => item.address);

    assert.deepEqual(addresses, ['node-blacklisted.example.com', 'clean.example.com']);
});

test('subscribe generation excludes node blacklist but keeps DNS blacklist', async () => {
    const { handleSubscribe } = await loadWorkerInternals();
    const db = new MockDb(createCfips());
    const config = {
        uuid: 'test-uuid',
        snippets_domain: 'worker.example.com',
        proxy_path: '/?ed=2560',
        remark: 'TEST',
        include_blacklisted_cfip: 0,
    };

    const response = await handleSubscribe(db, 'test-uuid', 'https://example.com/sub/test-uuid', config);
    const encoded = await response.text();
    const decoded = Buffer.from(encoded, 'base64').toString('utf8');

    assert.match(decoded, /dns-blacklisted\.example\.com/);
    assert.match(decoded, /clean\.example\.com/);
    assert.doesNotMatch(decoded, /node-blacklisted\.example\.com/);
});

test('smart-only subscribe uses limited smart CFIP query', async () => {
    const { handleSubscribe } = await loadWorkerInternals();
    const cfips = Array.from({ length: 120 }, (_, index) => ({
        id: index + 1,
        address: `198.51.100.${index + 1}`,
        port: 443,
        remark: `ip-${index + 1}`,
        name: `ip-${index + 1}`,
        status: 'enabled',
        sync_blacklisted: 0,
        node_blacklisted: 1,
        sort_order: index + 1,
        speed: 10000 - index,
        latency: index + 1,
        fail_count: 0,
    }));
    const db = new MockDb(cfips);
    const config = {
        uuid: 'test-uuid',
        snippets_domain: 'worker.example.com',
        proxy_path: '/?ed=2560',
        remark: 'TEST',
        include_blacklisted_cfip: 0,
    };

    const response = await handleSubscribe(
        db,
        'test-uuid',
        'https://example.com/sub/test-uuid?speedTop=5&extraCount=0&latencyTop=0&include_blacklisted_cfip=1',
        config
    );
    const encoded = await response.text();
    const decoded = Buffer.from(encoded, 'base64').toString('utf8');
    const readable = decodeURIComponent(decoded);
    const lines = decoded.split('\n').filter(Boolean);
    const cfipQueries = db.queries.filter(query => query.includes('FROM cf_ips'));

    assert.equal(lines.length, 5);
    assert.match(readable, /最大速度1-TEST/);
    assert.equal(cfipQueries.length, 1);
    assert.match(cfipQueries[0], /LIMIT \? OFFSET \?/);
});

test('argo smart-only subscribe supports smart and blacklist URL parameters', async () => {
    const { handleArgoSubscribe } = await loadWorkerInternals();
    const cfips = Array.from({ length: 120 }, (_, index) => ({
        id: index + 1,
        address: `198.51.100.${index + 1}`,
        port: 443,
        remark: `ip-${index + 1}`,
        name: `ip-${index + 1}`,
        status: 'enabled',
        sync_blacklisted: 0,
        node_blacklisted: 1,
        sort_order: index + 1,
        speed: 10000 - index,
        latency: index + 1,
        fail_count: 0,
    }));
    const db = new MockDb(cfips, [{
        token: 'argo-token',
        template_link: 'vless://test-uuid@origin.example.com:443?encryption=none&security=tls&type=ws#ARGO',
        enabled: 1,
        include_blacklisted_cfip: 0,
    }]);

    const response = await handleArgoSubscribe(
        db,
        'argo-token',
        'https://example.com/sub/argo/argo-token?speedTop=5&extraCount=0&latencyTop=0&include_blacklisted_cfip=1'
    );
    const encoded = await response.text();
    const decoded = Buffer.from(encoded, 'base64').toString('utf8');
    const readable = decodeURIComponent(decoded);
    const lines = decoded.split('\n').filter(Boolean);
    const cfipQueries = db.queries.filter(query => query.includes('FROM cf_ips'));

    assert.equal(lines.length, 5);
    assert.match(readable, /最大速度1-ARGO/);
    assert.match(decoded, /198\.51\.100\.1/);
    assert.equal(cfipQueries.length, 1);
    assert.match(cfipQueries[0], /LIMIT \? OFFSET \?/);
});

test('argo smart-only subscribe keeps domain CFIP candidates', async () => {
    const { handleArgoSubscribe } = await loadWorkerInternals();
    const db = new MockDb([
        {
            id: 1,
            address: 'fast.example.com',
            port: 443,
            remark: 'domain-cfip',
            name: 'domain-cfip',
            status: 'enabled',
            sync_blacklisted: 0,
            node_blacklisted: 0,
            sort_order: 1,
            speed: 10000,
            latency: 10,
            fail_count: 0,
        },
        {
            id: 2,
            address: '198.51.100.2',
            port: 443,
            remark: 'ip-cfip',
            name: 'ip-cfip',
            status: 'enabled',
            sync_blacklisted: 0,
            node_blacklisted: 0,
            sort_order: 2,
            speed: 9000,
            latency: 20,
            fail_count: 0,
        },
    ], [{
        token: 'argo-token',
        template_link: 'vless://test-uuid@origin.example.com:443?encryption=none&security=tls&type=ws#ARGO',
        enabled: 1,
        include_blacklisted_cfip: 0,
    }]);

    const response = await handleArgoSubscribe(
        db,
        'argo-token',
        'https://example.com/sub/argo/argo-token?speedTop=1&extraCount=0'
    );
    const encoded = await response.text();
    const decoded = Buffer.from(encoded, 'base64').toString('utf8');

    assert.match(decoded, /fast\.example\.com/);
    assert.doesNotMatch(decoded, /198\.51\.100\.2/);
});

test('argo subscribe prefers config remark over vmess template ps', async () => {
    const { handleArgoSubscribe } = await loadWorkerInternals();
    const vmessConfig = {
        v: '2',
        ps: 'US-HostPapa',
        add: 'origin.example.com',
        port: '443',
        id: 'a02d2665-fa72-4a03-9554-aab4625631d6',
        aid: '0',
        scy: 'auto',
        net: 'ws',
        type: 'none',
        host: 'server14.example.com',
        path: '/vmess-argo?ed=2560',
        tls: 'tls',
        sni: 'server14.example.com',
        alpn: '',
        fp: 'firefox',
        allowInsecure: 'false',
    };
    const templateLink = `vmess://${Buffer.from(JSON.stringify(vmessConfig), 'utf8').toString('base64')}`;
    const db = new MockDb([{
        id: 1,
        address: '198.51.100.1',
        port: 443,
        remark: 'cfip-1',
        name: 'cfip-1',
        status: 'enabled',
        sync_blacklisted: 0,
        node_blacklisted: 0,
        sort_order: 1,
        speed: 10000,
        latency: 10,
        fail_count: 0,
    }], [{
        token: 'argo-token',
        template_link: templateLink,
        remark: '美国 洛杉矶[CCS] LA5FJV',
        enabled: 1,
        include_blacklisted_cfip: 0,
    }]);

    const response = await handleArgoSubscribe(
        db,
        'argo-token',
        'https://example.com/sub/argo/argo-token?speedTop=1&extraCount=0'
    );
    const encoded = await response.text();
    const decoded = Buffer.from(encoded, 'base64').toString('utf8');
    const generatedConfig = JSON.parse(Buffer.from(decoded.substring('vmess://'.length), 'base64').toString('utf8'));

    assert.equal(generatedConfig.ps, '最大速度1-美国 洛杉矶[CCS] LA5FJV');
    assert.equal(generatedConfig.add, '198.51.100.1');
});

test('argo speedTop without extraCount keeps regular nodes', async () => {
    const { handleArgoSubscribe } = await loadWorkerInternals();
    const db = new MockDb([
        {
            id: 1,
            address: '198.51.100.1',
            port: 443,
            remark: 'cfip-1',
            name: 'cfip-1',
            status: 'enabled',
            sync_blacklisted: 0,
            node_blacklisted: 0,
            sort_order: 1,
            speed: 10000,
            latency: 10,
            fail_count: 0,
        },
        {
            id: 2,
            address: '198.51.100.2',
            port: 443,
            remark: 'cfip-2',
            name: 'cfip-2',
            status: 'enabled',
            sync_blacklisted: 0,
            node_blacklisted: 0,
            sort_order: 2,
            speed: 9000,
            latency: 20,
            fail_count: 0,
        },
    ], [{
        token: 'argo-token',
        template_link: 'vless://test-uuid@origin.example.com:443?encryption=none&security=tls&type=ws#TemplateName',
        remark: '美国 洛杉矶[CCS] LA5FJV',
        enabled: 1,
        include_blacklisted_cfip: 0,
    }]);

    const response = await handleArgoSubscribe(
        db,
        'argo-token',
        'https://example.com/sub/argo/argo-token?speedTop=1'
    );
    const encoded = await response.text();
    const decoded = Buffer.from(encoded, 'base64').toString('utf8');
    const readable = decodeURIComponent(decoded);
    const lines = decoded.split('\n').filter(Boolean);

    assert.equal(lines.length, 3);
    assert.match(readable, /最大速度1-美国 洛杉矶\[CCS\] LA5FJV/);
    assert.match(readable, /美国 洛杉矶\[CCS\] LA5FJV-cfip-1/);
    assert.match(readable, /美国 洛杉矶\[CCS\] LA5FJV-cfip-2/);
});

test('typed blacklist API updates node blacklist independently', async () => {
    const { handleSetCFIPBlacklist } = await loadWorkerInternals();
    const db = new MockDb(createCfips());
    const request = new Request('https://example.com/api/cfip/1/blacklist', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ blacklist_type: 'node', value: 1 }),
    });

    const response = await handleSetCFIPBlacklist(request, db, 1);
    const payload = await response.json();
    const updated = db.cfips.find(item => item.id === 1);

    assert.equal(payload.data.blacklist_type, 'node');
    assert.equal(payload.data.node_blacklisted, 1);
    assert.equal(updated.node_blacklisted, 1);
    assert.equal(updated.sync_blacklisted, 1);
});

test('batch delete CFIP by fail_count threshold deletes matching records', async () => {
    const { handleBatchDeleteCFIPByFailCount } = await loadWorkerInternals();
    const db = new MockDb(createCfips());
    const request = new Request('https://example.com/api/cfip/batch/delete-by-fail-count', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ fail_count: 3 }),
    });

    const response = await handleBatchDeleteCFIPByFailCount(request, db);
    const payload = await response.json();
    const remainingIds = db.cfips.map(item => item.id);

    assert.equal(payload.success, true);
    assert.equal(payload.data.changes, 2);
    assert.deepEqual(remainingIds, [3]);
});
