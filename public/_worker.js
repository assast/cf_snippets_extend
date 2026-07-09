// Cloudflare Pages _worker.js
// 此文件将处理所有请求，包括静态文件和 API
import { connect } from 'cloudflare:sockets';
const CORS = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, X-API-Key, X-Internal-Key',
};
const CFIP_SYNC_ALLOWED_CONDITION = '(sync_blacklisted = 0 OR sync_blacklisted IS NULL)';
const CFIP_SUBSCRIBE_ALLOWED_CONDITION = '(node_blacklisted = 0 OR node_blacklisted IS NULL)';
const SMART_NODE_QUERY_CHUNK_SIZE = 50;
let dbInitialized = false;
let dbInitPromise = null;

async function ensureDB(db) {
    if (dbInitialized) return;

    if (!dbInitPromise) {
        dbInitPromise = initDB(db)
            .then(() => {
                dbInitialized = true;
            })
            .catch(error => {
                dbInitPromise = null;
                throw error;
            });
    }

    await dbInitPromise;
}

// 自动初始化数据库
async function initDB(db) {
    await db.exec(`
        CREATE TABLE IF NOT EXISTS sessions (id INTEGER PRIMARY KEY, api_key TEXT UNIQUE, expires_at TEXT, created_at TEXT);
        CREATE TABLE IF NOT EXISTS proxy_ips (id INTEGER PRIMARY KEY, address TEXT, type TEXT, remark TEXT, enabled INTEGER DEFAULT 1, sort_order INTEGER DEFAULT 0, created_at TEXT, updated_at TEXT);
        CREATE TABLE IF NOT EXISTS outbounds (id INTEGER PRIMARY KEY, address TEXT, type TEXT, remark TEXT, enabled INTEGER DEFAULT 1, sort_order INTEGER DEFAULT 0, exit_country TEXT, exit_city TEXT, exit_ip TEXT, exit_org TEXT, checked_at TEXT, created_at TEXT, updated_at TEXT);
        CREATE TABLE IF NOT EXISTS cf_ips (id INTEGER PRIMARY KEY, address TEXT, port INTEGER DEFAULT 443, remark TEXT, sort_order INTEGER DEFAULT 0, sync_blacklisted INTEGER DEFAULT 0, node_blacklisted INTEGER DEFAULT 0, created_at TEXT, updated_at TEXT);
        CREATE TABLE IF NOT EXISTS subscribe_config (id INTEGER PRIMARY KEY AUTOINCREMENT, type TEXT NOT NULL, token TEXT UNIQUE NOT NULL, uuid TEXT, snippets_domain TEXT, proxy_path TEXT, remark TEXT, enabled INTEGER DEFAULT 1, sort_order INTEGER DEFAULT 0, include_blacklisted_cfip INTEGER DEFAULT 0, created_at TEXT, updated_at TEXT);
        CREATE TABLE IF NOT EXISTS argo_subscribe (id INTEGER PRIMARY KEY, token TEXT UNIQUE NOT NULL, template_link TEXT NOT NULL, remark TEXT, enabled INTEGER DEFAULT 1, sort_order INTEGER DEFAULT 0, include_blacklisted_cfip INTEGER DEFAULT 0, created_at TEXT, updated_at TEXT);
    `).catch(() => { });

    // 为已存在的 outbounds 表添加新列（如果不存在）
    try {
        await db.prepare(`ALTER TABLE outbounds ADD COLUMN exit_country TEXT`).run().catch(() => { });
        await db.prepare(`ALTER TABLE outbounds ADD COLUMN exit_city TEXT`).run().catch(() => { });
        await db.prepare(`ALTER TABLE outbounds ADD COLUMN exit_ip TEXT`).run().catch(() => { });
        await db.prepare(`ALTER TABLE outbounds ADD COLUMN exit_org TEXT`).run().catch(() => { });
        await db.prepare(`ALTER TABLE outbounds ADD COLUMN exit_asn TEXT`).run().catch(() => { });
        await db.prepare(`ALTER TABLE outbounds ADD COLUMN checked_at TEXT`).run().catch(() => { });
        await db.prepare(`ALTER TABLE outbounds ADD COLUMN entry_info_json TEXT`).run().catch(() => { });
        await db.prepare(`ALTER TABLE outbounds ADD COLUMN exit_info_json TEXT`).run().catch(() => { });
    } catch (e) {
        // 列可能已存在，忽略错误
    }

    // 为 cf_ips 表添加新列
    try {
        await db.prepare(`ALTER TABLE cf_ips ADD COLUMN latency INTEGER`).run().catch(() => { });
        await db.prepare(`ALTER TABLE cf_ips ADD COLUMN speed INTEGER`).run().catch(() => { });
        await db.prepare(`ALTER TABLE cf_ips ADD COLUMN country TEXT`).run().catch(() => { });
        await db.prepare(`ALTER TABLE cf_ips ADD COLUMN isp TEXT`).run().catch(() => { });
        await db.prepare(`ALTER TABLE cf_ips ADD COLUMN name TEXT`).run().catch(() => { });
        await db.prepare(`ALTER TABLE cf_ips ADD COLUMN fail_count INTEGER DEFAULT 0`).run().catch(() => { });
        await db.prepare(`ALTER TABLE cf_ips ADD COLUMN status TEXT DEFAULT 'enabled'`).run().catch(() => { });
        await db.prepare(`ALTER TABLE cf_ips ADD COLUMN sync_blacklisted INTEGER DEFAULT 0`).run().catch(() => { });
        await db.prepare(`ALTER TABLE cf_ips ADD COLUMN node_blacklisted INTEGER DEFAULT 0`).run().catch(() => { });
    } catch (e) {
        // 忽略错误
    }

    // 迁移 proxy_ips 中的 socks5 和 http 数据到 outbounds
    try {
        const { results: socks5Data } = await db.prepare("SELECT * FROM proxy_ips WHERE type IN ('socks5', 'http', 'https')").all();
        if (socks5Data && socks5Data.length > 0) {
            for (const item of socks5Data) {
                // 插入到 outbounds
                await db.prepare('INSERT OR IGNORE INTO outbounds (address, type, remark, enabled, sort_order, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
                    .bind(item.address, item.type, item.remark, item.enabled, item.sort_order, item.created_at, item.updated_at).run();
            }
            // 删除已迁移的数据
            await db.prepare("DELETE FROM proxy_ips WHERE type IN ('socks5', 'http', 'https')").run();
        }
    } catch (e) {
        console.error('Migration error:', e);
    }

    // 迁移旧的订阅配置到新表结构
    try {
        // 为旧表添加新列
        await db.prepare(`ALTER TABLE subscribe_config ADD COLUMN type TEXT`).run().catch(() => { });
        await db.prepare(`ALTER TABLE subscribe_config ADD COLUMN token TEXT`).run().catch(() => { });
        await db.prepare(`ALTER TABLE subscribe_config ADD COLUMN remark TEXT`).run().catch(() => { });
        await db.prepare(`ALTER TABLE subscribe_config ADD COLUMN enabled INTEGER DEFAULT 1`).run().catch(() => { });
        await db.prepare(`ALTER TABLE subscribe_config ADD COLUMN sort_order INTEGER DEFAULT 0`).run().catch(() => { });
        await db.prepare(`ALTER TABLE subscribe_config ADD COLUMN include_blacklisted_cfip INTEGER DEFAULT 0`).run().catch(() => { });
        await db.prepare(`ALTER TABLE subscribe_config ADD COLUMN created_at TEXT`).run().catch(() => { });
        await db.prepare(`ALTER TABLE subscribe_config ADD COLUMN path_format TEXT DEFAULT 'default'`).run().catch(() => { });
        await db.prepare(`ALTER TABLE subscribe_config ADD COLUMN compact_global_mode INTEGER DEFAULT 1`).run().catch(() => { });

        // 为所有没有 token 的配置生成 token
        const { results: noTokenConfigs } = await db.prepare('SELECT id FROM subscribe_config WHERE token IS NULL').all();
        if (noTokenConfigs && noTokenConfigs.length > 0) {
            for (const config of noTokenConfigs) {
                const token = generateToken();
                await db.prepare('UPDATE subscribe_config SET token = ? WHERE id = ?').bind(token, config.id).run();
            }
        }
    } catch (e) {
        console.error('Subscribe config migration error:', e);
    }

    try {
        await db.prepare(`ALTER TABLE argo_subscribe ADD COLUMN include_blacklisted_cfip INTEGER DEFAULT 0`).run().catch(() => { });
    } catch (e) {
        // 忽略错误
    }

    try {
        await db.exec(`
            CREATE INDEX IF NOT EXISTS idx_cf_ips_status_speed ON cf_ips(status, speed DESC, sort_order, id);
            CREATE INDEX IF NOT EXISTS idx_cf_ips_status_latency ON cf_ips(status, latency, sort_order, id);
            CREATE INDEX IF NOT EXISTS idx_cf_ips_node_status_speed ON cf_ips(node_blacklisted, status, speed DESC, sort_order, id);
            CREATE INDEX IF NOT EXISTS idx_subscribe_config_token_enabled ON subscribe_config(token, enabled);
        `).catch(() => { });
    } catch (e) {
        // 忽略错误
    }
}

// 生成 32 位随机 token
function generateToken() {
    return crypto.randomUUID().replace(/-/g, '');
}

function json(data, status = 200) {
    return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json', ...CORS } });
}

function parseBooleanFlag(value) {
    if (typeof value === 'string') return value.toLowerCase() === 'true' || value === '1';
    return value === true || value === 1 || value === '1' || value === 'true';
}

function getSyncBlacklistedValue(body, defaultValue = false) {
    if (body.sync_blacklisted !== undefined) return parseBooleanFlag(body.sync_blacklisted) ? 1 : 0;
    if (body.blacklisted !== undefined) return parseBooleanFlag(body.blacklisted) ? 1 : 0;
    return defaultValue ? 1 : 0;
}

function getNodeBlacklistedValue(body, defaultValue = false) {
    if (body.node_blacklisted !== undefined) return parseBooleanFlag(body.node_blacklisted) ? 1 : 0;
    if (body.nodeBlacklisted !== undefined) return parseBooleanFlag(body.nodeBlacklisted) ? 1 : 0;
    return defaultValue ? 1 : 0;
}

function normalizeBlacklistType(value) {
    if (value === undefined || value === null || value === '') return null;

    const type = String(value).trim().toLowerCase();
    if (['1', 'dns', 'sync', 'sync_blacklisted', 'dns_blacklist'].includes(type)) return 'dns';
    if (['2', 'node', 'subscribe', 'node_blacklisted', 'node_blacklist'].includes(type)) return 'node';
    return null;
}

function resolveBlacklistUpdate(body) {
    const blacklistType = normalizeBlacklistType(body.blacklist_type ?? body.blacklistType ?? body.type);
    if (blacklistType === 'dns') {
        const value = body.sync_blacklisted !== undefined || body.blacklisted !== undefined
            ? getSyncBlacklistedValue(body)
            : (body.value !== undefined || body.enabled !== undefined)
                ? (parseBooleanFlag(body.value ?? body.enabled) ? 1 : 0)
                : null;
        if (value === null) return null;
        return { type: 'dns', field: 'sync_blacklisted', value };
    }
    if (blacklistType === 'node') {
        const value = body.node_blacklisted !== undefined || body.nodeBlacklisted !== undefined
            ? getNodeBlacklistedValue(body)
            : (body.value !== undefined || body.enabled !== undefined || body.blacklisted !== undefined)
                ? (parseBooleanFlag(body.value ?? body.enabled ?? body.blacklisted) ? 1 : 0)
                : null;
        if (value === null) return null;
        return { type: 'node', field: 'node_blacklisted', value };
    }

    if (body.node_blacklisted !== undefined || body.nodeBlacklisted !== undefined) {
        return { type: 'node', field: 'node_blacklisted', value: getNodeBlacklistedValue(body) };
    }
    if (body.sync_blacklisted !== undefined || body.blacklisted !== undefined) {
        return { type: 'dns', field: 'sync_blacklisted', value: getSyncBlacklistedValue(body) };
    }

    return null;
}

function getIncludeBlacklistedCfipValue(body, defaultValue = false) {
    if (body.include_blacklisted_cfip !== undefined) return parseBooleanFlag(body.include_blacklisted_cfip) ? 1 : 0;
    if (body.includeBlacklistedCfip !== undefined) return parseBooleanFlag(body.includeBlacklistedCfip) ? 1 : 0;
    return defaultValue ? 1 : 0;
}

function hasIncludeBlacklistedCfipValue(body) {
    return body.include_blacklisted_cfip !== undefined || body.includeBlacklistedCfip !== undefined;
}

async function resolveIncludeBlacklistedCfipValue(db, configId, body) {
    if (hasIncludeBlacklistedCfipValue(body)) return getIncludeBlacklistedCfipValue(body);

    const config = await db.prepare('SELECT include_blacklisted_cfip FROM subscribe_config WHERE id = ?')
        .bind(configId).first();
    return parseBooleanFlag(config?.include_blacklisted_cfip) ? 1 : 0;
}

function getCfipSubscribeCondition(includeBlacklistedCfip) {
    return parseBooleanFlag(includeBlacklistedCfip) ? '1 = 1' : CFIP_SUBSCRIBE_ALLOWED_CONDITION;
}

function getCfipSubscribeConditionFromParams(urlParams, configValue) {
    if (urlParams.has('include_blacklisted_cfip')) {
        return getCfipSubscribeCondition(urlParams.get('include_blacklisted_cfip'));
    }
    if (urlParams.has('includeBlacklistedCfip')) {
        return getCfipSubscribeCondition(urlParams.get('includeBlacklistedCfip'));
    }
    return getCfipSubscribeCondition(configValue);
}

function parsePositiveInteger(value) {
    const numberValue = Number(value);
    if (!Number.isInteger(numberValue) || numberValue <= 0) return null;
    return numberValue;
}

function parseIdList(ids) {
    if (!Array.isArray(ids) || ids.length === 0) return null;

    const parsedIds = [];
    const seen = new Set();
    for (const id of ids) {
        const parsedId = parsePositiveInteger(id);
        if (!parsedId || seen.has(parsedId)) return null;
        parsedIds.push(parsedId);
        seen.add(parsedId);
    }

    return parsedIds;
}

function parseProxyType(addr) {
    if (!addr) return 'unknown';
    if (addr.startsWith('socks')) return 'socks5';
    if (addr.startsWith('http://')) return 'http';
    if (addr.startsWith('https://')) return 'https';
    if (addr.startsWith('[') || addr.includes('::')) return 'ipv6';
    if (/^(\d{1,3}\.){3}\d{1,3}/.test(addr)) return 'ipv4';
    return 'domain';
}

function parseOutboundType(addr) {
    if (!addr) return 'unknown';
    if (addr.startsWith('socks')) return 'socks5';
    if (addr.startsWith('http://') || addr.startsWith('https://')) return 'http';
    return 'unknown';
}

// Parse cfipStatus parameter to get status conditions
// cfipStatus=enabled -> enabled CFIPs only
// cfipStatus=disabled -> disabled CFIPs only
// cfipStatus=invalid -> invalid CFIPs only
// cfipStatus=enabled,disabled -> enabled + disabled
// Returns SQL WHERE conditions array
function parseCfipStatusConditions(cfipStatusParam) {
    const conditions = [];
    if (!cfipStatusParam) {
        // Default: enabled only
        conditions.push("status = 'enabled' OR status IS NULL");
        return conditions;
    }

    const statusList = cfipStatusParam.split(',').map(s => s.trim().toLowerCase());

    for (const status of statusList) {
        switch (status) {
            case 'enabled':
            case '1':
                conditions.push("status = 'enabled' OR status IS NULL");
                break;
            case 'disabled':
            case '0':
                conditions.push("status = 'disabled'");
                break;
            case 'invalid':
            case 'death_reprieve':
            case '2':
                conditions.push("status = 'invalid'");
                break;
        }
    }

    // If no valid statuses, default to enabled
    if (conditions.length === 0) {
        conditions.push("status = 'enabled' OR status IS NULL");
    }

    return conditions;
}

function parseSmartNodeCount(value) {
    if (value === null || value === undefined || value === '') {
        return 0;
    }

    const count = Number.parseInt(value, 10);
    if (!Number.isFinite(count) || count <= 0) {
        return 0;
    }

    return count;
}

function parseSmartNodeCounts(urlParams) {
    return {
        topSpeedCount: parseSmartNodeCount(urlParams.get('speedTop')),
        topLatencyCount: parseSmartNodeCount(urlParams.get('latencyTop')),
        extraCount: parseSmartNodeCount(urlParams.get('extraCount')),
    };
}

function getSmartNodeCfips(cfips) {
    return cfips.filter(cfip => parseProxyType(cfip?.address) !== 'domain');
}

function buildCfipWhereClause(cfipStatusParam, cfipSubscribeCondition) {
    const conditions = parseCfipStatusConditions(cfipStatusParam);
    return `(${conditions.join(' OR ')}) AND ${cfipSubscribeCondition}`;
}

async function queryTopSmartNodeCfips(db, whereClause, orderBy, count, extraCondition = '') {
    const selected = [];
    const chunkSize = Math.max(SMART_NODE_QUERY_CHUNK_SIZE, count * 4);
    let offset = 0;

    while (selected.length < count) {
        const query = `SELECT * FROM cf_ips WHERE ${whereClause}${extraCondition} ORDER BY ${orderBy} LIMIT ? OFFSET ?`;
        const { results = [] } = await db.prepare(query).bind(chunkSize, offset).all();
        if (results.length === 0) break;

        const smartCfips = getSmartNodeCfips(results);
        selected.push(...smartCfips.slice(0, count - selected.length));
        offset += results.length;

        if (results.length < chunkSize) break;
    }

    return selected;
}

async function querySmartNodeCfips(db, whereClause, topSpeedCount, topLatencyCount) {
    const [topSpeedCfips, topLatencyCfips] = await Promise.all([
        topSpeedCount > 0
            ? queryTopSmartNodeCfips(db, whereClause, 'speed DESC, sort_order, id', topSpeedCount)
            : Promise.resolve([]),
        topLatencyCount > 0
            ? queryTopSmartNodeCfips(db, whereClause, 'latency ASC, sort_order, id', topLatencyCount, ' AND latency IS NOT NULL AND latency > 0')
            : Promise.resolve([]),
    ]);

    return { topSpeedCfips, topLatencyCfips };
}

async function resolveSubscribeCfips(db, cfipIds, cfipStatusParam, cfipSubscribeCondition, smartOnly, topSpeedCount, topLatencyCount) {
    let cfips = [];
    let topSpeedCfips = [];
    let topLatencyCfips = [];
    const useSmartOnlyQuery = smartOnly && cfipIds.length === 0;

    if (cfipIds.length > 0) {
        const placeholders = cfipIds.map(() => '?').join(',');
        const { results } = await db.prepare(`SELECT * FROM cf_ips WHERE id IN (${placeholders}) AND ${cfipSubscribeCondition} ORDER BY speed DESC, sort_order, id`).bind(...cfipIds).all();
        cfips = results;
    } else if (useSmartOnlyQuery) {
        const whereClause = buildCfipWhereClause(cfipStatusParam, cfipSubscribeCondition);
        ({ topSpeedCfips, topLatencyCfips } = await querySmartNodeCfips(db, whereClause, topSpeedCount, topLatencyCount));
        cfips = [...topSpeedCfips, ...topLatencyCfips];
    } else {
        const whereClause = buildCfipWhereClause(cfipStatusParam, cfipSubscribeCondition);
        const query = `SELECT * FROM cf_ips WHERE ${whereClause} ORDER BY speed DESC, sort_order, id`;
        const { results } = await db.prepare(query).all();
        cfips = results;
    }

    return { cfips, topSpeedCfips, topLatencyCfips, useSmartOnlyQuery };
}

function resolveSmartCfipGroups(cfips, topSpeedCfips, topLatencyCfips, useSmartOnlyQuery, topSpeedCount, topLatencyCount) {
    if (useSmartOnlyQuery) return { topSpeedCfips, topLatencyCfips };

    const smartNodeCfips = getSmartNodeCfips(cfips);
    return {
        topSpeedCfips: topSpeedCount > 0
            ? [...smartNodeCfips].sort((a, b) => (b.speed || 0) - (a.speed || 0)).slice(0, topSpeedCount)
            : [],
        topLatencyCfips: topLatencyCount > 0
            ? smartNodeCfips.filter(c => c.latency && c.latency > 0)
                .sort((a, b) => a.latency - b.latency).slice(0, topLatencyCount)
            : [],
    };
}

function finalizeSmartSubscriptionLinks(links, smartLinkCount, enableSmartNode, extraCount) {
    if (extraCount === 0 && enableSmartNode) {
        return links.slice(0, smartLinkCount);
    }

    if (extraCount > 0 && enableSmartNode) {
        const actualExtraCount = Math.min(extraCount, links.length - smartLinkCount);
        return links.slice(0, smartLinkCount + actualExtraCount);
    }

    return links;
}

function encodeSubscriptionResponse(links) {
    return new Response(btoa(unescape(encodeURIComponent(links.join('\n')))), {
        headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' }
    });
}

export default {
    async fetch(request, env, ctx) {
        const url = new URL(request.url);
        const path = url.pathname;
        const method = request.method;

        if (method === 'OPTIONS') return new Response(null, { headers: CORS });

        await ensureDB(env.DB);

        // 路由
        // 公开订阅
        if (path.startsWith('/sub/')) {
            const parts = path.split('/');
            if (parts[2] === 'token' && parts[3]) {
                // 通过 token 生成订阅: /sub/token/{token}
                return handleSubscribeByToken(env.DB, parts[3], request.url);
            } else if (parts[2] === 'ss' && parts[3]) {
                // SS 订阅: /sub/ss/password (兼容旧版)
                return handleSSSubscribe(env.DB, parts[3], request.url);
            } else if (parts[2] === 'argo' && parts[3]) {
                // ARGO 订阅: /sub/argo/token
                return handleArgoSubscribe(env.DB, parts[3], request.url);
            } else if (parts[2] === 'clash') {
                // Clash 订阅转换
                return handleClashSubscribe(env.DB, request, env);
            } else if (parts[2]) {
                // V<span>LESS</span> 订阅: /sub/uuid (兼容旧版)
                return handleSubscribe(env.DB, parts[2], request.url);
            }
        }

        // 登录接口（放在静态资源处理之前）
        if (path === '/api/auth/login' && method === 'POST') {
            return handleLogin(request, env);
        }

        // 静态页面由 Pages 自动处理
        if (path === '/' || path === '/index.html' || (!path.startsWith('/api/') && !path.startsWith('/sub/'))) {
            return env.ASSETS.fetch(request);
        }

        // 内部 API - 使用 env.API_KEY 直接验证（供其他 Worker 调用）
        if (path === '/api/internal/cfip' && method === 'GET') {
            const internalKey = request.headers.get('X-Internal-Key') || url.searchParams.get('key');
            if (internalKey === env.API_KEY) {
                return handleGetCFIPs(env.DB, { syncOnly: true });
            }
            return json({ error: 'Invalid Internal Key' }, 401);
        }

        // Telegram优选IP导入 - 使用 env.API_KEY 直接验证
        if (path === '/api/telegram/import-cfip' && method === 'POST') {
            const telegramApiKey = request.headers.get('X-API-Key');
            if (!telegramApiKey || telegramApiKey !== env.API_KEY) {
                return json({ error: 'Invalid API Key' }, 401);
            }
            return handleTelegramImportCFIP(request, env.DB);
        }

        // 需要认证的 API
        const apiKey = request.headers.get('X-API-Key') || url.searchParams.get('apikey');
        if (!apiKey) return json({ error: 'Missing API Key' }, 401);

        const session = await env.DB.prepare('SELECT * FROM sessions WHERE api_key = ? AND expires_at > datetime("now")').bind(apiKey).first();
        if (!session) return json({ error: 'Invalid API Key' }, 401);

        // ProxyIP
        if (path === '/api/proxyip') {
            if (method === 'GET') return handleGetProxyIPs(env.DB);
            if (method === 'POST') return handleAddProxyIP(request, env.DB);
        }
        if (path === '/api/proxyip/batch' && method === 'POST') {
            return handleBatchAddProxyIP(request, env.DB);
        }
        if (path === '/api/proxyip/batch/delete' && method === 'POST') {
            return handleBatchDeleteProxyIP(request, env.DB);
        }
        if (path === '/api/proxyip/batch/enable' && method === 'POST') {
            return handleBatchEnableProxyIP(request, env.DB);
        }
        if (path.startsWith('/api/proxyip/')) {
            const id = path.split('/')[3];
            if (method === 'PUT') return handleUpdateProxyIP(request, env.DB, id);
            if (method === 'DELETE') return handleDeleteProxyIP(env.DB, id);
        }

        // Outbounds
        if (path === '/api/outbound') {
            if (method === 'GET') return handleGetOutbounds(env.DB);
            if (method === 'POST') return handleAddOutbound(request, env.DB);
        }
        if (path === '/api/outbound/batch' && method === 'POST') {
            return handleBatchAddOutbound(request, env.DB);
        }
        if (path === '/api/outbound/batch/delete' && method === 'POST') {
            return handleBatchDeleteOutbound(request, env.DB);
        }
        if (path === '/api/outbound/batch/enable' && method === 'POST') {
            return handleBatchEnableOutbound(request, env.DB);
        }
        if (path.startsWith('/api/outbound/')) {
            const id = path.split('/')[3];
            if (method === 'PUT') return handleUpdateOutbound(request, env.DB, id);
            if (method === 'DELETE') return handleDeleteOutbound(env.DB, id);
        }

        // CFIP
        if (path === '/api/cfip') {
            if (method === 'GET') return handleGetCFIPs(env.DB);
            if (method === 'POST') return handleAddCFIP(request, env.DB);
        }
        if (path === '/api/cfip/batch/blacklist' && method === 'POST') {
            return handleBatchBlacklistCFIP(request, env.DB);
        }
        if (path === '/api/cfip/batch/delete-by-fail-count' && method === 'POST') {
            return handleBatchDeleteCFIPByFailCount(request, env.DB);
        }
        if (path.startsWith('/api/cfip/')) {
            const parts = path.split('/');
            const id = parts[3];
            if (parts[4] === 'blacklist' && method === 'POST') return handleSetCFIPBlacklist(request, env.DB, id);
            if (method === 'PUT') return handleUpdateCFIP(request, env.DB, id);
            if (method === 'DELETE') return handleDeleteCFIP(env.DB, id);
        }
        if (path === '/api/cfip/batch' && method === 'POST') {
            return handleBatchAddCFIP(request, env.DB);
        }
        if (path === '/api/cfip/batch/delete' && method === 'POST') {
            return handleBatchDeleteCFIP(request, env.DB);
        }
        if (path === '/api/cfip/batch/status' && method === 'POST') {
            return handleBatchStatusCFIP(request, env.DB);
        }
        if (path === '/api/cfip/batch/update' && method === 'POST') {
            return handleBatchUpdateCFIP(request, env.DB);
        }

        // ARGO 订阅管理
        if (path === '/api/argo') {
            if (method === 'GET') return handleGetArgoSubscribes(env.DB);
            if (method === 'POST') return handleAddArgoSubscribe(request, env.DB);
        }
        if (path.startsWith('/api/argo/')) {
            const parts = path.split('/');
            const id = parts[3];
            if (parts[4] === 'reset-token' && method === 'POST') {
                return handleResetArgoToken(env.DB, id);
            }
            if (method === 'PUT') return handleUpdateArgoSubscribe(request, env.DB, id);
            if (method === 'DELETE') return handleDeleteArgoSubscribe(env.DB, id);
        }
        if (path === '/api/argo/batch' && method === 'POST') {
            return handleBatchAddArgoSubscribe(request, env.DB);
        }
        if (path === '/api/argo/batch/enable' && method === 'POST') {
            return handleBatchEnableArgoSubscribe(request, env.DB);
        }
        if (path === '/api/argo/batch/delete' && method === 'POST') {
            return handleBatchDeleteArgoSubscribe(request, env.DB);
        }

        // 订阅配置管理
        if (path === '/api/subscribe/config') {
            if (method === 'GET') return handleGetSubscribeConfigs(env.DB, url.searchParams.get('type'));
            if (method === 'POST') return handleAddSubscribeConfig(request, env.DB);
        }
        if (path.startsWith('/api/subscribe/config/')) {
            const parts = path.split('/');
            const id = parts[4];
            if (parts[5] === 'reset-token' && method === 'POST') {
                return handleResetSubscribeToken(env.DB, id);
            }
            if (method === 'PUT') return handleUpdateSubscribeConfig(request, env.DB, id);
            if (method === 'DELETE') return handleDeleteSubscribeConfig(env.DB, id);
        }

        // 订阅生成 - V<span>LESS</span>（兼容旧接口）
        if (path === '/api/subscribe/v' + 'less/config') {
            if (method === 'GET') return handleGetVlConfig(env.DB);
        }
        if (path === '/api/subscribe/v' + 'less/generate') {
            if (method === 'POST') return handleGenerateVlSubscribe(request, env.DB);
        }

        // 订阅生成 - SS（兼容旧接口）
        if (path === '/api/subscribe/ss/config') {
            if (method === 'GET') return handleGetSSConfig(env.DB);
        }
        if (path === '/api/subscribe/ss/generate') {
            if (method === 'POST') return handleGenerateSSSubscribe(request, env.DB);
        }

        // SOCKS5 测速
        if (path === '/api/test-socks5' && method === 'POST') {
            return handleTestSocks5(request, env.DB);
        }

        // 出站测速
        if (path === '/api/test-outbound' && method === 'POST') {
            return handleTestOutbound(request, env.DB);
        }

        // 出站检测
        if (path === '/api/check-exit' && method === 'POST') {
            return handleCheckExit(request, env.DB);
        }

        return json({ error: 'Not Found' }, 404);
    }
};

// 登录
async function handleLogin(request, env) {
    const { apiKey } = await request.json();
    if (apiKey !== env.API_KEY) return json({ error: 'Invalid API Key' }, 401);

    const token = crypto.randomUUID();
    const expires = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();
    await env.DB.prepare('INSERT INTO sessions (api_key, expires_at, created_at) VALUES (?, ?, datetime("now"))').bind(token, expires).run();

    return json({ success: true, apiKey: token, expiresAt: expires });
}

// ProxyIP CRUD
async function handleGetProxyIPs(db) {
    const { results } = await db.prepare('SELECT * FROM proxy_ips ORDER BY sort_order, id').all();
    return json({ success: true, data: results });
}

async function handleAddProxyIP(request, db) {
    const { address, remark, enabled = true, sort_order = 0 } = await request.json();
    if (!address) return json({ error: '地址不能为空' }, 400);

    const type = parseProxyType(address);
    // ProxyIP 不允许 socks5 和 http 类型
    if (type === 'socks5' || type === 'http' || type === 'https') {
        return json({ error: 'SOCKS5/HTTP 代理请添加到全局出站' }, 400);
    }

    const max = await db.prepare('SELECT MAX(id) as m FROM proxy_ips').first();
    const finalRemark = remark || `ProxyIP-${(max?.m || 0) + 1}`;

    const r = await db.prepare('INSERT INTO proxy_ips (address, type, remark, enabled, sort_order, created_at, updated_at) VALUES (?, ?, ?, ?, ?, datetime("now"), datetime("now"))')
        .bind(address, type, finalRemark, enabled ? 1 : 0, sort_order).run();

    return json({ success: true, data: { id: r.meta.last_row_id, address, type, remark: finalRemark } });
}

async function handleUpdateProxyIP(request, db, id) {
    const body = await request.json();
    const sets = [], vals = [];
    if (body.address !== undefined) {
        const type = parseProxyType(body.address);
        if (type === 'socks5' || type === 'http' || type === 'https') {
            return json({ error: 'SOCKS5/HTTP 代理请添加到全局出站' }, 400);
        }
        sets.push('address = ?', 'type = ?');
        vals.push(body.address, type);
    }
    if (body.remark !== undefined) { sets.push('remark = ?'); vals.push(body.remark); }
    if (body.enabled !== undefined) { sets.push('enabled = ?'); vals.push(body.enabled ? 1 : 0); }
    if (body.sort_order !== undefined) { sets.push('sort_order = ?'); vals.push(body.sort_order); }
    if (sets.length === 0) return json({ error: '没有要更新的字段' }, 400);

    sets.push('updated_at = datetime("now")');
    vals.push(id);
    await db.prepare(`UPDATE proxy_ips SET ${sets.join(', ')} WHERE id = ?`).bind(...vals).run();
    return json({ success: true });
}

async function handleDeleteProxyIP(db, id) {
    await db.prepare('DELETE FROM proxy_ips WHERE id = ?').bind(id).run();
    return json({ success: true });
}

async function handleBatchDeleteProxyIP(request, db) {
    const { ids } = await request.json();
    if (!Array.isArray(ids) || ids.length === 0) return json({ error: 'IDs不能为空' }, 400);

    const placeholders = ids.map(() => '?').join(',');
    await db.prepare(`DELETE FROM proxy_ips WHERE id IN (${placeholders})`).bind(...ids).run();
    return json({ success: true });
}

async function handleBatchEnableProxyIP(request, db) {
    const { ids, enabled } = await request.json();
    if (!Array.isArray(ids) || ids.length === 0) return json({ error: 'IDs不能为空' }, 400);

    const placeholders = ids.map(() => '?').join(',');
    await db.prepare(`UPDATE proxy_ips SET enabled = ?, updated_at = datetime("now") WHERE id IN (${placeholders})`).bind(enabled ? 1 : 0, ...ids).run();
    return json({ success: true });
}

async function handleBatchAddProxyIP(request, db) {
    const items = await request.json();
    if (!Array.isArray(items) || items.length === 0) {
        return json({ error: '数据不能为空且必须是数组' }, 400);
    }

    const max = await db.prepare('SELECT MAX(id) as m FROM proxy_ips').first();
    let nextId = (max?.m || 0) + 1;

    let successCount = 0;
    let failCount = 0;
    const errors = [];
    const BATCH_SIZE = 50;

    for (let i = 0; i < items.length; i += BATCH_SIZE) {
        const chunk = items.slice(i, i + BATCH_SIZE);
        const statements = [];

        for (const item of chunk) {
            if (!item.address) {
                failCount++;
                errors.push(`Item ${i + statements.length + 1}: Address missing`);
                continue;
            }

            const address = item.address;
            const type = parseProxyType(address);
            if (type === 'socks5' || type === 'http' || type === 'https') {
                failCount++;
                errors.push(`Item: ${address} - SOCKS5/HTTP 请添加到全局出站`);
                continue;
            }

            const remark = item.remark || `ProxyIP-${nextId++}`;
            const enabled = item.enabled !== undefined ? (item.enabled ? 1 : 0) : 1;
            const sort_order = item.sort_order || 0;

            statements.push(
                db.prepare('INSERT INTO proxy_ips (address, type, remark, enabled, sort_order, created_at, updated_at) VALUES (?, ?, ?, ?, ?, datetime("now"), datetime("now"))')
                    .bind(address, type, remark, enabled, sort_order)
            );
        }

        if (statements.length > 0) {
            try {
                const results = await db.batch(statements);
                successCount += results.length;
            } catch (e) {
                console.error('Batch insert error:', e);
                failCount += statements.length;
                errors.push(`Batch ${Math.floor(i / BATCH_SIZE) + 1} failed: ${e.message}`);
            }
        }
    }

    return json({
        success: true,
        message: `成功添加 ${successCount} 条，失败 ${failCount} 条`,
        data: { success: successCount, failed: failCount, errors }
    });
}

// Outbound CRUD
async function handleGetOutbounds(db) {
    const { results } = await db.prepare('SELECT * FROM outbounds ORDER BY sort_order, id').all();
    return json({ success: true, data: results });
}

async function handleAddOutbound(request, db) {
    const { address, remark, enabled = true, sort_order = 0 } = await request.json();
    if (!address) return json({ error: '地址不能为空' }, 400);

    const type = parseOutboundType(address);
    if (type === 'unknown') {
        return json({ error: '地址格式错误，必须是 socks5:// 或 http:// 开头' }, 400);
    }

    const max = await db.prepare('SELECT MAX(id) as m FROM outbounds').first();
    const finalRemark = remark || `Outbound-${(max?.m || 0) + 1}`;

    const r = await db.prepare('INSERT INTO outbounds (address, type, remark, enabled, sort_order, created_at, updated_at) VALUES (?, ?, ?, ?, ?, datetime("now"), datetime("now"))')
        .bind(address, type, finalRemark, enabled ? 1 : 0, sort_order).run();

    return json({ success: true, data: { id: r.meta.last_row_id, address, type, remark: finalRemark } });
}

async function handleUpdateOutbound(request, db, id) {
    const body = await request.json();
    const sets = [], vals = [];
    if (body.address !== undefined) {
        const type = parseOutboundType(body.address);
        if (type === 'unknown') return json({ error: '地址格式错误，必须是 socks5:// 或 http:// 开头' }, 400);
        sets.push('address = ?', 'type = ?');
        vals.push(body.address, type);
    }
    if (body.remark !== undefined) { sets.push('remark = ?'); vals.push(body.remark); }
    if (body.enabled !== undefined) { sets.push('enabled = ?'); vals.push(body.enabled ? 1 : 0); }
    if (body.sort_order !== undefined) { sets.push('sort_order = ?'); vals.push(body.sort_order); }
    if (sets.length === 0) return json({ error: '没有要更新的字段' }, 400);

    sets.push('updated_at = datetime("now")');
    vals.push(id);
    await db.prepare(`UPDATE outbounds SET ${sets.join(', ')} WHERE id = ?`).bind(...vals).run();
    return json({ success: true });
}

async function handleDeleteOutbound(db, id) {
    await db.prepare('DELETE FROM outbounds WHERE id = ?').bind(id).run();
    return json({ success: true });
}

async function handleBatchDeleteOutbound(request, db) {
    const { ids } = await request.json();
    if (!Array.isArray(ids) || ids.length === 0) return json({ error: 'IDs不能为空' }, 400);

    const placeholders = ids.map(() => '?').join(',');
    await db.prepare(`DELETE FROM outbounds WHERE id IN (${placeholders})`).bind(...ids).run();
    return json({ success: true });
}

async function handleBatchEnableOutbound(request, db) {
    const { ids, enabled } = await request.json();
    if (!Array.isArray(ids) || ids.length === 0) return json({ error: 'IDs不能为空' }, 400);

    const placeholders = ids.map(() => '?').join(',');
    await db.prepare(`UPDATE outbounds SET enabled = ?, updated_at = datetime("now") WHERE id IN (${placeholders})`).bind(enabled ? 1 : 0, ...ids).run();
    return json({ success: true });
}

async function handleBatchAddOutbound(request, db) {
    const items = await request.json();
    if (!Array.isArray(items) || items.length === 0) {
        return json({ error: '数据不能为空且必须是数组' }, 400);
    }

    const max = await db.prepare('SELECT MAX(id) as m FROM outbounds').first();
    let nextId = (max?.m || 0) + 1;

    let successCount = 0;
    let failCount = 0;
    const errors = [];
    const BATCH_SIZE = 50;

    for (let i = 0; i < items.length; i += BATCH_SIZE) {
        const chunk = items.slice(i, i + BATCH_SIZE);
        const statements = [];

        for (const item of chunk) {
            if (!item.address) {
                failCount++;
                errors.push(`Item ${i + statements.length + 1}: Address missing`);
                continue;
            }

            const address = item.address;
            const type = parseOutboundType(address);
            if (type === 'unknown') {
                failCount++;
                errors.push(`Item: ${address} - 地址格式错误`);
                continue;
            }

            const remark = item.remark || `Outbound-${nextId++}`;
            const enabled = item.enabled !== undefined ? (item.enabled ? 1 : 0) : 1;
            const sort_order = item.sort_order || 0;

            statements.push(
                db.prepare('INSERT INTO outbounds (address, type, remark, enabled, sort_order, created_at, updated_at) VALUES (?, ?, ?, ?, ?, datetime("now"), datetime("now"))')
                    .bind(address, type, remark, enabled, sort_order)
            );
        }

        if (statements.length > 0) {
            try {
                const results = await db.batch(statements);
                successCount += results.length;
            } catch (e) {
                console.error('Batch insert error:', e);
                failCount += statements.length;
                errors.push(`Batch ${Math.floor(i / BATCH_SIZE) + 1} failed: ${e.message}`);
            }
        }
    }

    return json({
        success: true,
        message: `成功添加 ${successCount} 条，失败 ${failCount} 条`,
        data: { success: successCount, failed: failCount, errors }
    });
}

// CFIP CRUD
async function handleGetCFIPs(db, options = {}) {
    const where = options.syncOnly ? `WHERE ${CFIP_SYNC_ALLOWED_CONDITION}` : '';
    const { results } = await db.prepare(`SELECT * FROM cf_ips ${where} ORDER BY sort_order, id`).all();
    return json({ success: true, data: results });
}

async function handleAddCFIP(request, db) {
    const body = await request.json();
    const { address, port = 443, remark, name, sort_order = 0, latency, speed, country, isp, fail_count = 0, status = 'enabled' } = body;
    const syncBlacklisted = getSyncBlacklistedValue(body);
    const nodeBlacklisted = getNodeBlacklistedValue(body);
    if (!address) return json({ error: '地址不能为空' }, 400);

    const max = await db.prepare('SELECT MAX(id) as m FROM cf_ips').first();
    const finalRemark = remark || `CFIP-${(max?.m || 0) + 1}`;

    const r = await db.prepare('INSERT INTO cf_ips (address, port, remark, name, sort_order, latency, speed, country, isp, fail_count, status, sync_blacklisted, node_blacklisted, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime("now"), datetime("now"))')
        .bind(address, port, finalRemark, name || null, sort_order, latency || null, speed || null, country || null, isp || null, fail_count, status, syncBlacklisted, nodeBlacklisted).run();

    return json({
        success: true,
        data: {
            id: r.meta.last_row_id,
            address,
            port,
            remark: finalRemark,
            name,
            latency,
            speed,
            country,
            isp,
            fail_count,
            status,
            sync_blacklisted: syncBlacklisted,
            node_blacklisted: nodeBlacklisted
        }
    });
}

async function handleBatchAddCFIP(request, db) {
    const items = await request.json();
    if (!Array.isArray(items) || items.length === 0) {
        return json({ error: '数据不能为空且必须是数组' }, 400);
    }

    // Get current max ID for remark generation
    const max = await db.prepare('SELECT MAX(id) as m FROM cf_ips').first();
    let nextId = (max?.m || 0) + 1;

    let successCount = 0;
    let failCount = 0;
    const errors = [];

    // Cloudflare D1 supports batch execution which is faster than sequential awaits
    // However, D1 batch size is limited (around 100 statements usually safe)
    // We will process in chunks of 50 to be safe and efficient
    const BATCH_SIZE = 50;

    for (let i = 0; i < items.length; i += BATCH_SIZE) {
        const chunk = items.slice(i, i + BATCH_SIZE);
        const statements = [];

        for (const item of chunk) {
            // Validate item
            if (!item.address) {
                failCount++;
                errors.push(`Item ${i + statements.length + 1}: Address missing`);
                continue;
            }

            const address = item.address;
            const port = item.port || 443;
            // Remark logic: use provided remark, or generated one
            // Note: If we use batch, we can't easily get the ID of each inserted row to generate "CFIP-ID" 
            // strictly sequential if we depend on auto-increment for the ID part in the name *before* insertion.
            // But we can approximate using nextId counter.
            const remark = item.remark || `CFIP-${nextId++}`;

            const name = item.name || null;
            const sort_order = item.sort_order || 0;
            const latency = item.latency || null;
            const speed = item.speed || null;
            const country = item.country || null;
            const isp = item.isp || null;
            const fail_count = item.fail_count || 0;
            const status = item.status || 'enabled';
            const sync_blacklisted = getSyncBlacklistedValue(item);
            const node_blacklisted = getNodeBlacklistedValue(item);

            statements.push(
                db.prepare('INSERT INTO cf_ips (address, port, remark, name, sort_order, latency, speed, country, isp, fail_count, status, sync_blacklisted, node_blacklisted, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime("now"), datetime("now"))')
                    .bind(address, port, remark, name, sort_order, latency, speed, country, isp, fail_count, status, sync_blacklisted, node_blacklisted)
            );
        }

        if (statements.length > 0) {
            try {
                // Execute batch
                const results = await db.batch(statements);
                // results is an array of result objects
                successCount += results.length;
            } catch (e) {
                // If batch fails, we could try fallback or just count as fail
                // For simplicity, if a batch fails, we assume all in that batch failed or there was a constraint error
                console.error('Batch insert error:', e);
                failCount += statements.length;
                errors.push(`Batch ${i / BATCH_SIZE + 1} failed: ${e.message}`);
            }
        }
    }

    return json({
        success: true,
        message: `成功添加 ${successCount} 条，失败 ${failCount} 条`,
        data: { success: successCount, failed: failCount, errors }
    });
}

async function handleUpdateCFIP(request, db, id) {
    const body = await request.json();
    const sets = [], vals = [];
    if (body.address !== undefined) { sets.push('address = ?'); vals.push(body.address); }
    if (body.port !== undefined) { sets.push('port = ?'); vals.push(body.port); }
    if (body.remark !== undefined) { sets.push('remark = ?'); vals.push(body.remark); }
    if (body.name !== undefined) { sets.push('name = ?'); vals.push(body.name); }
    // enabled field has been removed, only use status field
    if (body.sort_order !== undefined) { sets.push('sort_order = ?'); vals.push(body.sort_order); }
    if (body.latency !== undefined) { sets.push('latency = ?'); vals.push(body.latency); }
    if (body.speed !== undefined) { sets.push('speed = ?'); vals.push(body.speed); }
    if (body.country !== undefined) { sets.push('country = ?'); vals.push(body.country); }
    if (body.isp !== undefined) { sets.push('isp = ?'); vals.push(body.isp); }
    if (body.fail_count !== undefined) { sets.push('fail_count = ?'); vals.push(body.fail_count); }
    if (body.status !== undefined) { sets.push('status = ?'); vals.push(body.status); }
    if (body.sync_blacklisted !== undefined || body.blacklisted !== undefined) { sets.push('sync_blacklisted = ?'); vals.push(getSyncBlacklistedValue(body)); }
    if (body.node_blacklisted !== undefined || body.nodeBlacklisted !== undefined) { sets.push('node_blacklisted = ?'); vals.push(getNodeBlacklistedValue(body)); }
    if (sets.length === 0) return json({ error: '没有要更新的字段' }, 400);

    sets.push('updated_at = datetime("now")');
    vals.push(id);
    await db.prepare(`UPDATE cf_ips SET ${sets.join(', ')} WHERE id = ?`).bind(...vals).run();
    return json({ success: true });
}

async function handleDeleteCFIP(db, id) {
    await db.prepare('DELETE FROM cf_ips WHERE id = ?').bind(id).run();
    return json({ success: true });
}

async function handleBatchDeleteCFIP(request, db) {
    const { ids } = await request.json();
    if (!Array.isArray(ids) || ids.length === 0) return json({ error: 'IDs不能为空' }, 400);

    const placeholders = ids.map(() => '?').join(',');
    await db.prepare(`DELETE FROM cf_ips WHERE id IN (${placeholders})`).bind(...ids).run();
    return json({ success: true });
}

async function handleBatchDeleteCFIPByFailCount(request, db) {
    const body = await request.json();
    const failCount = parsePositiveInteger(body.fail_count ?? body.failCount ?? body.min_fail_count ?? body.threshold);
    if (!failCount) return json({ error: '失败次数阈值必须是正整数' }, 400);

    const result = await db.prepare('DELETE FROM cf_ips WHERE COALESCE(fail_count, 0) >= ?')
        .bind(failCount).run();
    return json({
        success: true,
        data: {
            fail_count: failCount,
            changes: result.meta?.changes ?? 0
        }
    });
}

async function handleBatchStatusCFIP(request, db) {
    const { ids, status } = await request.json();
    if (!Array.isArray(ids) || ids.length === 0) return json({ error: 'IDs不能为空' }, 400);
    if (!status || !['enabled', 'disabled', 'invalid'].includes(status)) {
        return json({ error: '状态值无效' }, 400);
    }

    const placeholders = ids.map(() => '?').join(',');
    await db.prepare(`UPDATE cf_ips SET status = ?, updated_at = datetime("now") WHERE id IN (${placeholders})`).bind(status, ...ids).run();
    return json({ success: true });
}

async function handleSetCFIPBlacklist(request, db, id) {
    const cfipId = parsePositiveInteger(id);
    if (!cfipId) return json({ error: 'ID无效' }, 400);

    const body = await request.json();
    const blacklistUpdate = resolveBlacklistUpdate(body);
    if (!blacklistUpdate) {
        return json({ error: '黑名单类型或值不能为空' }, 400);
    }

    const result = await db.prepare(`UPDATE cf_ips SET ${blacklistUpdate.field} = ?, updated_at = datetime("now") WHERE id = ?`)
        .bind(blacklistUpdate.value, cfipId).run();
    return json({
        success: true,
        data: {
            id: cfipId,
            blacklist_type: blacklistUpdate.type,
            [blacklistUpdate.field]: blacklistUpdate.value,
            changes: result.meta?.changes ?? 0
        }
    });
}

async function handleBatchBlacklistCFIP(request, db) {
    const body = await request.json();
    const ids = parseIdList(body.ids);
    if (!ids) return json({ error: 'IDs必须是非重复的正整数数组' }, 400);
    const blacklistUpdate = resolveBlacklistUpdate(body);
    if (!blacklistUpdate) {
        return json({ error: '黑名单类型或值不能为空' }, 400);
    }

    const placeholders = ids.map(() => '?').join(',');
    const result = await db.prepare(`UPDATE cf_ips SET ${blacklistUpdate.field} = ?, updated_at = datetime("now") WHERE id IN (${placeholders})`)
        .bind(blacklistUpdate.value, ...ids).run();
    return json({
        success: true,
        data: {
            requested: ids.length,
            changes: result.meta?.changes ?? 0,
            blacklist_type: blacklistUpdate.type,
            [blacklistUpdate.field]: blacklistUpdate.value
        }
    });
}

async function handleBatchUpdateCFIP(request, db) {
    const { items } = await request.json();
    if (!Array.isArray(items) || items.length === 0) {
        return json({ error: '数据不能为空且必须是数组' }, 400);
    }

    let successCount = 0;
    let failCount = 0;
    const errors = [];
    const BATCH_SIZE = 50;
    const allowedFields = ['name', 'latency', 'speed', 'country', 'isp', 'fail_count', 'status', 'remark', 'address', 'port', 'sort_order'];

    for (let i = 0; i < items.length; i += BATCH_SIZE) {
        const chunk = items.slice(i, i + BATCH_SIZE);
        const statements = [];

        for (const item of chunk) {
            if (!item.id) {
                failCount++;
                errors.push(`Item missing id`);
                continue;
            }

            const sets = [];
            const vals = [];
            for (const field of allowedFields) {
                if (item[field] !== undefined) {
                    sets.push(`${field} = ?`);
                    vals.push(item[field]);
                }
            }
            if (item.sync_blacklisted !== undefined || item.blacklisted !== undefined) {
                sets.push('sync_blacklisted = ?');
                vals.push(getSyncBlacklistedValue(item));
            }
            if (item.node_blacklisted !== undefined || item.nodeBlacklisted !== undefined) {
                sets.push('node_blacklisted = ?');
                vals.push(getNodeBlacklistedValue(item));
            }

            if (sets.length === 0) {
                failCount++;
                errors.push(`Item ${item.id}: no fields to update`);
                continue;
            }

            sets.push('updated_at = datetime("now")');
            vals.push(item.id);
            statements.push(
                db.prepare(`UPDATE cf_ips SET ${sets.join(', ')} WHERE id = ?`).bind(...vals)
            );
        }

        if (statements.length > 0) {
            try {
                await db.batch(statements);
                successCount += statements.length;
            } catch (e) {
                console.error('Batch update error:', e);
                failCount += statements.length;
                errors.push(`Batch ${Math.floor(i / BATCH_SIZE) + 1} failed: ${e.message}`);
            }
        }
    }

    return json({
        success: true,
        message: `成功更新 ${successCount} 条，失败 ${failCount} 条`,
        data: { success: successCount, failed: failCount, errors }
    });
}

// ARGO 订阅管理
async function handleGetArgoSubscribes(db) {
    const { results } = await db.prepare('SELECT * FROM argo_subscribe ORDER BY sort_order, id').all();
    return json({ success: true, data: results });
}

async function handleAddArgoSubscribe(request, db) {
    const body = await request.json();
    const { template_link, remark, enabled = 1, sort_order = 0 } = body;
    const includeBlacklistedCfip = getIncludeBlacklistedCfipValue(body);
    if (!template_link) return json({ error: '模板链接不能为空' }, 400);

    // 生成随机token
    const token = generateRandomToken(32);

    const r = await db.prepare(
        'INSERT INTO argo_subscribe (token, template_link, remark, enabled, sort_order, include_blacklisted_cfip, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, datetime("now"), datetime("now"))'
    ).bind(token, template_link, remark, enabled, sort_order, includeBlacklistedCfip).run();

    return json({ success: true, id: r.meta.last_row_id, token });
}

async function handleUpdateArgoSubscribe(request, db, id) {
    const body = await request.json();
    const sets = [], vals = [];

    if (body.template_link !== undefined) { sets.push('template_link = ?'); vals.push(body.template_link); }
    if (body.remark !== undefined) { sets.push('remark = ?'); vals.push(body.remark); }
    if (body.enabled !== undefined) { sets.push('enabled = ?'); vals.push(body.enabled); }
    if (body.sort_order !== undefined) { sets.push('sort_order = ?'); vals.push(body.sort_order); }
    if (body.include_blacklisted_cfip !== undefined || body.includeBlacklistedCfip !== undefined) { sets.push('include_blacklisted_cfip = ?'); vals.push(getIncludeBlacklistedCfipValue(body)); }

    if (sets.length === 0) return json({ error: '没有要更新的字段' }, 400);

    sets.push('updated_at = datetime("now")');
    vals.push(id);

    await db.prepare(`UPDATE argo_subscribe SET ${sets.join(', ')} WHERE id = ?`).bind(...vals).run();
    return json({ success: true });
}

async function handleDeleteArgoSubscribe(db, id) {
    await db.prepare('DELETE FROM argo_subscribe WHERE id = ?').bind(id).run();
    return json({ success: true });
}

async function handleBatchEnableArgoSubscribe(request, db) {
    const { ids, enabled } = await request.json();
    if (!Array.isArray(ids) || ids.length === 0) return json({ error: 'IDs不能为空' }, 400);

    const placeholders = ids.map(() => '?').join(',');
    await db.prepare(`UPDATE argo_subscribe SET enabled = ?, updated_at = datetime("now") WHERE id IN (${placeholders})`).bind(enabled, ...ids).run();
    return json({ success: true });
}

async function handleBatchDeleteArgoSubscribe(request, db) {
    const { ids } = await request.json();
    if (!Array.isArray(ids) || ids.length === 0) return json({ error: 'IDs不能为空' }, 400);

    const placeholders = ids.map(() => '?').join(',');
    await db.prepare(`DELETE FROM argo_subscribe WHERE id IN (${placeholders})`).bind(...ids).run();
    return json({ success: true });
}

async function handleBatchAddArgoSubscribe(request, db) {
    const items = await request.json();
    if (!Array.isArray(items) || items.length === 0) {
        return json({ error: '数据不能为空且必须是数组' }, 400);
    }

    let successCount = 0;
    let failCount = 0;
    const errors = [];
    const BATCH_SIZE = 50;

    for (let i = 0; i < items.length; i += BATCH_SIZE) {
        const chunk = items.slice(i, i + BATCH_SIZE);
        const statements = [];

        for (const item of chunk) {
            if (!item.template_link) {
                failCount++;
                errors.push(`Item ${i + statements.length + 1}: Template link missing`);
                continue;
            }

            const template_link = item.template_link;
            const token = generateRandomToken(32);
            const remark = item.remark || '';
            const enabled = item.enabled !== undefined ? item.enabled : 1;
            const sort_order = item.sort_order || 0;
            const include_blacklisted_cfip = getIncludeBlacklistedCfipValue(item);

            statements.push(
                db.prepare('INSERT INTO argo_subscribe (token, template_link, remark, enabled, sort_order, include_blacklisted_cfip, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, datetime("now"), datetime("now"))')
                    .bind(token, template_link, remark, enabled, sort_order, include_blacklisted_cfip)
            );
        }

        if (statements.length > 0) {
            try {
                const results = await db.batch(statements);
                successCount += results.length;
            } catch (e) {
                console.error('Batch insert error:', e);
                failCount += statements.length;
                errors.push(`Batch ${Math.floor(i / BATCH_SIZE) + 1} failed: ${e.message}`);
            }
        }
    }

    return json({
        success: true,
        message: `成功添加 ${successCount} 条，失败 ${failCount} 条`,
        data: { success: successCount, failed: failCount, errors }
    });
}

async function handleResetArgoToken(db, id) {
    const newToken = generateRandomToken(32);
    await db.prepare('UPDATE argo_subscribe SET token = ?, updated_at = datetime("now") WHERE id = ?').bind(newToken, id).run();
    return json({ success: true, data: { token: newToken } });
}

// ARGO 订阅生成
async function handleArgoSubscribe(db, token, url) {
    // 1. 获取该token对应的模板
    const template = await db.prepare(
        'SELECT * FROM argo_subscribe WHERE token = ? AND enabled = 1'
    ).bind(token).first();

    if (!template) {
        return new Response('Subscription not found', { status: 404 });
    }

    // 解析URL参数中的 cfipStatus (支持旧的 status 参数作为后备)
    const urlParams = new URL(url).searchParams;
    const cfipIds = urlParams.get('cfip')?.split(',').filter(id => id.trim()) || [];
    const { topSpeedCount, topLatencyCount, extraCount } = parseSmartNodeCounts(urlParams);
    const enableSmartNode = topSpeedCount > 0 || topLatencyCount > 0;
    const smartOnly = enableSmartNode && extraCount === 0;
    const cfipStatusParam = urlParams.get('cfipStatus') || urlParams.get('status');

    const cfipSubscribeCondition = getCfipSubscribeConditionFromParams(urlParams, template.include_blacklisted_cfip);
    let { cfips, topSpeedCfips, topLatencyCfips, useSmartOnlyQuery } = await resolveSubscribeCfips(
        db,
        cfipIds,
        cfipStatusParam,
        cfipSubscribeCondition,
        smartOnly,
        topSpeedCount,
        topLatencyCount
    );

    if (!cfips || cfips.length === 0) {
        return new Response('No enabled CFIP found', { status: 404 });
    }

    // 3. 解析模板并替换优选域名/IP
    try {
        const links = generateArgoVlLinks(template.template_link, smartOnly ? [] : cfips);
        let smartLinkCount = 0;

        if (enableSmartNode) {
            ({ topSpeedCfips, topLatencyCfips } = resolveSmartCfipGroups(
                cfips,
                topSpeedCfips,
                topLatencyCfips,
                useSmartOnlyQuery,
                topSpeedCount,
                topLatencyCount
            ));

            const speedLinks = generateArgoVlLinks(
                template.template_link,
                topSpeedCfips,
                (_cfip, index, originalRemark) => `最大速度${index + 1}-${originalRemark || 'ARGO'}`
            );
            const latencyLinks = generateArgoVlLinks(
                template.template_link,
                topLatencyCfips,
                (_cfip, index, originalRemark) => `最低延迟${index + 1}-${originalRemark || 'ARGO'}`
            );
            const smartLinks = [...speedLinks, ...latencyLinks];
            smartLinkCount = smartLinks.length;
            links.unshift(...smartLinks);
        }

        return encodeSubscriptionResponse(finalizeSmartSubscriptionLinks(links, smartLinkCount, enableSmartNode, extraCount));
    } catch (error) {
        return new Response(`Error: ${error.message}`, { status: 500 });
    }
}

function buildArgoNodeRemark(originalRemark, cfip, index, remarkBuilder) {
    if (remarkBuilder) return remarkBuilder(cfip, index, originalRemark);
    return `${originalRemark}-${cfip.name || cfip.remark || cfip.address}`;
}

function generateArgoVlLinks(templateLink, cfips, remarkBuilder = null) {
    const links = [];

    // 判断是V<span>LESS</span>还是V<span>Mess</span>格式
    if (templateLink.startsWith('v' + 'less://')) {
        // V<span>LESS</span>格式处理
        const vlLength = 8; // 'v'+'less://'.length
        const vlRegex = new RegExp(`^v${'less'}://([^@]+)@([^:]+):(\\d+)(\\?[^#]*)?(#.*)?$`);
        const match = templateLink.match(vlRegex);

        if (!match) {
            throw new Error('Invalid V<span>LESS</span> template format');
        }

        const [, uuid, , , queryString, fragment] = match;
        const originalRemark = fragment ? decodeURIComponent(fragment.substring(1)) : '';

        // 为每个启用的CFIP生成节点
        for (const [index, cfip] of cfips.entries()) {
            let host = cfip.address;
            const port = cfip.port || 443;

            // 处理IPv6地址
            if (host.includes(':') && !host.startsWith('[')) {
                host = `[${host}]`;
            }

            // 构建新的V<span>LESS</span>链接（替换host:port）
            const newRemark = buildArgoNodeRemark(originalRemark, cfip, index, remarkBuilder);
            const vlLink = `v${'less'}://${uuid}@${host}:${port}${queryString || ''}#${encodeURIComponent(newRemark)}`;

            links.push(vlLink);
        }
    } else if (templateLink.startsWith('vm' + 'ess://')) {
        // V<span>Mess</span>格式处理
        try {
            // 解码base64
            const base64Data = templateLink.substring(8); // 去掉 "vm" + "ess://"
            const jsonStr = decodeURIComponent(escape(atob(base64Data)));
            const vmConfig = JSON.parse(jsonStr);

            const originalRemark = vmConfig.ps || '';

            // 为每个启用的CFIP生成节点
            for (const [index, cfip] of cfips.entries()) {
                // 复制配置对象
                const newConfig = { ...vmConfig };

                // 替换地址和端口
                newConfig.add = cfip.address;
                newConfig.port = String(cfip.port || 443);

                // 更新备注
                newConfig.ps = buildArgoNodeRemark(originalRemark, cfip, index, remarkBuilder);

                // 重新编码为base64
                const newJsonStr = JSON.stringify(newConfig);
                const newBase64 = btoa(unescape(encodeURIComponent(newJsonStr)));
                const vmLink = 'vm' + 'ess://' + newBase64;

                links.push(vmLink);
            }
        } catch (error) {
            throw new Error('Invalid VM template format: ' + error.message);
        }
    } else {
        throw new Error('Unsupported protocol. Only vl' + 'ess:// and vm' + 'ess:// are supported');
    }

    return links;
}

function generateRandomToken(length = 16) {
    const chars = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
    let token = '';
    for (let i = 0; i < length; i++) {
        token += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    return token;
}

// 订阅
// 订阅配置 CRUD
async function handleGetSubscribeConfigs(db, type) {
    let query = 'SELECT * FROM subscribe_config';
    const params = [];

    if (type) {
        query += ' WHERE type = ?';
        params.push(type);
    }

    query += ' ORDER BY sort_order, id';

    const { results } = await db.prepare(query).bind(...params).all();
    return json({ success: true, data: results });
}

async function handleAddSubscribeConfig(request, db) {
    const body = await request.json();
    const { type, uuid, snippetsDomain, proxyPath, remark, enabled = true, sort_order = 0, pathFormat = 'default', compactGlobalMode = 1 } = body;
    const includeBlacklistedCfip = getIncludeBlacklistedCfipValue(body);

    if (!type || !uuid || !snippetsDomain) {
        return json({ error: '类型、UUID/密码和域名不能为空' }, 400);
    }

    if (type !== 'vl' + 'ess' && type !== 'ss') {
        return json({ error: '类型必须是 v' + 'less 或 ss' }, 400);
    }

    const domain = snippetsDomain.replace(/^https?:\/\//, '').replace(/\/$/, '');
    const finalPath = proxyPath || (type === 'ss' ? `/${uuid}` : '/?ed=2560');

    const max = await db.prepare('SELECT MAX(id) as m FROM subscribe_config').first();
    const finalRemark = remark || `${type.toUpperCase()}订阅-${(max?.m || 0) + 1}`;

    // 生成随机 token (32位)
    const token = generateToken();

    const r = await db.prepare(
        'INSERT INTO subscribe_config (type, token, uuid, snippets_domain, proxy_path, remark, enabled, sort_order, include_blacklisted_cfip, path_format, compact_global_mode, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime("now"), datetime("now"))'
    ).bind(type, token, uuid, domain, finalPath, finalRemark, enabled ? 1 : 0, sort_order, includeBlacklistedCfip, pathFormat, compactGlobalMode ? 1 : 0).run();

    return json({ success: true, data: { id: r.meta.last_row_id, token } });
}

async function handleUpdateSubscribeConfig(request, db, id) {
    const body = await request.json();
    const sets = [], vals = [];

    if (body.uuid !== undefined) { sets.push('uuid = ?'); vals.push(body.uuid); }
    if (body.snippetsDomain !== undefined) {
        const domain = body.snippetsDomain.replace(/^https?:\/\//, '').replace(/\/$/, '');
        sets.push('snippets_domain = ?');
        vals.push(domain);
    }
    if (body.proxyPath !== undefined) { sets.push('proxy_path = ?'); vals.push(body.proxyPath); }
    if (body.remark !== undefined) { sets.push('remark = ?'); vals.push(body.remark); }
    if (body.enabled !== undefined) { sets.push('enabled = ?'); vals.push(body.enabled ? 1 : 0); }
    if (body.sort_order !== undefined) { sets.push('sort_order = ?'); vals.push(body.sort_order); }
    if (body.include_blacklisted_cfip !== undefined || body.includeBlacklistedCfip !== undefined) { sets.push('include_blacklisted_cfip = ?'); vals.push(getIncludeBlacklistedCfipValue(body)); }
    if (body.pathFormat !== undefined) { sets.push('path_format = ?'); vals.push(body.pathFormat); }
    if (body.compactGlobalMode !== undefined) { sets.push('compact_global_mode = ?'); vals.push(body.compactGlobalMode ? 1 : 0); }

    if (sets.length === 0) return json({ error: '没有要更新的字段' }, 400);

    sets.push('updated_at = datetime("now")');
    vals.push(id);

    await db.prepare(`UPDATE subscribe_config SET ${sets.join(', ')} WHERE id = ?`).bind(...vals).run();
    return json({ success: true });
}

async function handleDeleteSubscribeConfig(db, id) {
    await db.prepare('DELETE FROM subscribe_config WHERE id = ?').bind(id).run();
    return json({ success: true });
}

async function handleResetSubscribeToken(db, id) {
    const newToken = generateToken();
    await db.prepare('UPDATE subscribe_config SET token = ?, updated_at = datetime("now") WHERE id = ?').bind(newToken, id).run();
    return json({ success: true, data: { token: newToken } });
}

// V<span>LESS</span> 订阅配置
async function handleGetVlConfig(db) {
    const config = await db.prepare('SELECT * FROM subscribe_config WHERE id = 1').first();
    return json({ success: true, data: config });
}

// SS 订阅配置
async function handleGetSSConfig(db) {
    const config = await db.prepare('SELECT * FROM subscribe_config WHERE id = 2').first();
    if (config) {
        // 将 uuid 字段作为 password 返回
        return json({ success: true, data: { password: config.uuid, snippets_domain: config.snippets_domain, proxy_path: config.proxy_path, include_blacklisted_cfip: config.include_blacklisted_cfip || 0 } });
    }
    return json({ success: true, data: null });
}

// V<span>LESS</span> 订阅生成
async function handleGenerateVlSubscribe(request, db) {
    const body = await request.json();
    const { uuid, snippetsDomain, proxyPath = '/?ed=2560', status = 'enabled' } = body;
    if (!uuid || !snippetsDomain) return json({ error: 'UUID 和域名不能为空' }, 400);

    const domain = snippetsDomain.replace(/^https?:\/\//, '').replace(/\/$/, '');
    const includeBlacklistedCfip = await resolveIncludeBlacklistedCfipValue(db, 1, body);
    await db.prepare('INSERT OR REPLACE INTO subscribe_config (id, uuid, snippets_domain, proxy_path, include_blacklisted_cfip, updated_at) VALUES (1, ?, ?, ?, ?, datetime("now"))')
        .bind(uuid, domain, proxyPath, includeBlacklistedCfip).run();

    // 支持多选状态，例如 status="enabled,death_reprieve" (旧参数) 或 "enabled,invalid"
    let statusList = status.split(',');
    // 兼容旧的 death_reprieve
    statusList = statusList.map(s => s === 'death_reprieve' ? 'invalid' : s);

    // 如果 status 包含 enabled，则也包含旧数据的 enabled=1
    // 这里简化逻辑，查询时如果 targetStatus 包含 enabled，则查询 enabled=1
    // 如果 targetStatus 包含 invalid，则查询 status='invalid'
    // 实际上由于 status 字段是新加的，旧数据的 status 可能是 null (如果不设置 default) 或者 default
    // 我们的 default 是 'enabled'，所以可以直接基于 check_cf_ips 更新后的 status 查询
    // 但为了兼容，我们构建动态 SQL

    let query = 'SELECT * FROM cf_ips WHERE ';
    let conditions = [];
    let params = [];

    if (statusList.includes('enabled')) {
        conditions.push("status = 'enabled' OR status IS NULL");
    }
    if (statusList.includes('disabled')) {
        conditions.push("status = 'disabled'");
    }
    if (statusList.includes('invalid')) {
        conditions.push("status = 'invalid'");
    }

    // 如果没有条件，默认查 enabled
    if (conditions.length === 0) {
        conditions.push("status = 'enabled' OR status IS NULL");
    }

    query += `(${conditions.join(' OR ')}) AND ${getCfipSubscribeCondition(includeBlacklistedCfip)} ORDER BY speed DESC, sort_order, id`;

    const { results: cfips } = await db.prepare(query).all();
    if (cfips.length === 0) return json({ error: '没有符合条件的 CFIP' }, 400);

    const { results: proxyips } = await db.prepare('SELECT * FROM proxy_ips WHERE enabled = 1 ORDER BY sort_order, id').all();
    const { results: outbounds } = await db.prepare('SELECT * FROM outbounds WHERE enabled = 1 ORDER BY sort_order, id').all();
    const allProxies = [...proxyips, ...outbounds];

    const links = [];
    if (allProxies.length === 0) {
        for (const cfip of cfips) {
            let host = cfip.address;
            if (host.includes(':') && !host.startsWith('[')) host = `[${host}]`;
            const nodeName = cfip.name || cfip.remark || host;
            links.push(`v${'less'}://${uuid}@${host}:${cfip.port || 443}?encryption=none&security=tls&sni=${domain}&fp=firefox&allowInsecure=1&type=ws&host=${domain}&path=${encodeURIComponent(proxyPath)}#${encodeURIComponent(nodeName)}`);
        }
    } else {
        for (const proxyip of allProxies) {
            for (const cfip of cfips) {
                let host = cfip.address;
                if (host.includes(':') && !host.startsWith('[')) host = `[${host}]`;
                const path = proxyPath + (proxyPath.includes('?') ? '&' : '?') + `proxyip=${encodeURIComponent(proxyip.address)}`;
                const cfipRemark = cfip.name || cfip.remark || host;
                const nodeName = `${cfipRemark}-${proxyip.remark}`;
                links.push(`v${'less'}://${uuid}@${host}:${cfip.port || 443}?encryption=none&security=tls&sni=${domain}&fp=firefox&allowInsecure=1&type=ws&host=${domain}&path=${encodeURIComponent(path)}#${encodeURIComponent(nodeName)}`);
            }
        }
    }

    return json({ success: true, data: { plain: links.join('\n'), count: links.length } });
}

// SS 订阅生成
async function handleGenerateSSSubscribe(request, db) {
    const body = await request.json();
    const { password, snippetsDomain, proxyPath } = body;
    if (!password || !snippetsDomain) return json({ error: '密码和域名不能为空' }, 400);

    const domain = snippetsDomain.replace(/^https?:\/\//, '').replace(/\/$/, '');
    const finalPath = proxyPath || `/${password}`;
    const includeBlacklistedCfip = await resolveIncludeBlacklistedCfipValue(db, 2, body);

    // 保存配置，使用 uuid 字段存储 password
    await db.prepare('INSERT OR REPLACE INTO subscribe_config (id, uuid, snippets_domain, proxy_path, include_blacklisted_cfip, updated_at) VALUES (2, ?, ?, ?, ?, datetime("now"))')
        .bind(password, domain, finalPath, includeBlacklistedCfip).run();

    const { results: cfips } = await db.prepare(`SELECT * FROM cf_ips WHERE (status = 'enabled' OR status IS NULL) AND ${getCfipSubscribeCondition(includeBlacklistedCfip)} ORDER BY speed DESC, sort_order, id`).all();
    if (cfips.length === 0) return json({ error: '没有启用的 CFIP' }, 400);

    const method = 'none';
    const links = [];

    for (const cfip of cfips) {
        let host = cfip.address;
        if (host.includes(':') && !host.startsWith('[')) host = `[${host}]`;
        const port = cfip.port || 443;
        const nodeName = cfip.name || cfip.remark || host;

        // SS 格式
        const ssConfig = `${method}:${password}`;
        const encodedConfig = btoa(ssConfig);
        // 原版格式: /path/?ed=2560，只对 = 编码，? 和 / 不编码
        const pathWithQuery = finalPath + '/?ed=2560';
        const encodedPath = pathWithQuery.replace(/=/g, '%3D');
        const ssLink = `ss://${encodedConfig}@${host}:${port}?plugin=v2ray-plugin;mode%3Dwebsocket;host%3D${domain};path%3D${encodedPath};tls;sni%3D${domain};skip-cert-verify%3Dtrue;mux%3D0#${encodeURIComponent(nodeName)}`;
        links.push(ssLink);
    }

    return json({ success: true, data: { plain: links.join('\n'), count: links.length } });
}

// 通过 token 生成订阅
async function handleSubscribeByToken(db, token, url) {
    const config = await db.prepare('SELECT * FROM subscribe_config WHERE token = ? AND enabled = 1').bind(token).first();
    if (!config) return new Response('Not Found', { status: 404 });

    // 根据类型调用对应的订阅生成函数
    if (config.type === 'vl' + 'ess') {
        return handleSubscribe(db, config.uuid, url, config);
    } else if (config.type === 'ss') {
        return handleSSSubscribe(db, config.uuid, url, config);
    }

    return new Response('Invalid Config Type', { status: 400 });
}

// 通过配置 ID 生成订阅 (已废弃，保留用于兼容)
async function handleSubscribeByConfigId(db, configId, url) {
    const config = await db.prepare('SELECT * FROM subscribe_config WHERE id = ? AND enabled = 1').bind(configId).first();
    if (!config) return new Response('Not Found', { status: 404 });

    // 根据类型调用对应的订阅生成函数
    if (config.type === 'vl' + 'ess') {
        return handleSubscribe(db, config.uuid, url, config);
    } else if (config.type === 'ss') {
        return handleSSSubscribe(db, config.uuid, url, config);
    }

    return new Response('Invalid Config Type', { status: 400 });
}

// 公开订阅
async function handleSubscribe(db, uuid, url, configParam = null) {
    let config = configParam;
    if (!config) {
        config = await db.prepare('SELECT * FROM subscribe_config WHERE id = 1').first();
    }
    if (!config || uuid !== config.uuid) return new Response('Not Found', { status: 404 });

    // 解析URL参数
    const urlParams = new URL(url).searchParams;
    const proxyipIds = urlParams.get('proxyip')?.split(',').filter(id => id.trim()) || [];
    const outboundIds = urlParams.get('outbound')?.split(',').filter(id => id.trim()) || [];
    const cfipIds = urlParams.get('cfip')?.split(',').filter(id => id.trim()) || [];
    const { topSpeedCount, topLatencyCount, extraCount } = parseSmartNodeCounts(urlParams);
    const enableSmartNode = topSpeedCount > 0 || topLatencyCount > 0;
    const smartOnly = enableSmartNode && extraCount === 0;

    // cfipStatus 参数用于按状态筛选: enabled, disabled, invalid
    // 支持旧的 status 参数作为后备
    const cfipStatusParam = urlParams.get('cfipStatus') || urlParams.get('status');

    // 获取CFIP列表
    const cfipSubscribeCondition = getCfipSubscribeConditionFromParams(urlParams, config.include_blacklisted_cfip);
    let { cfips, topSpeedCfips, topLatencyCfips, useSmartOnlyQuery } = await resolveSubscribeCfips(
        db,
        cfipIds,
        cfipStatusParam,
        cfipSubscribeCondition,
        smartOnly,
        topSpeedCount,
        topLatencyCount
    );

    if (cfips.length === 0) return new Response('No CFIP', { status: 404 });

    // 获取ProxyIP和Outbound列表
    let proxyips = [];
    let outbounds = [];

    if (proxyipIds.length > 0) {
        // 指定了ProxyIP ID，获取指定的ProxyIP（不管启用状态）
        const placeholders = proxyipIds.map(() => '?').join(',');
        const { results } = await db.prepare(`SELECT * FROM proxy_ips WHERE id IN (${placeholders}) ORDER BY sort_order, id`).bind(...proxyipIds).all();
        proxyips = results;
    } else if (outboundIds.length === 0) {
        // 未指定任何ID，获取所有启用的ProxyIP
        const { results } = await db.prepare('SELECT * FROM proxy_ips WHERE enabled = 1 ORDER BY sort_order, id').all();
        proxyips = results;
    }

    if (outboundIds.length > 0) {
        // 指定了Outbound ID，获取指定的Outbound（不管启用状态）
        const placeholders = outboundIds.map(() => '?').join(',');
        const { results } = await db.prepare(`SELECT * FROM outbounds WHERE id IN (${placeholders}) ORDER BY sort_order, id`).bind(...outboundIds).all();
        outbounds = results;
    } else if (proxyipIds.length === 0) {
        // 未指定任何ID，获取所有启用的Outbound
        const { results } = await db.prepare('SELECT * FROM outbounds WHERE enabled = 1 ORDER BY sort_order, id').all();
        outbounds = results;
    }

    const proxyPath = config.proxy_path || '/?ed=2560';
    const configRemark = config.remark || 'V<span>LESS</span>';
    const pathFormat = config.path_format || 'default';
    const compactGlobalMode = config.compact_global_mode !== undefined ? config.compact_global_mode : 1;

    // 合并 ProxyIP 和 Outbound
    const allProxies = [...proxyips, ...outbounds];

    // 辅助函数：根据格式生成路径
    function generatePath(proxyip, baseProxyPath) {
        if (pathFormat === 'compact') {
            // 简洁格式
            const address = proxyip.address;
            const type = proxyip.type;

            // 解析地址
            if (type === 'socks5') {
                // socks5://user:pass@host:port 或 socks5://host:port
                const match = address.match(/^socks5:\/\/(.+)$/);
                if (match) {
                    const addrPart = match[1];
                    // 提取查询参数（如果有）
                    const queryMatch = baseProxyPath.match(/\?(.+)$/);
                    const query = queryMatch ? queryMatch[1] : 'ed=2560';
                    // 根据 compactGlobalMode 选择 /s= 或 /g=
                    const prefix = compactGlobalMode ? '/g=' : '/s=';
                    return `${prefix}${addrPart}?${query}`;
                }
            } else if (type === 'http' || type === 'https') {
                // http://user:pass@host:port 或 http://host:port
                const match = address.match(/^https?:\/\/(.+)$/);
                if (match) {
                    const addrPart = match[1];
                    const queryMatch = baseProxyPath.match(/\?(.+)$/);
                    const query = queryMatch ? queryMatch[1] : 'ed=2560';
                    // 根据 compactGlobalMode 选择 /h= 或 /gh=
                    const prefix = compactGlobalMode ? '/gh=' : '/h=';
                    return `${prefix}${addrPart}?${query}`;
                }
            } else {
                // ProxyIP（普通 IP/域名）
                const queryMatch = baseProxyPath.match(/\?(.+)$/);
                const query = queryMatch ? queryMatch[1] : 'ed=2560';
                return `/p=${address}?${query}`;
            }
        }

        // 默认格式
        return baseProxyPath + (baseProxyPath.includes('?') ? '&' : '?') + `proxyip=${encodeURIComponent(proxyip.address)}`;
    }

    // 生成所有 ProxyIP × CFIP 的组合（相同 ProxyIP 的放在一起）
    const links = [];
    const regularCfips = smartOnly ? [] : cfips;
    if (allProxies.length === 0) {
        // 没有 ProxyIP，只生成 CFIP
        for (const cfip of regularCfips) {
            let host = cfip.address;
            if (host.includes(':') && !host.startsWith('[')) host = `[${host}]`;
            const nodeName = `${cfip.name || cfip.remark || host}-${configRemark}`;
            links.push(`v${'less'}://${uuid}@${host}:${cfip.port || 443}?encryption=none&security=tls&sni=${config.snippets_domain}&fp=firefox&allowInsecure=1&type=ws&host=${config.snippets_domain}&path=${encodeURIComponent(proxyPath)}#${encodeURIComponent(nodeName)}`);
        }
    } else {
        // 为每个 ProxyIP 生成所有 CFIP 的组合
        for (const proxyip of allProxies) {
            for (const cfip of regularCfips) {
                let host = cfip.address;
                if (host.includes(':') && !host.startsWith('[')) host = `[${host}]`;

                const path = generatePath(proxyip, proxyPath);
                const cfipRemark = cfip.name || cfip.remark || host;
                const nodeName = `${cfipRemark}-${proxyip.remark}-${configRemark}`;

                links.push(`v${'less'}://${uuid}@${host}:${cfip.port || 443}?encryption=none&security=tls&sni=${config.snippets_domain}&fp=firefox&allowInsecure=1&type=ws&host=${config.snippets_domain}&path=${encodeURIComponent(path)}#${encodeURIComponent(nodeName)}`);
            }
        }
    }

    // 智能节点：在最前面插入最大速度和最低延迟节点
    let smartLinkCount = 0;
    if (enableSmartNode) {
        ({ topSpeedCfips, topLatencyCfips } = resolveSmartCfipGroups(
            cfips,
            topSpeedCfips,
            topLatencyCfips,
            useSmartOnlyQuery,
            topSpeedCount,
            topLatencyCount
        ));

        const smartLinks = [];
        if (allProxies.length === 0) {
            // 无 proxy 模式
            topSpeedCfips.forEach((cfip, i) => {
                let host = cfip.address;
                if (host.includes(':') && !host.startsWith('[')) host = `[${host}]`;
                const nodeName = `最大速度${i + 1}-${configRemark}`;
                smartLinks.push(`v${'less'}://${uuid}@${host}:${cfip.port || 443}?encryption=none&security=tls&sni=${config.snippets_domain}&fp=firefox&allowInsecure=1&type=ws&host=${config.snippets_domain}&path=${encodeURIComponent(proxyPath)}#${encodeURIComponent(nodeName)}`);
            });
            topLatencyCfips.forEach((cfip, i) => {
                let host = cfip.address;
                if (host.includes(':') && !host.startsWith('[')) host = `[${host}]`;
                const nodeName = `最低延迟${i + 1}-${configRemark}`;
                smartLinks.push(`v${'less'}://${uuid}@${host}:${cfip.port || 443}?encryption=none&security=tls&sni=${config.snippets_domain}&fp=firefox&allowInsecure=1&type=ws&host=${config.snippets_domain}&path=${encodeURIComponent(proxyPath)}#${encodeURIComponent(nodeName)}`);
            });
        } else {
            // 有 proxy 模式，为每个 proxy 生成智能节点
            for (const proxyip of allProxies) {
                topSpeedCfips.forEach((cfip, i) => {
                    let host = cfip.address;
                    if (host.includes(':') && !host.startsWith('[')) host = `[${host}]`;
                    const path = generatePath(proxyip, proxyPath);
                    const nodeName = `最大速度${i + 1}-${proxyip.remark}`;
                    smartLinks.push(`v${'less'}://${uuid}@${host}:${cfip.port || 443}?encryption=none&security=tls&sni=${config.snippets_domain}&fp=firefox&allowInsecure=1&type=ws&host=${config.snippets_domain}&path=${encodeURIComponent(path)}#${encodeURIComponent(nodeName)}`);
                });
                topLatencyCfips.forEach((cfip, i) => {
                    let host = cfip.address;
                    if (host.includes(':') && !host.startsWith('[')) host = `[${host}]`;
                    const path = generatePath(proxyip, proxyPath);
                    const nodeName = `最低延迟${i + 1}-${proxyip.remark}`;
                    smartLinks.push(`v${'less'}://${uuid}@${host}:${cfip.port || 443}?encryption=none&security=tls&sni=${config.snippets_domain}&fp=firefox&allowInsecure=1&type=ws&host=${config.snippets_domain}&path=${encodeURIComponent(path)}#${encodeURIComponent(nodeName)}`);
                });
            }
        }
        smartLinkCount = smartLinks.length;
        links.unshift(...smartLinks);
    }

    return encodeSubscriptionResponse(finalizeSmartSubscriptionLinks(links, smartLinkCount, enableSmartNode, extraCount));
}

// SS 公开订阅
async function handleSSSubscribe(db, password, url, configParam = null) {
    let config = configParam;
    if (!config) {
        config = await db.prepare('SELECT * FROM subscribe_config WHERE id = 2').first();
    }
    if (!config || password !== config.uuid) return new Response('Not Found', { status: 404 });

    // 解析URL参数
    const urlParams = new URL(url).searchParams;
    const proxyipIds = urlParams.get('proxyip')?.split(',').filter(id => id.trim()) || [];
    const outboundIds = urlParams.get('outbound')?.split(',').filter(id => id.trim()) || [];
    const cfipIds = urlParams.get('cfip')?.split(',').filter(id => id.trim()) || [];
    const { topSpeedCount, topLatencyCount, extraCount } = parseSmartNodeCounts(urlParams);
    const enableSmartNode = topSpeedCount > 0 || topLatencyCount > 0;
    const smartOnly = enableSmartNode && extraCount === 0;

    // cfipStatus 参数用于按状态筛选: enabled, disabled, invalid
    const cfipStatusParam = urlParams.get('cfipStatus');

    // 获取CFIP列表
    const cfipSubscribeCondition = getCfipSubscribeConditionFromParams(urlParams, config.include_blacklisted_cfip);
    let { cfips, topSpeedCfips, topLatencyCfips, useSmartOnlyQuery } = await resolveSubscribeCfips(
        db,
        cfipIds,
        cfipStatusParam,
        cfipSubscribeCondition,
        smartOnly,
        topSpeedCount,
        topLatencyCount
    );

    if (cfips.length === 0) return new Response('No CFIP', { status: 404 });

    // 获取ProxyIP和Outbound列表
    let proxyips = [];
    let outbounds = [];

    if (proxyipIds.length > 0) {
        // 指定了ProxyIP ID，获取指定的ProxyIP（不管启用状态）
        const placeholders = proxyipIds.map(() => '?').join(',');
        const { results } = await db.prepare(`SELECT * FROM proxy_ips WHERE id IN (${placeholders}) ORDER BY sort_order, id`).bind(...proxyipIds).all();
        proxyips = results;
    } else if (outboundIds.length === 0) {
        // 未指定任何ID，获取所有启用的ProxyIP
        const { results } = await db.prepare('SELECT * FROM proxy_ips WHERE enabled = 1 ORDER BY sort_order, id').all();
        proxyips = results;
    }

    if (outboundIds.length > 0) {
        // 指定了Outbound ID，获取指定的Outbound（不管启用状态）
        const placeholders = outboundIds.map(() => '?').join(',');
        const { results } = await db.prepare(`SELECT * FROM outbounds WHERE id IN (${placeholders}) ORDER BY sort_order, id`).bind(...outboundIds).all();
        outbounds = results;
    } else if (proxyipIds.length === 0) {
        // 未指定任何ID，获取所有启用的Outbound
        const { results } = await db.prepare('SELECT * FROM outbounds WHERE enabled = 1 ORDER BY sort_order, id').all();
        outbounds = results;
    }

    const proxyPath = config.proxy_path || '/';
    const method = 'none';
    const configRemark = config.remark || 'SS';

    // 合并 ProxyIP 和 Outbound
    const allProxies = [...proxyips, ...outbounds];

    const links = [];
    const regularCfips = smartOnly ? [] : cfips;
    if (allProxies.length === 0) {
        // 没有 ProxyIP，只生成 CFIP
        for (const cfip of regularCfips) {
            let host = cfip.address;
            if (host.includes(':') && !host.startsWith('[')) host = `[${host}]`;
            const port = cfip.port || 443;
            const nodeName = `${cfip.name || cfip.remark || host}-${configRemark}`;

            const ssConfig = `${method}:${password}`;
            const encodedConfig = btoa(ssConfig);
            const pathWithQuery = proxyPath + '/?ed=2560';
            const encodedPath = pathWithQuery.replace(/=/g, '%3D');
            const ssLink = `ss://${encodedConfig}@${host}:${port}?plugin=v2ray-plugin;mode%3Dwebsocket;host%3D${config.snippets_domain};path%3D${encodedPath};tls;sni%3D${config.snippets_domain};skip-cert-verify%3Dtrue;mux%3D0#${encodeURIComponent(nodeName)}`;
            links.push(ssLink);
        }
    } else {
        // 为每个 ProxyIP 生成所有 CFIP 的组合
        for (const proxyip of allProxies) {
            for (const cfip of regularCfips) {
                let host = cfip.address;
                if (host.includes(':') && !host.startsWith('[')) host = `[${host}]`;
                const port = cfip.port || 443;

                const path = proxyPath + (proxyPath.includes('?') ? '&' : '?') + `proxyip=${encodeURIComponent(proxyip.address)}`;
                const pathWithQuery = path + '&ed=2560';
                const encodedPath = pathWithQuery.replace(/=/g, '%3D');

                const cfipRemark = cfip.name || cfip.remark || host;
                const nodeName = `${cfipRemark}-${proxyip.remark}-${configRemark}`;

                const ssConfig = `${method}:${password}`;
                const encodedConfig = btoa(ssConfig);
                const ssLink = `ss://${encodedConfig}@${host}:${port}?plugin=v2ray-plugin;mode%3Dwebsocket;host%3D${config.snippets_domain};path%3D${encodedPath};tls;sni%3D${config.snippets_domain};skip-cert-verify%3Dtrue;mux%3D0#${encodeURIComponent(nodeName)}`;
                links.push(ssLink);
            }
        }
    }

    // 智能节点：在最前面插入最大速度和最低延迟节点
    let smartLinkCount = 0;
    if (enableSmartNode) {
        ({ topSpeedCfips, topLatencyCfips } = resolveSmartCfipGroups(
            cfips,
            topSpeedCfips,
            topLatencyCfips,
            useSmartOnlyQuery,
            topSpeedCount,
            topLatencyCount
        ));

        const ssConfigStr = `${method}:${password}`;
        const encodedConfig = btoa(ssConfigStr);
        const smartLinks = [];

        if (allProxies.length === 0) {
            topSpeedCfips.forEach((cfip, i) => {
                let host = cfip.address;
                if (host.includes(':') && !host.startsWith('[')) host = `[${host}]`;
                const port = cfip.port || 443;
                const nodeName = `最大速度${i + 1}-${configRemark}`;
                const pathWithQuery = proxyPath + '/?ed=2560';
                const encodedPath = pathWithQuery.replace(/=/g, '%3D');
                smartLinks.push(`ss://${encodedConfig}@${host}:${port}?plugin=v2ray-plugin;mode%3Dwebsocket;host%3D${config.snippets_domain};path%3D${encodedPath};tls;sni%3D${config.snippets_domain};skip-cert-verify%3Dtrue;mux%3D0#${encodeURIComponent(nodeName)}`);
            });
            topLatencyCfips.forEach((cfip, i) => {
                let host = cfip.address;
                if (host.includes(':') && !host.startsWith('[')) host = `[${host}]`;
                const port = cfip.port || 443;
                const nodeName = `最低延迟${i + 1}-${configRemark}`;
                const pathWithQuery = proxyPath + '/?ed=2560';
                const encodedPath = pathWithQuery.replace(/=/g, '%3D');
                smartLinks.push(`ss://${encodedConfig}@${host}:${port}?plugin=v2ray-plugin;mode%3Dwebsocket;host%3D${config.snippets_domain};path%3D${encodedPath};tls;sni%3D${config.snippets_domain};skip-cert-verify%3Dtrue;mux%3D0#${encodeURIComponent(nodeName)}`);
            });
        } else {
            for (const proxyip of allProxies) {
                topSpeedCfips.forEach((cfip, i) => {
                    let host = cfip.address;
                    if (host.includes(':') && !host.startsWith('[')) host = `[${host}]`;
                    const port = cfip.port || 443;
                    const nodeName = `最大速度${i + 1}-${proxyip.remark}`;
                    const path = proxyPath + (proxyPath.includes('?') ? '&' : '?') + `proxyip=${encodeURIComponent(proxyip.address)}`;
                    const pathWithQuery = path + '&ed=2560';
                    const encodedPath = pathWithQuery.replace(/=/g, '%3D');
                    smartLinks.push(`ss://${encodedConfig}@${host}:${port}?plugin=v2ray-plugin;mode%3Dwebsocket;host%3D${config.snippets_domain};path%3D${encodedPath};tls;sni%3D${config.snippets_domain};skip-cert-verify%3Dtrue;mux%3D0#${encodeURIComponent(nodeName)}`);
                });
                topLatencyCfips.forEach((cfip, i) => {
                    let host = cfip.address;
                    if (host.includes(':') && !host.startsWith('[')) host = `[${host}]`;
                    const port = cfip.port || 443;
                    const nodeName = `最低延迟${i + 1}-${proxyip.remark}`;
                    const path = proxyPath + (proxyPath.includes('?') ? '&' : '?') + `proxyip=${encodeURIComponent(proxyip.address)}`;
                    const pathWithQuery = path + '&ed=2560';
                    const encodedPath = pathWithQuery.replace(/=/g, '%3D');
                    smartLinks.push(`ss://${encodedConfig}@${host}:${port}?plugin=v2ray-plugin;mode%3Dwebsocket;host%3D${config.snippets_domain};path%3D${encodedPath};tls;sni%3D${config.snippets_domain};skip-cert-verify%3Dtrue;mux%3D0#${encodeURIComponent(nodeName)}`);
                });
            }
        }
        smartLinkCount = smartLinks.length;
        links.unshift(...smartLinks);
    }

    return encodeSubscriptionResponse(finalizeSmartSubscriptionLinks(links, smartLinkCount, enableSmartNode, extraCount));
}

// SOCKS5 测速
async function handleTestSocks5(request, db) {
    try {
        const { id } = await request.json();

        // 获取要测试的 ProxyIP
        let proxyips = [];
        if (id) {
            // 测试单个
            const proxy = await db.prepare('SELECT * FROM proxy_ips WHERE id = ? AND type = ?').bind(id, 'socks5').first();
            if (proxy) proxyips = [proxy];
        } else {
            // 测试所有 SOCKS5
            const { results } = await db.prepare('SELECT * FROM proxy_ips WHERE type = ? ORDER BY sort_order, id').bind('socks5').all();
            proxyips = results;
        }

        if (proxyips.length === 0) {
            return json({ error: 'No SOCKS5 proxy found' }, 404);
        }

        const results = [];
        for (const proxy of proxyips) {
            const startTime = Date.now();
            let socket = null;
            let writer = null;
            let reader = null;

            try {
                const parsed = parseSocks5Address(proxy.address);

                // 创建超时 Promise
                const timeoutPromise = new Promise((_, reject) => {
                    setTimeout(() => reject(new Error('Connection timeout')), 5000);
                });

                // 连接 SOCKS5 服务器
                const connectPromise = (async () => {
                    socket = connect({
                        hostname: parsed.host,
                        port: parsed.port
                    });

                    writer = socket.writable.getWriter();
                    reader = socket.readable.getReader();

                    // 发送 SOCKS5 握手
                    const authMethods = parsed.username && parsed.password ?
                        new Uint8Array([0x05, 0x02, 0x00, 0x02]) :
                        new Uint8Array([0x05, 0x01, 0x00]);

                    await writer.write(authMethods);

                    // 读取服务器响应
                    const methodResponse = await reader.read();

                    if (methodResponse.done || methodResponse.value.byteLength < 2) {
                        throw new Error('Invalid method response');
                    }

                    const responseArray = new Uint8Array(methodResponse.value);
                    if (responseArray[0] !== 0x05) {
                        throw new Error('Invalid SOCKS version');
                    }

                    const selectedMethod = responseArray[1];

                    // 如果服务器选择了用户名密码认证
                    if (selectedMethod === 0x02) {
                        if (!parsed.username || !parsed.password) {
                            throw new Error('Server requires authentication');
                        }

                        const encoder = new TextEncoder();
                        const userBytes = encoder.encode(parsed.username);
                        const passBytes = encoder.encode(parsed.password);
                        const authPacket = new Uint8Array(3 + userBytes.length + passBytes.length);
                        authPacket[0] = 0x01;
                        authPacket[1] = userBytes.length;
                        authPacket.set(userBytes, 2);
                        authPacket[2 + userBytes.length] = passBytes.length;
                        authPacket.set(passBytes, 3 + userBytes.length);

                        await writer.write(authPacket);
                        const authResponse = await reader.read();

                        if (authResponse.done || authResponse.value.byteLength < 2) {
                            throw new Error('Invalid auth response');
                        }

                        if (new Uint8Array(authResponse.value)[1] !== 0x00) {
                            throw new Error('Authentication failed');
                        }
                    } else if (selectedMethod === 0xFF) {
                        throw new Error('No acceptable methods');
                    } else if (selectedMethod !== 0x00) {
                        throw new Error(`Unsupported auth method: ${selectedMethod}`);
                    }

                    // 测试连接到 1.1.1.1:80
                    const connectPacket = new Uint8Array([
                        0x05, 0x01, 0x00, 0x01,
                        0x01, 0x01, 0x01, 0x01,
                        0x00, 0x50
                    ]);

                    await writer.write(connectPacket);
                    const connectResponse = await reader.read();

                    if (connectResponse.done || connectResponse.value.byteLength < 2) {
                        throw new Error('Invalid connect response');
                    }

                    const connectArray = new Uint8Array(connectResponse.value);
                    if (connectArray[1] !== 0x00) {
                        throw new Error(`Connection failed with code: ${connectArray[1]}`);
                    }

                    return Date.now() - startTime;
                })();

                // 等待连接或超时
                const latency = await Promise.race([connectPromise, timeoutPromise]);

                results.push({
                    id: proxy.id,
                    remark: proxy.remark,
                    address: proxy.address,
                    status: 'online',
                    latency
                });
            } catch (error) {
                results.push({
                    id: proxy.id,
                    remark: proxy.remark,
                    address: proxy.address,
                    status: 'offline',
                    latency: -1,
                    error: error.message
                });
            } finally {
                // 清理资源
                try {
                    if (writer) writer.releaseLock();
                    if (reader) reader.releaseLock();
                    if (socket) socket.close();
                } catch (e) { }
            }
        }

        return json({ success: true, results });
    } catch (error) {
        return json({ error: 'Test failed: ' + error.message }, 500);
    }
}

// 解析 SOCKS5 地址
function parseSocks5Address(address) {
    // socks5://user:pass@host:port 或 socks://user:pass@host:port
    const match = address.match(/^socks5?:\/\/(?:([^:]+):([^@]+)@)?([^:]+):(\d+)$/);
    if (!match) {
        throw new Error('Invalid SOCKS5 address format');
    }
    return {
        username: match[1] || '',
        password: match[2] || '',
        host: match[3],
        port: parseInt(match[4])
    };
}

// 解析 HTTP 代理地址
function parseHttpAddress(address) {
    // http://user:pass@host:port 或 http://host:port
    const match = address.match(/^https?:\/\/(?:([^:]+):([^@]+)@)?([^:]+):(\d+)$/);
    if (!match) {
        throw new Error('Invalid HTTP proxy address format');
    }
    return {
        username: match[1] || '',
        password: match[2] || '',
        host: match[3],
        port: parseInt(match[4])
    };
}

// 出站检测（检查代理的出口 IP 信息）
async function handleCheckExit(request, db) {
    try {
        const { id, ids } = await request.json();

        // 获取要检测的 Outbound
        let outbounds = [];
        if (id) {
            // 检测单个
            const outbound = await db.prepare('SELECT * FROM outbounds WHERE id = ?').bind(id).first();
            if (outbound) outbounds = [outbound];
        } else if (ids && Array.isArray(ids) && ids.length > 0) {
            // 检测指定的多个
            const placeholders = ids.map(() => '?').join(',');
            const { results } = await db.prepare(`SELECT * FROM outbounds WHERE id IN (${placeholders}) ORDER BY sort_order, id`).bind(...ids).all();
            outbounds = results;
        } else {
            // 检测所有
            const { results } = await db.prepare('SELECT * FROM outbounds ORDER BY sort_order, id').all();
            outbounds = results;
        }

        if (outbounds.length === 0) {
            return json({ error: '没有找到出站代理' }, 404);
        }

        const results = [];
        for (const outbound of outbounds) {
            let socket = null;
            let writer = null;
            let reader = null;

            try {
                // 解析代理地址获取主机名
                const parsed = outbound.type === 'socks5'
                    ? parseSocks5Address(outbound.address)
                    : parseHttpAddress(outbound.address);

                // 获取入口信息（代理服务器本身的IP信息）
                let entryInfo = null;
                try {
                    const entryIPResponse = await fetch(`https://api.ipapi.is/?q=${parsed.host}`);
                    if (entryIPResponse.ok) {
                        entryInfo = await entryIPResponse.json();
                    }
                } catch (e) {
                    console.error('Failed to get entry info:', e);
                }

                if (outbound.type === 'socks5') {
                    // SOCKS5 代理检测
                    const timeoutPromise = new Promise((_, reject) => {
                        setTimeout(() => reject(new Error('Connection timeout')), 15000);
                    });

                    const checkPromise = (async () => {
                        socket = connect({
                            hostname: parsed.host,
                            port: parsed.port
                        });

                        writer = socket.writable.getWriter();
                        reader = socket.readable.getReader();

                        // SOCKS5 握手
                        const authMethods = parsed.username && parsed.password ?
                            new Uint8Array([0x05, 0x02, 0x00, 0x02]) :
                            new Uint8Array([0x05, 0x01, 0x00]);

                        await writer.write(authMethods);
                        const methodResponse = await reader.read();

                        if (methodResponse.done || methodResponse.value.byteLength < 2) {
                            throw new Error('Invalid method response');
                        }

                        const responseArray = new Uint8Array(methodResponse.value);
                        if (responseArray[0] !== 0x05) {
                            throw new Error('Invalid SOCKS version');
                        }

                        const selectedMethod = responseArray[1];

                        if (selectedMethod === 0x02) {
                            if (!parsed.username || !parsed.password) {
                                throw new Error('Server requires authentication');
                            }

                            const encoder = new TextEncoder();
                            const userBytes = encoder.encode(parsed.username);
                            const passBytes = encoder.encode(parsed.password);
                            const authPacket = new Uint8Array(3 + userBytes.length + passBytes.length);
                            authPacket[0] = 0x01;
                            authPacket[1] = userBytes.length;
                            authPacket.set(userBytes, 2);
                            authPacket[2 + userBytes.length] = passBytes.length;
                            authPacket.set(passBytes, 3 + userBytes.length);

                            await writer.write(authPacket);
                            const authResponse = await reader.read();

                            if (authResponse.done || authResponse.value.byteLength < 2) {
                                throw new Error('Invalid auth response');
                            }

                            if (new Uint8Array(authResponse.value)[1] !== 0x00) {
                                throw new Error('Authentication failed');
                            }
                        } else if (selectedMethod === 0xFF) {
                            throw new Error('No acceptable methods');
                        } else if (selectedMethod !== 0x00) {
                            throw new Error(`Unsupported auth method: ${selectedMethod}`);
                        }

                        // 连接到 check.socks5.090227.xyz
                        const targetHost = 'check.socks5.090227.xyz';
                        const targetPort = 80;
                        const hostBytes = new TextEncoder().encode(targetHost);
                        const connectPacket = new Uint8Array([
                            0x05, 0x01, 0x00, 0x03,
                            hostBytes.length,
                            ...hostBytes,
                            (targetPort >> 8) & 0xFF,
                            targetPort & 0xFF
                        ]);

                        await writer.write(connectPacket);
                        const connectResponse = await reader.read();

                        if (connectResponse.done || connectResponse.value.byteLength < 2) {
                            throw new Error('Invalid connect response');
                        }

                        const connectArray = new Uint8Array(connectResponse.value);
                        if (connectArray[1] !== 0x00) {
                            throw new Error(`Connection failed with code: ${connectArray[1]}`);
                        }

                        // 发送 HTTP 请求获取 /cdn-cgi/trace
                        const encoder = new TextEncoder();
                        const httpRequest = `GET /cdn-cgi/trace HTTP/1.1\r\nHost: ${targetHost}\r\nConnection: close\r\n\r\n`;
                        await writer.write(encoder.encode(httpRequest));

                        // 读取响应
                        let responseData = '';
                        const decoder = new TextDecoder();
                        let chunks = 0;
                        while (chunks < 100) {
                            const { done, value } = await reader.read();
                            if (done) break;
                            responseData += decoder.decode(value, { stream: true });
                            chunks++;
                        }

                        // 解析响应获取IP
                        const ipMatch = responseData.match(/ip=([\d\.]+)/);
                        if (!ipMatch) {
                            throw new Error('无法从响应中提取IP地址');
                        }

                        const exitIP = ipMatch[1].trim();

                        // 使用 ipapi.is API 获取详细信息
                        const ipInfoResponse = await fetch(`https://api.ipapi.is/?q=${exitIP}`);
                        if (!ipInfoResponse.ok) {
                            throw new Error(`IP信息查询失败: ${ipInfoResponse.status}`);
                        }

                        const ipInfo = await ipInfoResponse.json();

                        return {
                            ip: exitIP,
                            country: ipInfo.location?.country || 'Unknown',
                            city: ipInfo.location?.city || 'Unknown',
                            org: ipInfo.asn?.org || 'Unknown',
                            asn: ipInfo.asn?.asn ? `AS${ipInfo.asn.asn}` : 'Unknown',
                            fullExitInfo: ipInfo,
                            fullEntryInfo: ipInfo  // 入口和出口使用相同的信息
                        };
                    })();

                    const exitInfo = await Promise.race([checkPromise, timeoutPromise]);

                    // 保存到数据库（只保留 country 和 city 用于列表显示，详细信息存在 JSON 中）
                    await db.prepare('UPDATE outbounds SET exit_country = ?, exit_city = ?, entry_info_json = ?, exit_info_json = ?, checked_at = datetime("now") WHERE id = ?')
                        .bind(
                            exitInfo.country,
                            exitInfo.city,
                            exitInfo.fullEntryInfo ? JSON.stringify(exitInfo.fullEntryInfo) : null,
                            exitInfo.fullExitInfo ? JSON.stringify(exitInfo.fullExitInfo) : null,
                            outbound.id
                        ).run();

                    results.push({
                        id: outbound.id,
                        success: true,
                        ...exitInfo
                    });
                } else if (outbound.type === 'http') {
                    // HTTP 代理检测
                    const timeoutPromise = new Promise((_, reject) => {
                        setTimeout(() => reject(new Error('Connection timeout')), 15000);
                    });

                    const checkPromise = (async () => {
                        socket = connect({
                            hostname: parsed.host,
                            port: parsed.port
                        });

                        writer = socket.writable.getWriter();
                        reader = socket.readable.getReader();

                        // 发送 HTTP CONNECT 请求
                        const encoder = new TextEncoder();
                        const targetHost = 'check.socks5.090227.xyz';
                        const targetPort = 80;
                        let connectRequest = `CONNECT ${targetHost}:${targetPort} HTTP/1.1\r\nHost: ${targetHost}:${targetPort}\r\n`;

                        if (parsed.username && parsed.password) {
                            const auth = btoa(`${parsed.username}:${parsed.password}`);
                            connectRequest += `Proxy-Authorization: Basic ${auth}\r\n`;
                        }

                        connectRequest += `\r\n`;
                        await writer.write(encoder.encode(connectRequest));

                        // 读取 CONNECT 响应
                        let connectResponseData = '';
                        const decoder = new TextDecoder();
                        let chunks = 0;
                        while (chunks < 10) {
                            const { done, value } = await reader.read();
                            if (done) break;
                            connectResponseData += decoder.decode(value, { stream: true });
                            chunks++;
                            if (connectResponseData.includes('\r\n\r\n')) break;
                        }

                        if (!connectResponseData.includes('200')) {
                            throw new Error('Proxy connection failed: ' + connectResponseData.split('\r\n')[0]);
                        }

                        // 发送 HTTP 请求获取 /cdn-cgi/trace
                        const httpRequest = `GET /cdn-cgi/trace HTTP/1.1\r\nHost: ${targetHost}\r\nConnection: close\r\n\r\n`;
                        await writer.write(encoder.encode(httpRequest));

                        // 读取响应
                        let responseData = '';
                        chunks = 0;
                        while (chunks < 100) {
                            const { done, value } = await reader.read();
                            if (done) break;
                            responseData += decoder.decode(value, { stream: true });
                            chunks++;
                        }

                        // 解析响应获取IP
                        const ipMatch = responseData.match(/ip=(.*)/);
                        if (!ipMatch) {
                            throw new Error('无法从响应中提取IP地址');
                        }

                        const exitIP = ipMatch[1].trim();

                        // 使用 ipapi.is API 获取详细信息
                        const ipInfoResponse = await fetch(`https://api.ipapi.is/?q=${exitIP}`);
                        if (!ipInfoResponse.ok) {
                            throw new Error(`IP信息查询失败: ${ipInfoResponse.status}`);
                        }

                        const ipInfo = await ipInfoResponse.json();

                        return {
                            ip: exitIP,
                            country: ipInfo.location?.country || 'Unknown',
                            city: ipInfo.location?.city || 'Unknown',
                            org: ipInfo.asn?.org || 'Unknown',
                            asn: ipInfo.asn?.asn ? `AS${ipInfo.asn.asn}` : 'Unknown',
                            fullExitInfo: ipInfo,
                            fullEntryInfo: ipInfo  // 入口和出口使用相同的信息
                        };
                    })();

                    const exitInfo = await Promise.race([checkPromise, timeoutPromise]);

                    // 保存到数据库（只保留 country 和 city 用于列表显示，详细信息存在 JSON 中）
                    await db.prepare('UPDATE outbounds SET exit_country = ?, exit_city = ?, entry_info_json = ?, exit_info_json = ?, checked_at = datetime("now") WHERE id = ?')
                        .bind(
                            exitInfo.country,
                            exitInfo.city,
                            exitInfo.fullEntryInfo ? JSON.stringify(exitInfo.fullEntryInfo) : null,
                            exitInfo.fullExitInfo ? JSON.stringify(exitInfo.fullExitInfo) : null,
                            outbound.id
                        ).run();

                    results.push({
                        id: outbound.id,
                        success: true,
                        ...exitInfo
                    });
                } else {
                    throw new Error('Unsupported outbound type: ' + outbound.type);
                }
            } catch (error) {
                results.push({
                    id: outbound.id,
                    success: false,
                    error: error.message
                });
            } finally {
                // 清理资源
                try {
                    if (writer) writer.releaseLock();
                    if (reader) reader.releaseLock();
                    if (socket) socket.close();
                } catch (e) { }
            }
        }

        return json({ success: true, results });
    } catch (error) {
        return json({ error: 'Check failed: ' + error.message }, 500);
    }
}

// 出站测速（支持 SOCKS5 和 HTTP）
async function handleTestOutbound(request, db) {
    try {
        const { id } = await request.json();

        // 获取要测试的 Outbound
        let outbounds = [];
        if (id) {
            // 测试单个
            const outbound = await db.prepare('SELECT * FROM outbounds WHERE id = ?').bind(id).first();
            if (outbound) outbounds = [outbound];
        } else {
            // 测试所有
            const { results } = await db.prepare('SELECT * FROM outbounds ORDER BY sort_order, id').all();
            outbounds = results;
        }

        if (outbounds.length === 0) {
            return json({ error: 'No outbound found' }, 404);
        }

        const results = [];
        for (const outbound of outbounds) {
            const startTime = Date.now();
            let socket = null;
            let writer = null;
            let reader = null;

            try {
                if (outbound.type === 'socks5') {
                    // SOCKS5 测速逻辑
                    const parsed = parseSocks5Address(outbound.address);

                    const timeoutPromise = new Promise((_, reject) => {
                        setTimeout(() => reject(new Error('Connection timeout')), 5000);
                    });

                    const connectPromise = (async () => {
                        socket = connect({
                            hostname: parsed.host,
                            port: parsed.port
                        });

                        writer = socket.writable.getWriter();
                        reader = socket.readable.getReader();

                        // SOCKS5 握手
                        const authMethods = parsed.username && parsed.password ?
                            new Uint8Array([0x05, 0x02, 0x00, 0x02]) :
                            new Uint8Array([0x05, 0x01, 0x00]);

                        await writer.write(authMethods);
                        const methodResponse = await reader.read();

                        if (methodResponse.done || methodResponse.value.byteLength < 2) {
                            throw new Error('Invalid method response');
                        }

                        const responseArray = new Uint8Array(methodResponse.value);
                        if (responseArray[0] !== 0x05) {
                            throw new Error('Invalid SOCKS version');
                        }

                        const selectedMethod = responseArray[1];

                        if (selectedMethod === 0x02) {
                            if (!parsed.username || !parsed.password) {
                                throw new Error('Server requires authentication');
                            }

                            const encoder = new TextEncoder();
                            const userBytes = encoder.encode(parsed.username);
                            const passBytes = encoder.encode(parsed.password);
                            const authPacket = new Uint8Array(3 + userBytes.length + passBytes.length);
                            authPacket[0] = 0x01;
                            authPacket[1] = userBytes.length;
                            authPacket.set(userBytes, 2);
                            authPacket[2 + userBytes.length] = passBytes.length;
                            authPacket.set(passBytes, 3 + userBytes.length);

                            await writer.write(authPacket);
                            const authResponse = await reader.read();

                            if (authResponse.done || authResponse.value.byteLength < 2) {
                                throw new Error('Invalid auth response');
                            }

                            if (new Uint8Array(authResponse.value)[1] !== 0x00) {
                                throw new Error('Authentication failed');
                            }
                        } else if (selectedMethod === 0xFF) {
                            throw new Error('No acceptable methods');
                        } else if (selectedMethod !== 0x00) {
                            throw new Error(`Unsupported auth method: ${selectedMethod}`);
                        }

                        // 测试连接到 1.1.1.1:80
                        const connectPacket = new Uint8Array([
                            0x05, 0x01, 0x00, 0x01,
                            0x01, 0x01, 0x01, 0x01,
                            0x00, 0x50
                        ]);

                        await writer.write(connectPacket);
                        const connectResponse = await reader.read();

                        if (connectResponse.done || connectResponse.value.byteLength < 2) {
                            throw new Error('Invalid connect response');
                        }

                        const connectArray = new Uint8Array(connectResponse.value);
                        if (connectArray[1] !== 0x00) {
                            throw new Error(`Connection failed with code: ${connectArray[1]}`);
                        }

                        return Date.now() - startTime;
                    })();

                    const latency = await Promise.race([connectPromise, timeoutPromise]);

                    results.push({
                        id: outbound.id,
                        remark: outbound.remark,
                        address: outbound.address,
                        status: 'online',
                        latency
                    });
                } else if (outbound.type === 'http') {
                    // HTTP 代理测速逻辑
                    const parsed = parseHttpAddress(outbound.address);

                    const timeoutPromise = new Promise((_, reject) => {
                        setTimeout(() => reject(new Error('Connection timeout')), 5000);
                    });

                    const connectPromise = (async () => {
                        socket = connect({
                            hostname: parsed.host,
                            port: parsed.port
                        });

                        writer = socket.writable.getWriter();
                        reader = socket.readable.getReader();

                        // 发送 HTTP CONNECT 请求
                        const encoder = new TextEncoder();
                        let connectRequest = `CONNECT 1.1.1.1:80 HTTP/1.1\r\nHost: 1.1.1.1:80\r\n`;

                        // 如果有认证信息
                        if (parsed.username && parsed.password) {
                            const auth = btoa(`${parsed.username}:${parsed.password}`);
                            connectRequest += `Proxy-Authorization: Basic ${auth}\r\n`;
                        }

                        connectRequest += `\r\n`;

                        await writer.write(encoder.encode(connectRequest));

                        // 读取响应
                        const response = await reader.read();

                        if (response.done) {
                            throw new Error('No response from proxy');
                        }

                        const decoder = new TextDecoder();
                        const responseText = decoder.decode(response.value);

                        // 检查是否成功（HTTP/1.1 200 或 HTTP/1.0 200）
                        if (!responseText.includes('200')) {
                            throw new Error('Proxy connection failed: ' + responseText.split('\r\n')[0]);
                        }

                        return Date.now() - startTime;
                    })();

                    const latency = await Promise.race([connectPromise, timeoutPromise]);

                    results.push({
                        id: outbound.id,
                        remark: outbound.remark,
                        address: outbound.address,
                        status: 'online',
                        latency
                    });
                } else {
                    throw new Error('Unsupported outbound type: ' + outbound.type);
                }
            } catch (error) {
                results.push({
                    id: outbound.id,
                    remark: outbound.remark,
                    address: outbound.address,
                    status: 'offline',
                    latency: -1,
                    error: error.message
                });
            } finally {
                // 清理资源
                try {
                    if (writer) writer.releaseLock();
                    if (reader) reader.releaseLock();
                    if (socket) socket.close();
                } catch (e) { }
            }
        }

        return json({ success: true, results });
    } catch (error) {
        return json({ error: 'Test failed: ' + error.message }, 500);
    }
}

// Telegram优选IP导入接口
async function handleTelegramImportCFIP(request, db) {
    try {
        const { address, port = 443, remark } = await request.json();

        // 验证必填字段
        if (!address) {
            return json({ error: '地址不能为空' }, 400);
        }

        // 检查是否已存在
        const existing = await db.prepare('SELECT id FROM cf_ips WHERE address = ? AND port = ?').bind(address, port).first();
        if (existing) {
            return json({ error: '该CFIP已存在', existingId: existing.id }, 409);
        }

        // 获取当前最大排序值
        const maxSort = await db.prepare('SELECT MAX(sort_order) as max FROM cf_ips').first();
        const sortOrder = (maxSort?.max || 0) + 1;

        // 插入数据
        const result = await db.prepare(
            'INSERT INTO cf_ips (address, port, remark, status, sync_blacklisted, node_blacklisted, sort_order, created_at, updated_at) VALUES (?, ?, ?, ?, 0, 0, ?, datetime("now"), datetime("now"))'
        ).bind(address, port, remark || address, 'enabled', sortOrder).run();

        return json({
            success: true,
            data: {
                id: result.meta.last_row_id,
                address,
                port,
                remark: remark || address,
                status: 'enabled',
                sync_blacklisted: 0,
                node_blacklisted: 0
            }
        });
    } catch (error) {
        return json({ error: 'Import failed: ' + error.message }, 500);
    }
}

// 修改 export default 以适配 Pages

/**
 * ACL4SSR Configuration
 */
const CONFIG = {
    rulesets: [
        { group: '🎯 全球直连', source: 'https://gh-proxy.com/https://raw.githubusercontent.com/cmliu/ACL4SSR/main/Clash/CFnat.list' },
        { group: '🎯 全球直连', source: 'https://gh-proxy.com/https://raw.githubusercontent.com/ACL4SSR/ACL4SSR/master/Clash/LocalAreaNetwork.list' },
        { group: '🎯 全球直连', source: 'https://gh-proxy.com/https://raw.githubusercontent.com/ACL4SSR/ACL4SSR/master/Clash/UnBan.list' },
        { group: '🛑 全球拦截', source: 'https://gh-proxy.com/https://raw.githubusercontent.com/ACL4SSR/ACL4SSR/master/Clash/BanAD.list' },
        { group: '🍃 应用净化', source: 'https://gh-proxy.com/https://raw.githubusercontent.com/ACL4SSR/ACL4SSR/master/Clash/BanProgramAD.list' },
        { group: '🍃 应用净化', source: 'https://gh-proxy.com/https://raw.githubusercontent.com/cmliu/ACL4SSR/main/Clash/adobe.list' },
        { group: '🍃 应用净化', source: 'https://gh-proxy.com/https://raw.githubusercontent.com/cmliu/ACL4SSR/main/Clash/IDM.list' },
        { group: '📢 谷歌FCM', source: 'https://gh-proxy.com/https://raw.githubusercontent.com/ACL4SSR/ACL4SSR/master/Clash/Ruleset/GoogleFCM.list' },
        { group: '🎯 全球直连', source: 'https://gh-proxy.com/https://raw.githubusercontent.com/ACL4SSR/ACL4SSR/master/Clash/GoogleCN.list' },
        { group: '🎯 全球直连', source: 'https://gh-proxy.com/https://raw.githubusercontent.com/ACL4SSR/ACL4SSR/master/Clash/Ruleset/SteamCN.list' },
        { group: 'Ⓜ️ 微软服务', source: 'https://gh-proxy.com/https://raw.githubusercontent.com/ACL4SSR/ACL4SSR/master/Clash/Microsoft.list' },
        { group: '🍎 苹果服务', source: 'https://gh-proxy.com/https://raw.githubusercontent.com/ACL4SSR/ACL4SSR/master/Clash/Apple.list' },
        { group: '📲 电报信息', source: 'https://gh-proxy.com/https://raw.githubusercontent.com/ACL4SSR/ACL4SSR/master/Clash/Telegram.list' },
        { group: '🤖 OpenAi', source: 'https://gh-proxy.com/https://raw.githubusercontent.com/ACL4SSR/ACL4SSR/master/Clash/Ruleset/OpenAi.list' },
        { group: '🤖 OpenAi', source: 'https://gh-proxy.com/https://raw.githubusercontent.com/juewuy/ShellClash/master/rules/ai.list' },
        { group: '🤖 OpenAi', source: 'https://gh-proxy.com/https://raw.githubusercontent.com/cmliu/ACL4SSR/main/Clash/Copilot.list' },
        { group: '🤖 OpenAi', source: 'https://gh-proxy.com/https://raw.githubusercontent.com/cmliu/ACL4SSR/main/Clash/GithubCopilot.list' },
        { group: '🤖 OpenAi', source: 'https://gh-proxy.com/https://raw.githubusercontent.com/cmliu/ACL4SSR/main/Clash/Claude.list' },
        { group: '🛸 Antigravity', source: 'https://gh-proxy.com/https://raw.githubusercontent.com/ryty1/ACL4SSR/master/Clash/antigravity.list' },
        { group: '📹 油管视频', source: 'https://gh-proxy.com/https://raw.githubusercontent.com/ACL4SSR/ACL4SSR/master/Clash/Ruleset/YouTube.list' },
        { group: '🎥 奈飞视频', source: 'https://gh-proxy.com/https://raw.githubusercontent.com/ACL4SSR/ACL4SSR/master/Clash/Ruleset/Netflix.list' },
        { group: '🌍 国外媒体', source: 'https://gh-proxy.com/https://raw.githubusercontent.com/ACL4SSR/ACL4SSR/master/Clash/ProxyMedia.list' },
        { group: '🌍 国外媒体', source: 'https://gh-proxy.com/https://raw.githubusercontent.com/cmliu/ACL4SSR/main/Clash/Emby.list' },
        { group: '🚀 节点选择', source: 'https://gh-proxy.com/https://raw.githubusercontent.com/ACL4SSR/ACL4SSR/master/Clash/ProxyLite.list' },
        { group: '🚀 节点选择', source: 'https://gh-proxy.com/https://raw.githubusercontent.com/cmliu/ACL4SSR/main/Clash/CMBlog.list' },
        { group: '🎯 全球直连', source: 'https://gh-proxy.com/https://raw.githubusercontent.com/ACL4SSR/ACL4SSR/master/Clash/ChinaDomain.list' },
        { group: '🎯 全球直连', source: 'https://gh-proxy.com/https://raw.githubusercontent.com/ACL4SSR/ACL4SSR/master/Clash/ChinaCompanyIp.list' },
        { group: '🎯 全球直连', source: 'https://gh-proxy.com/https://raw.githubusercontent.com/cmliu/ACL4SSR/main/Clash/ChinaCompanyDomain.list' },
        { group: '🎯 全球直连', source: 'https://gh-proxy.com/https://raw.githubusercontent.com/ryty1/ACL4SSR/master/Clash/zdy.list' },
        { group: '🎯 全球直连', isBuiltin: true, type: 'GEOIP', value: 'CN' },
        { group: '🐟 漏网之鱼', isBuiltin: true, type: 'FINAL' }
    ],

    proxyGroups: [
        { name: '🚀 节点选择', type: 'select', proxies: ['♻️ 自动选择', '⚖️ 负载均衡', '☑️ 手动切换', '🇭🇰 香港节点', '🇲🇴 澳门节点', '🇹🇼 台湾节点', '🇯🇵 日本节点', '🇸🇬 狮城节点', '🇰🇷 韩国节点', '🇲🇳 蒙古节点', '🇲🇾 马来节点', '🇹🇭 泰国节点', '🇻🇳 越南节点', '🇵🇭 菲律宾节点', '🇮🇩 印尼节点', '🇰🇭 柬埔寨节点', '🇲🇲 缅甸节点', '🇱🇦 老挝节点', '🇮🇳 印度节点', '🇵🇰 巴基斯坦节点', '🇧🇩 孟加拉节点', '🇰🇿 哈萨克节点', '🇦🇪 阿联酋节点', '🇸🇦 沙特节点', '🇮🇱 以色列节点', '🇹🇷 土耳其节点', '🇮🇷 伊朗节点', '🇮🇶 伊拉克节点', '🇶🇦 卡塔尔节点', '🇺🇸 美国节点', '🇨🇦 加拿大节点', '🇲🇽 墨西哥节点', '🇵🇦 巴拿马节点', '🇧🇷 巴西节点', '🇦🇷 阿根廷节点', '🇨🇱 智利节点', '🇨🇴 哥伦比亚节点', '🇵🇪 秘鲁节点', '🇻🇪 委内瑞拉节点', '🇪🇨 厄瓜多尔节点', '🇺🇾 乌拉圭节点', '🇬🇧 英国节点', '🇩🇪 德国节点', '🇫🇷 法国节点', '🇳🇱 荷兰节点', '🇧🇪 比利时节点', '🇨🇭 瑞士节点', '🇦🇹 奥地利节点', '🇮🇪 爱尔兰节点', '🇸🇪 瑞典节点', '🇳🇴 挪威节点', '🇫🇮 芬兰节点', '🇩🇰 丹麦节点', '🇮🇸 冰岛节点', '🇮🇹 意大利节点', '🇪🇸 西班牙节点', '🇵🇹 葡萄牙节点', '🇬🇷 希腊节点', '🇷🇺 俄罗斯节点', '🇺🇦 乌克兰节点', '🇧🇾 白俄罗斯节点', '🇵🇱 波兰节点', '🇨🇿 捷克节点', '🇸🇰 斯洛伐克节点', '🇭🇺 匈牙利节点', '🇷🇴 罗马尼亚节点', '🇧🇬 保加利亚节点', '🇲🇩 摩尔多瓦节点', '🇱🇻 拉脱维亚节点', '🇱🇹 立陶宛节点', '🇪🇪 爱沙尼亚节点', '🇸🇮 斯洛文尼亚节点', '🇭🇷 克罗地亚节点', '🇷🇸 塞尔维亚节点', '🇱🇺 卢森堡节点', '🇦🇺 澳洲节点', '🇳🇿 新西兰节点', '🇿🇦 南非节点', '🇪🇬 埃及节点', '🇳🇬 尼日利亚节点', '🇰🇪 肯尼亚节点', 'DIRECT'] },
        { name: '☑️ 手动切换', type: 'select', filter: '.*' },
        { name: '♻️ 自动选择', type: 'url-test', filter: '.*', url: 'http://www.gstatic.com/generate_204', interval: 300, tolerance: 50 },
        { name: '⚖️ 负载均衡', type: 'load-balance', proxies: ['☁️ Snippets'], url: 'http://www.gstatic.com/generate_204', interval: 300, strategy: 'round-robin' },
        { name: '📹 油管视频', type: 'select', proxies: ['🚀 节点选择', '♻️ 自动选择', '☑️ 手动切换', '⚖️ 负载均衡', '🇭🇰 香港节点', '🇹🇼 台湾节点', '🇯🇵 日本节点', '🇸🇬 狮城节点', '🇺🇸 美国节点', '🇰🇷 韩国节点', '🇬🇧 英国节点', '🇩🇪 德国节点', '🇫🇷 法国节点', '🇮🇳 印度节点', '🇦🇺 澳洲节点', 'DIRECT'] },
        { name: '🎥 奈飞视频', type: 'select', proxies: ['🚀 节点选择', '♻️ 自动选择', '☑️ 手动切换', '⚖️ 负载均衡', '🇭🇰 香港节点', '🇹🇼 台湾节点', '🇯🇵 日本节点', '🇸🇬 狮城节点', '🇺🇸 美国节点', '🇰🇷 韩国节点', '🇬🇧 英国节点', '🇩🇪 德国节点', '🇫🇷 法国节点', '🇮🇳 印度节点', '🇦🇺 澳洲节点', '🇨🇦 加拿大节点', 'DIRECT'] },
        { name: '🌍 国外媒体', type: 'select', proxies: ['🚀 节点选择', '♻️ 自动选择', '☑️ 手动切换', '⚖️ 负载均衡', '🇭🇰 香港节点', '🇹🇼 台湾节点', '🇯🇵 日本节点', '🇸🇬 狮城节点', '🇺🇸 美国节点', '🇰🇷 韩国节点', '🇬🇧 英国节点', '🇩🇪 德国节点', '🇫🇷 法国节点', '🇮🇳 印度节点', '🇦🇺 澳洲节点', 'DIRECT'] },
        { name: '📲 电报信息', type: 'select', proxies: ['🚀 节点选择', '☁️ Snippets', '🇭🇰 香港节点', '☑️ 手动切换', '🇹🇼 台湾节点', '🇯🇵 日本节点', '🇸🇬 狮城节点', '🇺🇸 美国节点', '🇰🇷 韩国节点', '🇬🇧 英国节点', '🇩🇪 德国节点', '🇳🇱 荷兰节点', '🇮🇳 印度节点', '🇹🇷 土耳其节点', 'DIRECT'] },
        { name: '🤖 OpenAi', type: 'select', proxies: ['🚀 节点选择', '♻️ 自动选择', '☑️ 手动切换', '🇺🇸 美国节点', '🇯🇵 日本节点', '🇸🇬 狮城节点', '🇬🇧 英国节点', '🇩🇪 德国节点', '🇫🇷 法国节点', '🇮🇳 印度节点', '🇨🇦 加拿大节点', '🇦🇺 澳洲节点', '🇳🇱 荷兰节点', '🇮🇪 爱尔兰节点', '🇫🇮 芬兰节点', '🇸🇪 瑞典节点', 'DIRECT'] },
        { name: '🛸 Antigravity', type: 'select', proxies: ['♻️ 自动选择', '☑️ 手动切换', '☁️ Snippets', '🇭🇰 香港节点', '🇹🇼 台湾节点', '🇯🇵 日本节点', '🇸🇬 狮城节点', '🇺🇸 美国节点', '🇰🇷 韩国节点', '🇬🇧 英国节点', '🇩🇪 德国节点', '🇫🇷 法国节点', '🇮🇳 印度节点', '🇹🇷 土耳其节点', '🇨🇦 加拿大节点', '🇦🇺 澳洲节点', '🇫🇮 芬兰节点', '🇸🇪 瑞典节点', '🇨🇭 瑞士节点', 'DIRECT'] },
        { name: 'Ⓜ️ 微软服务', type: 'select', proxies: ['🎯 全球直连', '🚀 节点选择', '☁️ Snippets', '🇭🇰 香港节点', '🇹🇼 台湾节点', '🇯🇵 日本节点', '🇸🇬 狮城节点', '🇺🇸 美国节点', '🇰🇷 韩国节点', '🇬🇧 英国节点', '🇩🇪 德国节点', '🇫🇷 法国节点', '🇮🇳 印度节点', '🇦🇺 澳洲节点', 'DIRECT'] },
        { name: '🍎 苹果服务', type: 'select', proxies: ['🎯 全球直连', '🚀 节点选择', '☁️ Snippets', '🇭🇰 香港节点', '🇹🇼 台湾节点', '🇯🇵 日本节点', '🇸🇬 狮城节点', '🇺🇸 美国节点', '🇰🇷 韩国节点', '🇬🇧 英国节点', '🇮🇳 印度节点', '🇦🇺 澳洲节点', 'DIRECT'] },
        { name: '📢 谷歌FCM', type: 'select', proxies: ['🚀 节点选择', '🎯 全球直连', '♻️ 自动选择', '☑️ 手动切换', '☁️ Snippets', '🇭🇰 香港节点', '🇹🇼 台湾节点', '🇯🇵 日本节点', '🇸🇬 狮城节点', '🇺🇸 美国节点', '🇰🇷 韩国节点', '🇬🇧 英国节点', '🇩🇪 德国节点', '🇮🇳 印度节点', 'DIRECT'] },
        { name: '🎯 全球直连', type: 'select', proxies: ['DIRECT', '🚀 节点选择', '♻️ 自动选择', '☑️ 手动切换'] },
        { name: '🛑 全球拦截', type: 'select', proxies: ['REJECT', 'DIRECT'] },
        { name: '🍃 应用净化', type: 'select', proxies: ['REJECT', 'DIRECT'] },
        { name: '🐟 漏网之鱼', type: 'select', proxies: ['🚀 节点选择', '🎯 全球直连', '♻️ 自动选择', '☑️ 手动切换', '🇭🇰 香港节点', '🇹🇼 台湾节点', '🇯🇵 日本节点', '🇸🇬 狮城节点', '🇺🇸 美国节点', '🇰🇷 韩国节点', '🇬🇧 英国节点', '🇩🇪 德国节点', '🇫🇷 法国节点', '🇳🇱 荷兰节点', '🇮🇳 印度节点', '🇫🇮 芬兰节点', 'DIRECT'] },
        { name: '☁️ Snippets', type: 'select', filter: '(snippets|Snippets|Sni|sni|Snip|snip)' },
        { name: '🇭🇰 香港节点', type: 'select', filter: '(港|HK|hk|Hong Kong|HongKong|hongkong|HKG)' },
        { name: '🇲🇴 澳门节点', type: 'select', filter: '(澳门|MO|Macau|macao)' },
        { name: '🇹🇼 台湾节点', type: 'select', filter: '(台|新北|彰化|TW|Taiwan|taipei)' },
        { name: '🇯🇵 日本节点', type: 'select', filter: '(日本|川日|东京|大阪|泉日|埼玉|沪日|深日|[^-]日|JP|Japan|tokyo|osaka)' },
        { name: '🇰🇷 韩国节点', type: 'select', filter: '(韩国|韩|KR|Korea|KOR|首尔|seoul|春川)' },
        { name: '🇲🇳 蒙古节点', type: 'select', filter: '(蒙古|Mongolia|乌兰巴托)' },
        { name: '🇸🇬 狮城节点', type: 'select', filter: '(新加坡|坡|狮城|SG|Singapore)' },
        { name: '🇲🇾 马来节点', type: 'select', filter: '(马来西亚|马来|MY|Malaysia|吉隆坡)' },
        { name: '🇹🇭 泰国节点', type: 'select', filter: '(泰国|TH|Thailand|曼谷)' },
        { name: '🇻🇳 越南节点', type: 'select', filter: '(越南|VN|Vietnam|胡志明|河内)' },
        { name: '🇵🇭 菲律宾节点', type: 'select', filter: '(菲律宾|PH|Philippines|马尼拉)' },
        { name: '🇮🇩 印尼节点', type: 'select', filter: '(印度尼西亚|印尼|ID|Indonesia|雅加达)' },
        { name: '🇰🇭 柬埔寨节点', type: 'select', filter: '(柬埔寨|Cambodia|金边)' },
        { name: '🇲🇲 缅甸节点', type: 'select', filter: '(缅甸|Myanmar|仰光)' },
        { name: '🇱🇦 老挝节点', type: 'select', filter: '(老挝|Laos|万象)' },
        { name: '🇧🇳 文莱节点', type: 'select', filter: '(文莱|Brunei)' },
        { name: '🇹🇱 东帝汶节点', type: 'select', filter: '(东帝汶|Timor-Leste)' },
        { name: '🇮🇳 印度节点', type: 'select', filter: '(印度|India|孟买|新德里|Mumbai|Delhi)' },
        { name: '🇵🇰 巴基斯坦节点', type: 'select', filter: '(巴基斯坦|Pakistan|卡拉奇|伊斯兰堡)' },
        { name: '🇧🇩 孟加拉节点', type: 'select', filter: '(孟加拉|Bangladesh|达卡)' },
        { name: '🇳🇵 尼泊尔节点', type: 'select', filter: '(尼泊尔|Nepal|加德满都)' },
        { name: '🇱🇰 斯里兰卡节点', type: 'select', filter: '(斯里兰卡|Sri Lanka|科伦坡)' },
        { name: '🇧🇹 不丹节点', type: 'select', filter: '(不丹|Bhutan)' },
        { name: '🇲🇻 马尔代夫节点', type: 'select', filter: '(马尔代夫|Maldives|马累)' },
        { name: '🇦🇫 阿富汗节点', type: 'select', filter: '(阿富汗|Afghanistan|喀布尔)' },
        { name: '🇰🇿 哈萨克节点', type: 'select', filter: '(哈萨克斯坦|哈萨克|Kazakhstan|阿拉木图)' },
        { name: '🇺🇿 乌兹别克节点', type: 'select', filter: '(乌兹别克斯坦|乌兹别克|Uzbekistan|塔什干)' },
        { name: '🇹🇲 土库曼节点', type: 'select', filter: '(土库曼斯坦|土库曼|Turkmenistan)' },
        { name: '🇹🇯 塔吉克节点', type: 'select', filter: '(塔吉克斯坦|塔吉克|Tajikistan)' },
        { name: '🇰🇬 吉尔吉斯节点', type: 'select', filter: '(吉尔吉斯斯坦|吉尔吉斯|Kyrgyzstan)' },
        { name: '🇦🇿 阿塞拜疆节点', type: 'select', filter: '(阿塞拜疆|Azerbaijan|巴库)' },
        { name: '🇦🇲 亚美尼亚节点', type: 'select', filter: '(亚美尼亚|Armenia|埃里温)' },
        { name: '🇬🇪 格鲁吉亚节点', type: 'select', filter: '(格鲁吉亚|Georgia|第比利斯)' },
        { name: '🇦🇪 阿联酋节点', type: 'select', filter: '(阿联酋|United Arab Emirates|迪拜|Dubai|阿布扎比)' },
        { name: '🇸🇦 沙特节点', type: 'select', filter: '(沙特|Saudi Arabia|沙特阿拉伯|利雅得)' },
        { name: '🇮🇱 以色列节点', type: 'select', filter: '(以色列|Israel|特拉维夫)' },
        { name: '🇹🇷 土耳其节点', type: 'select', filter: '(土耳其|Turkey|伊斯坦布尔|安卡拉)' },
        { name: '🇮🇷 伊朗节点', type: 'select', filter: '(伊朗|Iran|德黑兰)' },
        { name: '🇮🇶 伊拉克节点', type: 'select', filter: '(伊拉克|Iraq|巴格达)' },
        { name: '🇶🇦 卡塔尔节点', type: 'select', filter: '(卡塔尔|Qatar|多哈)' },
        { name: '🇰🇼 科威特节点', type: 'select', filter: '(科威特|Kuwait)' },
        { name: '🇴🇲 阿曼节点', type: 'select', filter: '(阿曼|Oman|马斯喀特)' },
        { name: '🇧🇭 巴林节点', type: 'select', filter: '(巴林|Bahrain|麦纳麦)' },
        { name: '🇯🇴 约旦节点', type: 'select', filter: '(约旦|Jordan|安曼)' },
        { name: '🇱🇧 黎巴嫩节点', type: 'select', filter: '(黎巴嫩|Lebanon|贝鲁特)' },
        { name: '🇸🇾 叙利亚节点', type: 'select', filter: '(叙利亚|Syria|大马士革)' },
        { name: '🇾🇪 也门节点', type: 'select', filter: '(也门|Yemen|萨那)' },
        { name: '🇵🇸 巴勒斯坦节点', type: 'select', filter: '(巴勒斯坦|Palestine)' },
        { name: '🇺🇸 美国节点', type: 'select', filter: '(美国|美|波特兰|达拉斯|俄勒冈|凤凰城|费利蒙|硅谷|拉斯维加斯|洛杉矶|圣何塞|圣克拉拉|西雅图|芝加哥|US|USA|United States|ATL|BUF|DFW|EWR|IAD|LAX|MCI|MIA|ORD|PHX|PDX|SEA|SJC)' },
        { name: '🇨🇦 加拿大节点', type: 'select', filter: '(加拿大|CA|Canada|多伦多|温哥华|蒙特利尔)' },
        { name: '🇲🇽 墨西哥节点', type: 'select', filter: '(墨西哥|Mexico|墨城)' },
        { name: '🇵🇦 巴拿马节点', type: 'select', filter: '(巴拿马|Panama)' },
        { name: '🇨🇷 哥斯达黎加节点', type: 'select', filter: '(哥斯达黎加|Costa Rica)' },
        { name: '🇬🇹 危地马拉节点', type: 'select', filter: '(危地马拉|Guatemala)' },
        { name: '🇭🇳 洪都拉斯节点', type: 'select', filter: '(洪都拉斯|Honduras)' },
        { name: '🇳🇮 尼加拉瓜节点', type: 'select', filter: '(尼加拉瓜|Nicaragua)' },
        { name: '🇸🇻 萨尔瓦多节点', type: 'select', filter: '(萨尔瓦多|El Salvador)' },
        { name: '🇧🇿 伯利兹节点', type: 'select', filter: '(伯利兹|Belize)' },
        { name: '🇨🇺 古巴节点', type: 'select', filter: '(古巴|Cuba|哈瓦那)' },
        { name: '🇩🇴 多米尼加节点', type: 'select', filter: '(多米尼加|Dominican|圣多明各)' },
        { name: '🇯🇲 牙买加节点', type: 'select', filter: '(牙买加|Jamaica|金斯敦)' },
        { name: '🇭🇹 海地节点', type: 'select', filter: '(海地|Haiti)' },
        { name: '🇧🇸 巴哈马节点', type: 'select', filter: '(巴哈马|Bahamas)' },
        { name: '🇧🇧 巴巴多斯节点', type: 'select', filter: '(巴巴多斯|Barbados)' },
        { name: '🇹🇹 特立尼达节点', type: 'select', filter: '(特立尼达|Trinidad)' },
        { name: '🇵🇷 波多黎各节点', type: 'select', filter: '(波多黎各|Puerto Rico)' },
        { name: '🇧🇷 巴西节点', type: 'select', filter: '(巴西|Brazil|圣保罗|里约)' },
        { name: '🇦🇷 阿根廷节点', type: 'select', filter: '(阿根廷|Argentina|布宜诺斯艾利斯)' },
        { name: '🇨🇱 智利节点', type: 'select', filter: '(智利|Chile|圣地亚哥)' },
        { name: '🇨🇴 哥伦比亚节点', type: 'select', filter: '(哥伦比亚|Colombia|波哥大)' },
        { name: '🇵🇪 秘鲁节点', type: 'select', filter: '(秘鲁|Peru|利马)' },
        { name: '🇻🇪 委内瑞拉节点', type: 'select', filter: '(委内瑞拉|Venezuela|加拉加斯)' },
        { name: '🇪🇨 厄瓜多尔节点', type: 'select', filter: '(厄瓜多尔|Ecuador|基多)' },
        { name: '🇺🇾 乌拉圭节点', type: 'select', filter: '(乌拉圭|Uruguay|蒙得维的亚)' },
        { name: '🇧🇴 玻利维亚节点', type: 'select', filter: '(玻利维亚|Bolivia|拉巴斯)' },
        { name: '🇵🇾 巴拉圭节点', type: 'select', filter: '(巴拉圭|Paraguay|亚松森)' },
        { name: '🇬🇾 圭亚那节点', type: 'select', filter: '(圭亚那|Guyana)' },
        { name: '🇸🇷 苏里南节点', type: 'select', filter: '(苏里南|Suriname)' },
        { name: '🇬🇫 法属圭亚那节点', type: 'select', filter: '(法属圭亚那|French Guiana)' },
        { name: '🇬🇧 英国节点', type: 'select', filter: '(英国|UK|GB|United Kingdom|Britain|伦敦|London|曼彻斯特)' },
        { name: '🇩🇪 德国节点', type: 'select', filter: '(德国|DE|Germany|法兰克福|柏林|慕尼黑|Frankfurt)' },
        { name: '🇫🇷 法国节点', type: 'select', filter: '(法国|FR|France|巴黎|Paris|马赛)' },
        { name: '🇳🇱 荷兰节点', type: 'select', filter: '(荷兰|NL|Netherlands|阿姆斯特丹|Amsterdam)' },
        { name: '🇧🇪 比利时节点', type: 'select', filter: '(比利时|Belgium|布鲁塞尔)' },
        { name: '🇱🇺 卢森堡节点', type: 'select', filter: '(卢森堡|Luxembourg)' },
        { name: '🇨🇭 瑞士节点', type: 'select', filter: '(瑞士|Switzerland|苏黎世|日内瓦)' },
        { name: '🇦🇹 奥地利节点', type: 'select', filter: '(奥地利|Austria|维也纳)' },
        { name: '🇮🇪 爱尔兰节点', type: 'select', filter: '(爱尔兰|Ireland|都柏林)' },
        { name: '🇲🇨 摩纳哥节点', type: 'select', filter: '(摩纳哥|Monaco)' },
        { name: '🇱🇮 列支敦士登节点', type: 'select', filter: '(列支敦士登|Liechtenstein)' },
        { name: '🇦🇩 安道尔节点', type: 'select', filter: '(安道尔|Andorra)' },
        { name: '🇸🇪 瑞典节点', type: 'select', filter: '(瑞典|Sweden|斯德哥尔摩)' },
        { name: '🇳🇴 挪威节点', type: 'select', filter: '(挪威|Norway|奥斯陆)' },
        { name: '🇫🇮 芬兰节点', type: 'select', filter: '(芬兰|Finland|赫尔辛基)' },
        { name: '🇩🇰 丹麦节点', type: 'select', filter: '(丹麦|Denmark|哥本哈根)' },
        { name: '🇮🇸 冰岛节点', type: 'select', filter: '(冰岛|Iceland|雷克雅未克)' },
        { name: '🇫🇴 法罗群岛节点', type: 'select', filter: '(法罗群岛|Faroe)' },
        { name: '🇬🇱 格陵兰节点', type: 'select', filter: '(格陵兰|Greenland)' },
        { name: '🇮🇹 意大利节点', type: 'select', filter: '(意大利|Italy|米兰|罗马|都灵)' },
        { name: '🇪🇸 西班牙节点', type: 'select', filter: '(西班牙|Spain|马德里|巴塞罗那)' },
        { name: '🇵🇹 葡萄牙节点', type: 'select', filter: '(葡萄牙|Portugal|里斯本)' },
        { name: '🇬🇷 希腊节点', type: 'select', filter: '(希腊|Greece|雅典)' },
        { name: '🇨🇾 塞浦路斯节点', type: 'select', filter: '(塞浦路斯|Cyprus|尼科西亚)' },
        { name: '🇲🇹 马耳他节点', type: 'select', filter: '(马耳他|Malta|瓦莱塔)' },
        { name: '🇸🇲 圣马力诺节点', type: 'select', filter: '(圣马力诺|San Marino)' },
        { name: '🇻🇦 梵蒂冈节点', type: 'select', filter: '(梵蒂冈|Vatican)' },
        { name: '🇦🇱 阿尔巴尼亚节点', type: 'select', filter: '(阿尔巴尼亚|Albania|地拉那)' },
        { name: '🇲🇰 北马其顿节点', type: 'select', filter: '(北马其顿|马其顿|North Macedonia)' },
        { name: '🇽🇰 科索沃节点', type: 'select', filter: '(科索沃|Kosovo)' },
        { name: '🇲🇪 黑山节点', type: 'select', filter: '(黑山|Montenegro)' },
        { name: '🇧🇦 波黑节点', type: 'select', filter: '(波黑|波斯尼亚|Bosnia)' },
        { name: '🇷🇺 俄罗斯节点', type: 'select', filter: '(俄罗斯|俄|RU|Russia|莫斯科|圣彼得堡|Moscow)' },
        { name: '🇺🇦 乌克兰节点', type: 'select', filter: '(乌克兰|Ukraine|基辅)' },
        { name: '🇧🇾 白俄罗斯节点', type: 'select', filter: '(白俄罗斯|Belarus|明斯克)' },
        { name: '🇵🇱 波兰节点', type: 'select', filter: '(波兰|Poland|华沙)' },
        { name: '🇨🇿 捷克节点', type: 'select', filter: '(捷克|Czech|布拉格)' },
        { name: '🇸🇰 斯洛伐克节点', type: 'select', filter: '(斯洛伐克|Slovakia|布拉迪斯拉发)' },
        { name: '🇭🇺 匈牙利节点', type: 'select', filter: '(匈牙利|Hungary|布达佩斯)' },
        { name: '🇷🇴 罗马尼亚节点', type: 'select', filter: '(罗马尼亚|Romania|布加勒斯特)' },
        { name: '🇧🇬 保加利亚节点', type: 'select', filter: '(保加利亚|Bulgaria|索非亚)' },
        { name: '🇲🇩 摩尔多瓦节点', type: 'select', filter: '(摩尔多瓦|Moldova|基希讷乌)' },
        { name: '🇱🇻 拉脱维亚节点', type: 'select', filter: '(拉脱维亚|Latvia|里加)' },
        { name: '🇱🇹 立陶宛节点', type: 'select', filter: '(立陶宛|Lithuania|维尔纽斯)' },
        { name: '🇪🇪 爱沙尼亚节点', type: 'select', filter: '(爱沙尼亚|Estonia|塔林)' },
        { name: '🇸🇮 斯洛文尼亚节点', type: 'select', filter: '(斯洛文尼亚|Slovenia|卢布尔雅那)' },
        { name: '🇭🇷 克罗地亚节点', type: 'select', filter: '(克罗地亚|Croatia|萨格勒布)' },
        { name: '🇷🇸 塞尔维亚节点', type: 'select', filter: '(塞尔维亚|Serbia|贝尔格莱德)' },
        { name: '🇦🇺 澳洲节点', type: 'select', filter: '(澳洲|澳大利亚|AU|Australia|悉尼|墨尔本|Sydney|Melbourne)' },
        { name: '🇳🇿 新西兰节点', type: 'select', filter: '(新西兰|New Zealand|奥克兰)' },
        { name: '🇫🇯 斐济节点', type: 'select', filter: '(斐济|Fiji|苏瓦)' },
        { name: '🇵🇬 巴新节点', type: 'select', filter: '(巴布亚新几内亚|巴新|Papua New Guinea)' },
        { name: '🇼🇸 萨摩亚节点', type: 'select', filter: '(萨摩亚|Samoa)' },
        { name: '🇹🇴 汤加节点', type: 'select', filter: '(汤加|Tonga)' },
        { name: '🇻🇺 瓦努阿图节点', type: 'select', filter: '(瓦努阿图|Vanuatu)' },
        { name: '🇸🇧 所罗门群岛节点', type: 'select', filter: '(所罗门群岛|Solomon)' },
        { name: '🇳🇨 新喀里多尼亚节点', type: 'select', filter: '(新喀里多尼亚|New Caledonia)' },
        { name: '🇵🇫 法属波利尼西亚节点', type: 'select', filter: '(法属波利尼西亚|French Polynesia|大溪地)' },
        { name: '🇬🇺 关岛节点', type: 'select', filter: '(关岛|Guam)' },
        { name: '🇪🇬 埃及节点', type: 'select', filter: '(埃及|Egypt|开罗)' },
        { name: '🇱🇾 利比亚节点', type: 'select', filter: '(利比亚|Libya|的黎波里)' },
        { name: '🇹🇳 突尼斯节点', type: 'select', filter: '(突尼斯|Tunisia|突尼斯城)' },
        { name: '🇩🇿 阿尔及利亚节点', type: 'select', filter: '(阿尔及利亚|Algeria|阿尔及尔)' },
        { name: '🇲🇦 摩洛哥节点', type: 'select', filter: '(摩洛哥|Morocco|卡萨布兰卡)' },
        { name: '🇸🇩 苏丹节点', type: 'select', filter: '(苏丹|Sudan|喀土穆)' },
        { name: '🇳🇬 尼日利亚节点', type: 'select', filter: '(尼日利亚|Nigeria|拉各斯)' },
        { name: '🇬🇭 加纳节点', type: 'select', filter: '(加纳|Ghana|阿克拉)' },
        { name: '🇸🇳 塞内加尔节点', type: 'select', filter: '(塞内加尔|Senegal|达喀尔)' },
        { name: '🇨🇮 科特迪瓦节点', type: 'select', filter: '(科特迪瓦|象牙海岸|Ivory Coast|Cote)' },
        { name: '🇲🇱 马里节点', type: 'select', filter: '(马里|Mali|巴马科)' },
        { name: '🇧🇫 布基纳法索节点', type: 'select', filter: '(布基纳法索|Burkina Faso)' },
        { name: '🇳🇪 尼日尔节点', type: 'select', filter: '(尼日尔|Niger)' },
        { name: '🇬🇳 几内亚节点', type: 'select', filter: '(几内亚|Guinea)' },
        { name: '🇹🇬 多哥节点', type: 'select', filter: '(多哥|Togo)' },
        { name: '🇧🇯 贝宁节点', type: 'select', filter: '(贝宁|Benin)' },
        { name: '🇱🇷 利比里亚节点', type: 'select', filter: '(利比里亚|Liberia)' },
        { name: '🇸🇱 塞拉利昂节点', type: 'select', filter: '(塞拉利昂|Sierra Leone)' },
        { name: '🇲🇷 毛里塔尼亚节点', type: 'select', filter: '(毛里塔尼亚|Mauritania)' },
        { name: '🇬🇲 冈比亚节点', type: 'select', filter: '(冈比亚|Gambia)' },
        { name: '🇨🇻 佛得角节点', type: 'select', filter: '(佛得角|Cape Verde)' },
        { name: '🇨🇲 喀麦隆节点', type: 'select', filter: '(喀麦隆|Cameroon|雅温得)' },
        { name: '🇨🇩 刚果金节点', type: 'select', filter: '(刚果民主共和国|刚果金|DR Congo)' },
        { name: '🇨🇬 刚果共和国', type: 'select', filter: '(刚果共和国|刚果布|Congo)' },
        { name: '🇨🇫 中非节点', type: 'select', filter: '(中非共和国|中非|Central African)' },
        { name: '🇹🇩 乍得节点', type: 'select', filter: '(乍得|Chad)' },
        { name: '🇬🇦 加蓬节点', type: 'select', filter: '(加蓬|Gabon)' },
        { name: '🇬🇶 赤道几内亚节点', type: 'select', filter: '(赤道几内亚|Equatorial Guinea)' },
        { name: '🇰🇪 肯尼亚节点', type: 'select', filter: '(肯尼亚|Kenya|内罗毕)' },
        { name: '🇹🇿 坦桑尼亚节点', type: 'select', filter: '(坦桑尼亚|Tanzania|达累斯萨拉姆)' },
        { name: '🇺🇬 乌干达节点', type: 'select', filter: '(乌干达|Uganda|坎帕拉)' },
        { name: '🇷🇼 卢旺达节点', type: 'select', filter: '(卢旺达|Rwanda|基加利)' },
        { name: '🇧🇮 布隆迪节点', type: 'select', filter: '(布隆迪|Burundi)' },
        { name: '🇪🇹 埃塞俄比亚节点', type: 'select', filter: '(埃塞俄比亚|Ethiopia|亚的斯亚贝巴)' },
        { name: '🇪🇷 厄立特里亚节点', type: 'select', filter: '(厄立特里亚|Eritrea)' },
        { name: '🇩🇯 吉布提节点', type: 'select', filter: '(吉布提|Djibouti)' },
        { name: '🇸🇴 索马里节点', type: 'select', filter: '(索马里|Somalia)' },
        { name: '🇲🇬 马达加斯加节点', type: 'select', filter: '(马达加斯加|Madagascar)' },
        { name: '🇲🇺 毛里求斯节点', type: 'select', filter: '(毛里求斯|Mauritius)' },
        { name: '🇸🇨 塞舌尔节点', type: 'select', filter: '(塞舌尔|Seychelles)' },
        { name: '🇰🇲 科摩罗节点', type: 'select', filter: '(科摩罗|Comoros)' },
        { name: '🇷🇪 留尼汪节点', type: 'select', filter: '(留尼汪|Reunion)' },
        { name: '🇿🇦 南非节点', type: 'select', filter: '(南非|South Africa|约翰内斯堡|开普敦)' },
        { name: '🇿🇼 津巴布韦节点', type: 'select', filter: '(津巴布韦|Zimbabwe|哈拉雷)' },
        { name: '🇿🇲 赞比亚节点', type: 'select', filter: '(赞比亚|Zambia|卢萨卡)' },
        { name: '🇲🇼 马拉维节点', type: 'select', filter: '(马拉维|Malawi)' },
        { name: '🇲🇿 莫桑比克节点', type: 'select', filter: '(莫桑比克|Mozambique|马普托)' },
        { name: '🇧🇼 博茨瓦纳节点', type: 'select', filter: '(博茨瓦纳|Botswana)' },
        { name: '🇳🇦 纳米比亚节点', type: 'select', filter: '(纳米比亚|Namibia|温得和克)' },
        { name: '🇦🇴 安哥拉节点', type: 'select', filter: '(安哥拉|Angola|罗安达)' },
        { name: '🇸🇿 斯威士兰节点', type: 'select', filter: '(斯威士兰|Eswatini|Swaziland)' },
        { name: '🇱🇸 莱索托节点', type: 'select', filter: '(莱索托|Lesotho)' }
    ]
};

/**
 * Subscription Parser
 */
class SubParser {
    // UTF-8 safe Base64 decode
    base64DecodeUtf8(str) {
        try {
            const binaryStr = atob(str);
            const bytes = new Uint8Array(binaryStr.length);
            for (let i = 0; i < binaryStr.length; i++) {
                bytes[i] = binaryStr.charCodeAt(i);
            }
            return new TextDecoder('utf-8').decode(bytes);
        } catch (e) {
            return atob(str); // fallback
        }
    }

    parse(content) {
        const trimmed = content.trim();

        // Try YAML
        if (trimmed.startsWith('proxies:') || trimmed.includes('\nproxies:')) {
            return this.parseYaml(content);
        }

        // Try Base64
        try {
            const decoded = this.base64DecodeUtf8(trimmed);
            if (decoded.includes('://') || decoded.includes('\n')) {
                return this.parseUriList(decoded);
            }
        } catch (e) { }

        // Try URI list
        if (trimmed.includes('://')) {
            return this.parseUriList(trimmed);
        }

        return [];
    }

    parseYaml(content) {
        try {
            const match = content.match(/proxies:\s*\n([\s\S]+?)(?:\nproxy-groups:|$)/);
            if (!match) return [];

            const proxiesSection = match[1];
            const proxies = [];
            const proxyMatches = proxiesSection.matchAll(/^\s*-\s*\{([^}]+)\}/gm);

            for (const m of proxyMatches) {
                try {
                    const proxyStr = `{${m[1]}}`;
                    const proxy = this.parseYamlProxy(proxyStr);
                    if (proxy) proxies.push(proxy);
                } catch (e) { }
            }

            return proxies;
        } catch (e) {
            return [];
        }
    }

    parseYamlProxy(str) {
        const obj = {};
        const pairs = str.slice(1, -1).split(',');
        for (const pair of pairs) {
            const [key, ...vals] = pair.split(':');
            if (key && vals.length) {
                obj[key.trim()] = vals.join(':').trim().replace(/^["']|["']$/g, '');
            }
        }
        return obj.name ? obj : null;
    }

    parseUriList(content) {
        const proxies = [];
        const lines = content.split('\n').filter(l => l.trim());

        for (const line of lines) {
            const proxy = this.parseUri(line.trim());
            if (proxy) proxies.push(proxy);
        }

        return proxies;
    }

    parseUri(uri) {
        if (uri.startsWith('v' + 'mess://')) return this.parseVm(uri);
        if (uri.startsWith('v' + 'less://')) return this.parseVl(uri);
        if (uri.startsWith('trojan://')) return this.parseTrojan(uri);
        if (uri.startsWith('ss://')) return this.parseShadowsocks(uri);
        if (uri.startsWith('hysteria2://') || uri.startsWith('hy2://')) return this.parseHysteria2(uri);
        if (uri.startsWith('tuic://')) return this.parseTuic(uri);
        return null;
    }

    parseVm(uri) {
        try {
            const encoded = uri.replace('v' + 'mess://', '');
            const decoded = atob(encoded);
            const config = JSON.parse(decoded);

            const proxy = {
                name: config.ps || config.name || 'VM' + 'ess',
                type: 'vm' + 'ess',
                server: config.add || config.server,
                port: parseInt(config.port),
                uuid: config.id || config.uuid,
                alterId: parseInt(config.aid) || 0,
                cipher: config.scy || 'auto',
                tls: config.tls === 'tls',
                'skip-cert-verify': true,
                network: config.net || 'tcp'
            };

            if (config.net === 'ws') {
                proxy['ws-opts'] = {
                    path: config.path || '/',
                    headers: config.host ? { Host: config.host } : {}
                };
            }

            return proxy;
        } catch (e) {
            return null;
        }
    }

    parseVl(uri) {
        try {
            const url = new URL(uri);
            const params = url.searchParams;

            const proxy = {
                name: decodeURIComponent(url.hash.substring(1)) || 'V<span>LESS</span>',
                type: 'vl' + 'ess',
                server: url.hostname,
                port: parseInt(url.port) || 443,
                uuid: url.username,
                tls: params.get('security') === 'tls' || params.get('security') === 'reality',
                'skip-cert-verify': false,
                network: params.get('type') || 'tcp'
            };

            // 解析 flow (xtls-rprx-vision 等)
            const flow = params.get('flow');
            if (flow) {
                proxy.flow = flow;
            }

            // 解析 client-fingerprint (fp 参数)
            const fingerprint = params.get('fp');
            if (fingerprint) {
                proxy['client-fingerprint'] = fingerprint;
            }

            if (proxy.tls) {
                proxy.servername = params.get('sni') || url.hostname;
                if (params.get('security') === 'reality') {
                    proxy['reality-opts'] = {
                        'public-key': params.get('pbk'),
                        'short-id': params.get('sid') || ''
                    };
                }
            }

            if (proxy.network === 'ws') {
                const host = params.get('host') || params.get('sni') || url.hostname;
                proxy['ws-opts'] = {
                    path: params.get('path') || '/',
                    headers: host ? { Host: host } : {}
                };
            }

            return proxy;
        } catch (e) {
            return null;
        }
    }

    parseTrojan(uri) {
        try {
            const url = new URL(uri);
            const params = url.searchParams;

            const proxy = {
                name: decodeURIComponent(url.hash.substring(1)) || 'Trojan',
                type: 'trojan',
                server: url.hostname,
                port: parseInt(url.port) || 443,
                password: url.username,
                sni: params.get('sni') || url.hostname,
                'skip-cert-verify': true,
                network: params.get('type') || 'tcp'
            };

            if (proxy.network === 'ws') {
                proxy['ws-opts'] = {
                    path: params.get('path') || '/',
                    headers: params.get('host') ? { Host: params.get('host') } : {}
                };
            }

            return proxy;
        } catch (e) {
            return null;
        }
    }

    parseShadowsocks(uri) {
        try {
            const urlObj = new URL(uri);
            const params = urlObj.searchParams;
            let content = uri.replace('ss://', '').split('?')[0];
            let name = decodeURIComponent(urlObj.hash.substring(1)) || 'Shadowsocks';

            let method, password, server, port;

            if (content.includes('@')) {
                const [authPart, serverPart] = content.split('@');
                try {
                    const decoded = atob(authPart);
                    [method, password] = decoded.split(':');
                } catch {
                    [method, password] = authPart.split(':');
                }
                const [s, p] = serverPart.split(':');
                server = s;
                port = p;
            } else {
                try {
                    const decoded = atob(content);
                    const atIndex = decoded.lastIndexOf('@');
                    const [authPart, serverPart] = [decoded.substring(0, atIndex), decoded.substring(atIndex + 1)];
                    [method, password] = authPart.split(':');
                    const colonIndex = serverPart.lastIndexOf(':');
                    server = serverPart.substring(0, colonIndex);
                    port = serverPart.substring(colonIndex + 1);
                } catch (e) {
                    return null;
                }
            }

            const proxy = {
                name,
                type: 'ss',
                server,
                port: parseInt(port),
                cipher: method,
                password
            };

            let pluginStr = params.get('plugin');

            const match = uri.match(/[?&]plugin=([^#]+)/);
            if (match) {
                const rawPlugin = match[1];
                if (rawPlugin.includes('path=') || rawPlugin.includes('path%3D') ||
                    rawPlugin.includes('obfs-host=') || rawPlugin.includes('obfs-host%3D') ||
                    rawPlugin.includes('host=') || rawPlugin.includes('host%3D') ||
                    rawPlugin.includes('tls')) {
                    pluginStr = rawPlugin;
                }
            }

            if (pluginStr) {
                const pluginParts = decodeURIComponent(pluginStr).split(';');
                proxy.plugin = pluginParts[0];
                proxy['plugin-opts'] = {};

                for (let i = 1; i < pluginParts.length; i++) {
                    const part = pluginParts[i];
                    const equalsIndex = part.indexOf('=');
                    if (equalsIndex !== -1) {
                        const key = part.substring(0, equalsIndex);
                        let val = part.substring(equalsIndex + 1);
                        try {
                            if (val.includes('%')) {
                                val = decodeURIComponent(val);
                            }
                        } catch (e) { }
                        proxy['plugin-opts'][key] = val;
                    } else {
                        proxy['plugin-opts'][part] = true;
                    }
                }

                if (proxy.plugin === 'v2ray-plugin' || proxy.plugin === 'obfs-local') {
                    if (proxy['plugin-opts'].tls === 'true' || proxy['plugin-opts'].tls === true) {
                        proxy['plugin-opts'].tls = true;
                        if (proxy['skip-cert-verify'] === true || proxy['plugin-opts']['skip-cert-verify'] === 'true') {
                            proxy['plugin-opts'].allowInsecure = true;
                        }
                    }

                    proxy['plugin-opts'].mux = false;

                    if (proxy['plugin-opts'].host) {
                        proxy['plugin-opts'].peer = proxy['plugin-opts'].host;
                    } else if (params.get('sni')) {
                        proxy['plugin-opts'].peer = params.get('sni');
                        proxy['plugin-opts'].host = params.get('sni');
                    }
                }
            }

            const fingerprint = params.get('fingerprint') || params.get('client-fingerprint');
            if (fingerprint) {
                proxy['client-fingerprint'] = fingerprint;
            }

            return proxy;
        } catch (e) {
            return null;
        }
    }

    parseHysteria2(uri) {
        try {
            const url = new URL(uri.replace('hy2://', 'hysteria2://'));
            const params = url.searchParams;

            return {
                name: decodeURIComponent(url.hash.substring(1)) || 'Hysteria2',
                type: 'hysteria2',
                server: url.hostname,
                port: parseInt(url.port) || 443,
                password: url.username,
                sni: params.get('sni') || url.hostname,
                'skip-cert-verify': true
            };
        } catch (e) {
            return null;
        }
    }

    parseTuic(uri) {
        try {
            const url = new URL(uri);
            const params = url.searchParams;
            const [uuid, password] = url.username.split(':');

            return {
                name: decodeURIComponent(url.hash.substring(1)) || 'TUIC',
                type: 'tuic',
                server: url.hostname,
                port: parseInt(url.port) || 443,
                uuid: uuid,
                password: password || url.password,
                sni: params.get('sni') || url.hostname,
                'skip-cert-verify': true,
                'congestion-controller': params.get('congestion_control') || 'bbr'
            };
        } catch (e) {
            return null;
        }
    }

    addEmoji(proxy) {
        const name = proxy.name;
        const emojiMap = {
            '🇭🇰': ['香港', 'HK', 'hk', 'Hong Kong', 'HongKong', 'hongkong', 'HKG'],
            '🇲🇴': ['澳门', 'MO', 'Macau', 'macao'],
            '🇹🇼': ['台湾', '新北', '彰化', 'TW', 'Taiwan', 'taipei'],
            '🇯🇵': ['日本', '川日', '东京', '大阪', '泉日', '埼玉', '沪日', '深日', '[^-]日', 'JP', 'Japan', 'tokyo', 'osaka'],
            '🇰🇷': ['韩国', '韩', 'KR', 'Korea', 'KOR', '首尔', 'seoul', '春川'],
            '🇲🇳': ['蒙古', 'Mongolia', '乌兰巴托'],
            '🇸🇬': ['新加坡', '坡', '狮城', 'SG', 'Singapore'],
            '🇲🇾': ['马来西亚', '马来', 'MY', 'Malaysia', '吉隆坡'],
            '🇹🇭': ['泰国', 'TH', 'Thailand', '曼谷'],
            '🇻🇳': ['越南', 'VN', 'Vietnam', '胡志明', '河内'],
            '🇵🇭': ['菲律宾', 'PH', 'Philippines', '马尼拉'],
            '🇮🇩': ['印度尼西亚', '印尼', 'ID', 'Indonesia', '雅加达'],
            '🇰🇭': ['柬埔寨', 'Cambodia', '金边'],
            '🇲🇲': ['缅甸', 'Myanmar', '仰光'],
            '🇱🇦': ['老挝', 'Laos', '万象'],
            '🇧🇳': ['文莱', 'Brunei'],
            '🇹🇱': ['东帝汶', 'Timor-Leste'],
            '🇮🇳': ['印度', 'India', '孟买', '新德里', 'Mumbai', 'Delhi'],
            '🇵🇰': ['巴基斯坦', 'Pakistan', '卡拉奇', '伊斯兰堡'],
            '🇧🇩': ['孟加拉', 'Bangladesh', '达卡'],
            '🇳🇵': ['尼泊尔', 'Nepal', '加德满都'],
            '🇱🇰': ['斯里兰卡', 'Sri Lanka', '科伦坡'],
            '🇧🇹': ['不丹', 'Bhutan'],
            '🇲🇻': ['马尔代夫', 'Maldives', '马累'],
            '🇦🇫': ['阿富汗', 'Afghanistan', '喀布尔'],
            '🇰🇿': ['哈萨克斯坦', '哈萨克', 'Kazakhstan', '阿拉木图'],
            '🇺🇿': ['乌兹别克斯坦', '乌兹别克', 'Uzbekistan', '塔什干'],
            '🇹🇲': ['土库曼斯坦', '土库曼', 'Turkmenistan'],
            '🇹🇯': ['塔吉克斯坦', '塔吉克', 'Tajikistan'],
            '🇰🇬': ['吉尔吉斯斯坦', '吉尔吉斯', 'Kyrgyzstan'],
            '🇦🇿': ['阿塞拜疆', 'Azerbaijan', '巴库'],
            '🇦🇲': ['亚美尼亚', 'Armenia', '埃里温'],
            '🇬🇪': ['格鲁吉亚', 'Georgia', '第比利斯'],
            '🇦🇪': ['阿联酋', 'United Arab Emirates', '迪拜', 'Dubai', '阿布扎比'],
            '🇸🇦': ['沙特', 'Saudi Arabia', '沙特阿拉伯', '利雅得'],
            '🇮🇱': ['以色列', 'Israel', '特拉维夫'],
            '🇹🇷': ['土耳其', 'Turkey', '伊斯坦布尔', '安卡拉'],
            '🇮🇷': ['伊朗', 'Iran', '德黑兰'],
            '🇮🇶': ['伊拉克', 'Iraq', '巴格达'],
            '🇶🇦': ['卡塔尔', 'Qatar', '多哈'],
            '🇰🇼': ['科威特', 'Kuwait'],
            '🇴🇲': ['阿曼', 'Oman', '马斯喀特'],
            '🇧🇭': ['巴林', 'Bahrain', '麦纳麦'],
            '🇯🇴': ['约旦', 'Jordan', '安曼'],
            '🇱🇧': ['黎巴嫩', 'Lebanon', '贝鲁特'],
            '🇸🇾': ['叙利亚', 'Syria', '大马士革'],
            '🇾🇪': ['也门', 'Yemen', '萨那'],
            '🇵🇸': ['巴勒斯坦', 'Palestine'],
            '🇺🇸': ['美国', '美', '波特兰', '达拉斯', '俄勒冈', '凤凰城', '费利蒙', '硅谷', '拉斯维加斯', '洛杉矶', '圣何塞', '圣克拉拉', '西雅图', '芝加哥', 'US', 'USA', 'United States', 'ATL', 'BUF', 'DFW', 'EWR', 'IAD', 'LAX', 'MCI', 'MIA', 'ORD', 'PHX', 'PDX', 'SEA', 'SJC'],
            '🇨🇦': ['加拿大', 'CA', 'Canada', '多伦多', '温哥华', '蒙特利尔'],
            '🇲🇽': ['墨西哥', 'Mexico', '墨城'],
            '🇵🇦': ['巴拿马', 'Panama'],
            '🇨🇷': ['哥斯达黎加', 'Costa Rica'],
            '🇬🇹': ['危地马拉', 'Guatemala'],
            '🇭🇳': ['洪都拉斯', 'Honduras'],
            '🇳🇮': ['尼加拉瓜', 'Nicaragua'],
            '🇸🇻': ['萨尔瓦多', 'El Salvador'],
            '🇧🇿': ['伯利兹', 'Belize'],
            '🇨🇺': ['古巴', 'Cuba', '哈瓦那'],
            '🇩🇴': ['多米尼加', 'Dominican', '圣多明各'],
            '🇯🇲': ['牙买加', 'Jamaica', '金斯敦'],
            '🇭🇹': ['海地', 'Haiti'],
            '🇧🇸': ['巴哈马', 'Bahamas'],
            '🇧🇧': ['巴巴多斯', 'Barbados'],
            '🇹🇹': ['特立尼达', 'Trinidad'],
            '🇵🇷': ['波多黎各', 'Puerto Rico'],
            '🇧🇷': ['巴西', 'Brazil', '圣保罗', '里约'],
            '🇦🇷': ['阿根廷', 'Argentina', '布宜诺斯艾利斯'],
            '🇨🇱': ['智利', 'Chile', '圣地亚哥'],
            '🇨🇴': ['哥伦比亚', 'Colombia', '波哥大'],
            '🇵🇪': ['秘鲁', 'Peru', '利马'],
            '🇻🇪': ['委内瑞拉', 'Venezuela', '加拉加斯'],
            '🇪🇨': ['厄瓜多尔', 'Ecuador', '基多'],
            '🇺🇾': ['乌拉圭', 'Uruguay', '蒙得维的亚'],
            '🇧🇴': ['玻利维亚', 'Bolivia', '拉巴斯'],
            '🇵🇾': ['巴拉圭', 'Paraguay', '亚松森'],
            '🇬🇾': ['圭亚那', 'Guyana'],
            '🇸🇷': ['苏里南', 'Suriname'],
            '🇬🇫': ['法属圭亚那', 'French Guiana'],
            '🇬🇧': ['英国', 'UK', 'GB', 'United Kingdom', 'Britain', '伦敦', 'London', '曼彻斯特'],
            '🇩🇪': ['德国', 'DE', 'Germany', '法兰克福', '柏林', '慕尼黑', 'Frankfurt'],
            '🇫🇷': ['法国', 'FR', 'France', '巴黎', 'Paris', '马赛'],
            '🇳🇱': ['荷兰', 'NL', 'Netherlands', '阿姆斯特丹', 'Amsterdam'],
            '🇧🇪': ['比利时', 'Belgium', '布鲁塞尔'],
            '🇱🇺': ['卢森堡', 'Luxembourg'],
            '🇨🇭': ['瑞士', 'Switzerland', '苏黎世', '日内瓦'],
            '🇦🇹': ['奥地利', 'Austria', '维也纳'],
            '🇮🇪': ['爱尔兰', 'Ireland', '都柏林'],
            '🇲🇨': ['摩纳哥', 'Monaco'],
            '🇱🇮': ['列支敦士登', 'Liechtenstein'],
            '🇦🇩': ['安道尔', 'Andorra'],
            '🇸🇪': ['瑞典', 'Sweden', '斯德哥尔摩'],
            '🇳🇴': ['挪威', 'Norway', '奥斯陆'],
            '🇫🇮': ['芬兰', 'Finland', '赫尔辛基'],
            '🇩🇰': ['丹麦', 'Denmark', '哥本哈根'],
            '🇮🇸': ['冰岛', 'Iceland', '雷克雅未克'],
            '🇫🇴': ['法罗群岛', 'Faroe'],
            '🇬🇱': ['格陵兰', 'Greenland'],
            '🇮🇹': ['意大利', 'Italy', '米兰', '罗马', '都灵'],
            '🇪🇸': ['西班牙', 'Spain', '马德里', '巴塞罗那'],
            '🇵🇹': ['葡萄牙', 'Portugal', '里斯本'],
            '🇬🇷': ['希腊', 'Greece', '雅典'],
            '🇨🇾': ['塞浦路斯', 'Cyprus', '尼科西亚'],
            '🇲🇹': ['马耳他', 'Malta', '瓦莱塔'],
            '🇸🇲': ['圣马力诺', 'San Marino'],
            '🇻🇦': ['梵蒂冈', 'Vatican'],
            '🇦🇱': ['阿尔巴尼亚', 'Albania', '地拉那'],
            '🇲🇰': ['北马其顿', '马其顿', 'North Macedonia'],
            '🇽🇰': ['科索沃', 'Kosovo'],
            '🇲🇪': ['黑山', 'Montenegro'],
            '🇧🇦': ['波黑', '波斯尼亚', 'Bosnia'],
            '🇷🇺': ['俄罗斯', '俄', 'RU', 'Russia', '莫斯科', '圣彼得堡', 'Moscow'],
            '🇺🇦': ['乌克兰', 'Ukraine', '基辅'],
            '🇧🇾': ['白俄罗斯', 'Belarus', '明斯克'],
            '🇵🇱': ['波兰', 'Poland', '华沙'],
            '🇨🇿': ['捷克', 'Czech', '布拉格'],
            '🇸🇰': ['斯洛伐克', 'Slovakia', '布拉迪斯拉发'],
            '🇭🇺': ['匈牙利', 'Hungary', '布达佩斯'],
            '🇷🇴': ['罗马尼亚', 'Romania', '布加勒斯特'],
            '🇧🇬': ['保加利亚', 'Bulgaria', '索非亚'],
            '🇲🇩': ['摩尔多瓦', 'Moldova', '基希讷乌'],
            '🇱🇻': ['拉脱维亚', 'Latvia', '里加'],
            '🇱🇹': ['立陶宛', 'Lithuania', '维尔纽斯'],
            '🇪🇪': ['爱沙尼亚', 'Estonia', '塔林'],
            '🇸🇮': ['斯洛文尼亚', 'Slovenia', '卢布尔雅那'],
            '🇭🇷': ['克罗地亚', 'Croatia', '萨格勒布'],
            '🇷🇸': ['塞尔维亚', 'Serbia', '贝尔格莱德'],
            '🇦🇺': ['澳洲', '澳大利亚', 'AU', 'Australia', '悉尼', '墨尔本', 'Sydney', 'Melbourne'],
            '🇳🇿': ['新西兰', 'New Zealand', '奥克兰'],
            '🇫🇯': ['斐济', 'Fiji', '苏瓦'],
            '🇵🇬': ['巴布亚新几内亚', '巴新', 'Papua New Guinea'],
            '🇼🇸': ['萨摩亚', 'Samoa'],
            '🇹🇴': ['汤加', 'Tonga'],
            '🇻🇺': ['瓦努阿图', 'Vanuatu'],
            '🇸🇧': ['所罗门群岛', 'Solomon'],
            '🇳🇨': ['新喀里多尼亚', 'New Caledonia'],
            '🇵🇫': ['法属波利尼西亚', 'French Polynesia', '大溪地'],
            '🇬🇺': ['关岛', 'Guam'],
            '🇪🇬': ['埃及', 'Egypt', '开罗'],
            '🇱🇾': ['利比亚', 'Libya', '的黎波里'],
            '🇹🇳': ['突尼斯', 'Tunisia', '突尼斯城'],
            '🇩🇿': ['阿尔及利亚', 'Algeria', '阿尔及尔'],
            '🇲🇦': ['摩洛哥', 'Morocco', '卡萨布兰卡'],
            '🇸🇩': ['苏丹', 'Sudan', '喀土穆'],
            '🇳🇬': ['尼日利亚', 'Nigeria', '拉各斯'],
            '🇬🇭': ['加纳', 'Ghana', '阿克拉'],
            '🇸🇳': ['塞内加尔', 'Senegal', '达喀尔'],
            '🇨🇮': ['科特迪瓦', '象牙海岸', 'Ivory Coast', 'Cote'],
            '🇲🇱': ['马里', 'Mali', '巴马科'],
            '🇧🇫': ['布基纳法索', 'Burkina Faso'],
            '🇳🇪': ['尼日尔', 'Niger'],
            '🇬🇳': ['几内亚', 'Guinea'],
            '🇹🇬': ['多哥', 'Togo'],
            '🇧🇯': ['贝宁', 'Benin'],
            '🇱🇷': ['利比里亚', 'Liberia'],
            '🇸🇱': ['塞拉利昂', 'Sierra Leone'],
            '🇲🇷': ['毛里塔尼亚', 'Mauritania'],
            '🇬🇲': ['冈比亚', 'Gambia'],
            '🇨🇻': ['佛得角', 'Cape Verde'],
            '🇨🇲': ['喀麦隆', 'Cameroon', '雅温得'],
            '🇨🇩': ['刚果民主共和国', '刚果金', 'DR Congo'],
            '🇨🇬': ['刚果共和国', '刚果布', 'Congo'],
            '🇨🇫': ['中非共和国', '中非', 'Central African'],
            '🇹🇩': ['乍得', 'Chad'],
            '🇬🇦': ['加蓬', 'Gabon'],
            '🇬🇶': ['赤道几内亚', 'Equatorial Guinea'],
            '🇰🇪': ['肯尼亚', 'Kenya', '内罗毕'],
            '🇹🇿': ['坦桑尼亚', 'Tanzania', '达累斯萨拉姆'],
            '🇺🇬': ['乌干达', 'Uganda', '坎帕拉'],
            '🇷🇼': ['卢旺达', 'Rwanda', '基加利'],
            '🇧🇮': ['布隆迪', 'Burundi'],
            '🇪🇹': ['埃塞俄比亚', 'Ethiopia', '亚的斯亚贝巴'],
            '🇪🇷': ['厄立特里亚', 'Eritrea'],
            '🇩🇯': ['吉布提', 'Djibouti'],
            '🇸🇴': ['索马里', 'Somalia'],
            '🇲🇬': ['马达加斯加', 'Madagascar'],
            '🇲🇺': ['毛里求斯', 'Mauritius'],
            '🇸🇨': ['塞舌尔', 'Seychelles'],
            '🇰🇲': ['科摩罗', 'Comoros'],
            '🇷🇪': ['留尼汪', 'Reunion'],
            '🇿🇦': ['南非', 'South Africa', '约翰内斯堡', '开普敦'],
            '🇿🇼': ['津巴布韦', 'Zimbabwe', '哈拉雷'],
            '🇿🇲': ['赞比亚', 'Zambia', '卢萨卡'],
            '🇲🇼': ['马拉维', 'Malawi'],
            '🇲🇿': ['莫桑比克', 'Mozambique', '马普托'],
            '🇧🇼': ['博茨瓦纳', 'Botswana'],
            '🇳🇦': ['纳米比亚', 'Namibia', '温得和克'],
            '🇦🇴': ['安哥拉', 'Angola', '罗安达'],
            '🇸🇿': ['斯威士兰', 'Eswatini', 'Swaziland'],
            '🇱🇸': ['莱索托', 'Lesotho']
        };

        for (const [emoji, keywords] of Object.entries(emojiMap)) {
            for (const keyword of keywords) {
                if (name.includes(keyword)) {
                    if (!/^[\uD83C][\uDDE6-\uDDFF][\uD83C][\uDDE6-\uDDFF]/.test(name)) {
                        proxy.name = `${emoji} ${name}`;
                    }
                    return proxy;
                }
            }
        }
        return proxy;
    }
}

/**
 * Clash Generator
 */
class ClashGenerator {
    constructor(config) {
        this.config = config;
    }

    async generate(proxies, useMeta = false) {
        // 去重节点 (按 name + server + port)
        const uniqueProxies = this.deduplicateProxies(proxies);

        let yaml = `# Clash Config Generated by Subscription Converter
port: 7890
socks-port: 7891
allow-lan: false
mode: rule
log-level: info
geodata-mode: true
geo-auto-update: true
geodata-loader: standard
geo-update-interval: 24
geox-url:
  geoip: https://testingcf.jsdelivr.net/gh/MetaCubeX/meta-rules-dat@release/geoip.dat
  geosite: https://testingcf.jsdelivr.net/gh/MetaCubeX/meta-rules-dat@release/geosite.dat
  mmdb: https://testingcf.jsdelivr.net/gh/MetaCubeX/meta-rules-dat@release/country.mmdb
  asn: https://github.com/xishang0128/geoip/releases/download/latest/GeoLite2-ASN.mmdb

dns:
  enable: true
  ipv6: true
  respect-rules: true
  enhanced-mode: fake-ip
  fake-ip-range: 198.18.0.1/16
  fake-ip-filter:
    - "*.lan"
    - "*.local"
    - "time.*.com"
    - "ntp.*.com"
    - "+.pool.ntp.org"
  nameserver:
    - https://120.53.53.53/dns-query
    - https://223.5.5.5/dns-query
  proxy-server-nameserver:
    - https://120.53.53.53/dns-query
    - https://223.5.5.5/dns-query
  nameserver-policy:
    geosite:cn,private:
      - https://120.53.53.53/dns-query
      - https://223.5.5.5/dns-query
    geosite:geolocation-!cn:
      - https://dns.cloudflare.com/dns-query
      - https://dns.google/dns-query

proxies:
`;

        // 添加节点
        const existingNames = new Set();
        for (const proxy of uniqueProxies) {
            yaml += this.proxyToYaml(proxy, existingNames);
        }

        // 更新 proxyNames 为最终去重后的名字，用于分组
        const finalProxyNames = Array.from(existingNames);
        const proxyGroups = this.generateProxyGroups(finalProxyNames);
        yaml += '\nproxy-groups:\n';
        for (const group of proxyGroups) {
            yaml += this.proxyGroupToYaml(group);
        }

        // 添加内联规则 (fetch and inline)
        yaml += '\nrules:\n';
        const inlineRules = await this.fetchInlineRules();
        for (const rule of inlineRules) {
            yaml += ` - ${rule}\n`;
        }

        return yaml;
    }

    async fetchInlineRules() {
        const allRules = [];

        // Fetch all remote rulesets in parallel
        const fetchPromises = this.config.rulesets.map(async (rs) => {
            let group = rs.group;
            if (this.removedGroups && this.removedGroups.has(group)) {
                group = 'DIRECT';
            }

            if (rs.isBuiltin) {
                // Built-in rules (GEOIP, FINAL)
                if (rs.type === 'GEOIP') {
                    return [`GEOIP,${rs.value},${group}`];
                } else if (rs.type === 'FINAL') {
                    return [`MATCH,${group}`];
                }
                return [];
            }

            // Fetch remote ruleset
            try {
                const response = await fetch(rs.source, {
                    headers: { 'User-Agent': 'ClashSubConverter/1.0' }
                });
                if (!response.ok) {
                    console.error(`Failed to fetch ruleset: ${rs.source}`);
                    return [];
                }
                const text = await response.text();
                const rules = this.parseRuleList(text, group);
                return rules;
            } catch (e) {
                console.error(`Error fetching ruleset ${rs.source}:`, e);
                return [];
            }
        });

        const results = await Promise.all(fetchPromises);
        for (const rules of results) {
            allRules.push(...rules);
        }

        return allRules;
    }

    parseRuleList(text, group) {
        const rules = [];
        const lines = text.split('\n');
        // Options that are NOT proxy groups
        const ruleOptions = ['no-resolve', 'src', 'dst'];

        for (let line of lines) {
            line = line.trim();
            // Skip empty lines and comments
            if (!line || line.startsWith('#') || line.startsWith('//') || line.startsWith(';')) {
                continue;
            }

            // Check if line already has a policy/group
            // Format: TYPE,VALUE or TYPE,VALUE,POLICY or TYPE,VALUE,POLICY,no-resolve
            const parts = line.split(',');
            if (parts.length >= 2) {
                const ruleType = parts[0].toUpperCase();
                // Supported rule types
                const supportedTypes = [
                    'DOMAIN', 'DOMAIN-SUFFIX', 'DOMAIN-KEYWORD', 'DOMAIN-REGEX',
                    'IP-CIDR', 'IP-CIDR6', 'GEOIP', 'GEOSITE',
                    'PROCESS-NAME', 'PROCESS-PATH',
                    'SRC-IP-CIDR', 'SRC-PORT', 'DST-PORT',
                    'AND', 'OR', 'NOT', 'MATCH'
                ];

                if (supportedTypes.includes(ruleType)) {
                    if (parts.length === 2) {
                        // TYPE,VALUE -> TYPE,VALUE,group
                        rules.push(`${line},${group}`);
                    } else if (parts.length === 3) {
                        // Check if third part is an option (like no-resolve) or a policy
                        const thirdPart = parts[2].trim().toLowerCase();
                        if (ruleOptions.includes(thirdPart)) {
                            // TYPE,VALUE,no-resolve -> TYPE,VALUE,group,no-resolve
                            rules.push(`${parts[0]},${parts[1]},${group},${parts[2]}`);
                        } else {
                            // TYPE,VALUE,POLICY -> use as-is
                            rules.push(line);
                        }
                    } else {
                        // 4+ parts, use as-is
                        rules.push(line);
                    }
                }
            }
        }

        return rules;
    }

    deduplicateProxies(proxies) {
        const seen = new Set();
        const unique = [];

        for (const proxy of proxies) {
            const key = `${proxy.name}|${proxy.server}|${proxy.port}`;
            if (!seen.has(key)) {
                seen.add(key);
                unique.push(proxy);
            }
        }

        return unique;
    }

    proxyToYaml(proxy, existingNames) {

        const clean = this.cleanProxy(proxy);



        // Ensure unique name

        let name = clean.name;

        let counter = 1;

        while (existingNames.has(name)) {

            name = `${clean.name} ${counter}`;

            counter++;

        }

        existingNames.add(name);

        clean.name = name;



        let yaml = `  - name: ${clean.name}\n`;

        yaml += `    type: ${clean.type}\n`;

        yaml += `    server: ${clean.server}\n`;

        yaml += `    port: ${clean.port}\n`;

        yaml += `    udp: true\n`;



        // 根据类型添加其他字段



        if (clean.type === 'ss') {



            yaml += `    cipher: ${clean.cipher || 'auto'}\n`;



            yaml += `    password: "${clean.password}"\n`;



            if (clean.plugin) {



                yaml += `    plugin: ${clean.plugin}\n`;



                if (clean['plugin-opts']) {



                    yaml += `    plugin-opts:\n`;



                    for (const [k, v] of Object.entries(clean['plugin-opts'])) {



                        const val = typeof v === 'boolean' || v === 'true' || v === 'false' ? v : `"${v}"`;



                        yaml += `      ${k}: ${val}\n`;



                    }



                }



            }



        } else if (clean.type === 'vm' + 'ess') {



            yaml += `    uuid: ${clean.uuid}\n`;



            yaml += `    alterId: ${clean.alterId || 0}\n`;



            yaml += `    cipher: ${clean.cipher || 'auto'}\n`;



            if (clean.tls) yaml += `    tls: true\n`;



            if (clean.network) yaml += `    network: ${clean.network}\n`;



            if (clean['ws-opts']) {



                yaml += `    ws-opts:\n`;



                yaml += `      path: "${clean['ws-opts'].path || '/'}"\n`;



                if (clean['ws-opts'].headers?.Host) {



                    yaml += `      headers:\n        Host: ${clean['ws-opts'].headers.Host}\n`;



                }



            }



        } else if (clean.type === 'vl' + 'ess') {



            yaml += `    uuid: ${clean.uuid}\n`;



            if (clean.tls) yaml += `    tls: true\n`;



            // client-fingerprint 放在 tls 后面



            if (clean['client-fingerprint']) {



                yaml += `    client-fingerprint: ${clean['client-fingerprint']}\n`;



            }



            if (clean.servername) yaml += `    servername: ${clean.servername}\n`;



            if (clean.network) yaml += `    network: ${clean.network}\n`;



            if (clean['reality-opts']) {



                yaml += `    reality-opts:\n`;



                yaml += `      public-key: ${clean['reality-opts']['public-key']}\n`;



                if (clean['reality-opts']['short-id']) {



                    yaml += `      short-id: ${clean['reality-opts']['short-id']}\n`;



                }



            }



            if (clean['ws-opts']) {



                yaml += `    ws-opts:\n`;



                let path = clean['ws-opts'].path || '/';



                try {



                    if (path.includes('%')) path = decodeURIComponent(path);



                } catch (e) { }



                yaml += `      path: "${path}"\n`;



                if (clean['ws-opts'].headers) {



                    yaml += `      headers:\n`;



                    for (const [k, v] of Object.entries(clean['ws-opts'].headers)) {



                        yaml += `        ${k}: ${v}\n`;



                    }



                }



            }



            yaml += `    tfo: false\n`;



            yaml += `    skip-cert-verify: ${clean['skip-cert-verify'] === true}\n`;



            // flow 放在最后



            if (clean.flow) yaml += `    flow: ${clean.flow}\n`;



        } else if (clean.type === 'trojan') {



            yaml += `    password: "${clean.password}"\n`;



            if (clean.sni) yaml += `    sni: ${clean.sni}\n`;



            if (clean.network) yaml += `    network: ${clean.network}\n`;



        } else if (clean.type === 'hysteria2') {



            yaml += `    password: "${clean.password}"\n`;



            if (clean.sni) yaml += `    sni: ${clean.sni}\n`;



        } else if (clean.type === 'tuic') {



            yaml += `    uuid: ${clean.uuid}\n`;



            yaml += `    password: "${clean.password}"\n`;



            if (clean.sni) yaml += `    sni: ${clean.sni}\n`;



        }







        // client-fingerprint 已在各类型中单独处理



        // 只为非 VL 类型添加



        if (clean.type !== 'vl' + 'ess' && clean['client-fingerprint']) {



            yaml += `    client-fingerprint: ${clean['client-fingerprint']}\n`;



        }







        if (clean['skip-cert-verify'] && clean.type !== 'vl' + 'ess') {



            yaml += `    skip-cert-verify: true\n`;



        }

        return yaml;
    }

    proxyGroupToYaml(group) {
        let yaml = ` - name: "${group.name}"\n`;
        yaml += `   type: ${group.type}\n`;

        // 去重 proxies
        const uniqueProxies = [...new Set(group.proxies)];
        yaml += `   proxies:\n`;
        for (const p of uniqueProxies) {
            yaml += `     - "${p}"\n`;
        }

        if (group.type === 'url-test' || group.type === 'fallback' || group.type === 'load-balance') {
            yaml += `   url: http://www.gstatic.com/generate_204\n`;
            yaml += `   interval: ${group.interval || 300}\n`;
            if (group.tolerance) yaml += `   tolerance: ${group.tolerance}\n`;
            if (group.type === 'load-balance' && group.strategy) {
                yaml += `   strategy: ${group.strategy}\n`;
            }
        }

        return yaml;
    }

    generateProxyGroups(proxyNames) {
        const groups = [];
        const removedGroups = new Set();
        this.removedGroups = removedGroups; // Store for rules generation

        // First pass: Process groups with filters
        for (const g of this.config.proxyGroups) {
            if (g.filter) {
                const group = { name: g.name, type: g.type };
                try {
                    const regex = new RegExp(g.filter, 'i');
                    const matched = proxyNames.filter(n => regex.test(n));
                    if (matched.length === 0) {
                        removedGroups.add(g.name);
                        continue; // Skip empty filtered group
                    }
                    group.proxies = [...new Set(matched)];
                } catch {
                    removedGroups.add(g.name);
                    continue;
                }

                if (g.type === 'url-test' || g.type === 'fallback' || g.type === 'load-balance') {
                    group.url = g.url || 'http://www.gstatic.com/generate_204';
                    group.interval = g.interval || 300;
                    if (g.tolerance) group.tolerance = g.tolerance;
                    if (g.type === 'load-balance' && g.strategy) group.strategy = g.strategy;
                }
                groups.push(group);
            }
        }

        // Second pass: Process groups without filters (manual lists)
        for (const g of this.config.proxyGroups) {
            if (!g.filter) {
                const group = { name: g.name, type: g.type };
                let proxies = g.proxies || [];

                // Filter out removed groups from the proxies list
                if (proxies.length > 0) {
                    proxies = proxies.filter(p => !removedGroups.has(p));
                }

                // If special handling needed for 'select' groups that might become empty
                // usually these have static items like 'DIRECT' or 'REJECT', so we don't need aggressive fallback
                if (proxies.length === 0) proxies = ['DIRECT'];

                group.proxies = [...new Set(proxies)]; // Deduplicate

                if (g.type === 'url-test' || g.type === 'fallback' || g.type === 'load-balance') {
                    group.url = g.url || 'http://www.gstatic.com/generate_204';
                    group.interval = g.interval || 300;
                    if (g.tolerance) group.tolerance = g.tolerance;
                    if (g.type === 'load-balance' && g.strategy) group.strategy = g.strategy;
                }
                groups.push(group);
            }
        }

        const finalGroups = [];
        const groupMap = new Map(groups.map(g => [g.name, g]));

        for (const g of this.config.proxyGroups) {
            if (groupMap.has(g.name)) {
                finalGroups.push(groupMap.get(g.name));
            }
        }

        return finalGroups;
    }

    generateRules() {
        return [
            'GEOIP,CN,🎯 全球直连',
            'MATCH,🐟 漏网之鱼'
        ];
    }

    generateRulesWithProviders() {
        const rules = [];

        for (const rs of this.config.rulesets) {
            let group = rs.group;
            // Check if group was removed due to being empty
            if (this.removedGroups && this.removedGroups.has(group)) {
                group = 'DIRECT';
            }

            if (rs.isBuiltin) {
                if (rs.type === 'GEOIP') {
                    rules.push(`GEOIP,${rs.value},${group}`);
                }
            } else {
                const name = this.getProviderName(rs.source);
                rules.push(`RULE-SET,${name},${group}`);
            }
        }

        rules.push('MATCH,🐟 漏网之鱼');
        return rules;
    }

    generateRuleProvidersYaml() {
        let yaml = '';

        for (const rs of this.config.rulesets) {
            if (!rs.isBuiltin) {
                const name = this.getProviderName(rs.source);
                yaml += ` ${name}:\n`;
                yaml += `   type: http\n`;
                yaml += `   behavior: classical\n`;
                yaml += `   url: "${rs.source}"\n`;
                yaml += `   path: ./ruleset/${name}.yaml\n`;
                yaml += `   interval: 86400\n`;
            }
        }

        return yaml;
    }

    getProviderName(url) {
        const match = url.match(/\/([^\/]+?)(?:\.list|\.yaml|\.txt)?$/);
        if (match) return match[1].replace(/[^a-zA-Z0-9_-]/g, '_').toLowerCase();
        return 'provider_' + btoa(url).substring(0, 8).replace(/[=+\/]/g, '_');
    }

    cleanProxy(proxy) {
        const cleaned = {};
        for (const [key, value] of Object.entries(proxy)) {
            if (value !== undefined && value !== null) {
                cleaned[key] = value;
            }
        }
        return cleaned;
    }
}

/**
 * Handle Clash Subscription
 */
function safeDecodeURIComponent(value) {
    try {
        return decodeURIComponent(value);
    } catch (e) {
        return value;
    }
}

function normalizeHost(value) {
    if (!value) return null;
    return value.split(',')[0].trim().replace(/:\d+$/, '').toLowerCase();
}

function getLocalSubscriptionHosts(requestUrl, requestHeaders, env) {
    const currentUrl = new URL(requestUrl);
    return new Set([
        normalizeHost(currentUrl.hostname),
        normalizeHost(requestHeaders.get('Host')),
        normalizeHost(requestHeaders.get('X-Forwarded-Host')),
        normalizeHost(env?.PAGES_HOSTNAME),
    ].filter(Boolean));
}

function isLocalSubscriptionUrl(subscriptionUrl, requestUrl, requestHeaders, env) {
    let targetUrl;
    try {
        targetUrl = new URL(subscriptionUrl);
    } catch (e) {
        return false;
    }

    const parts = targetUrl.pathname.split('/');
    if (!targetUrl.pathname.startsWith('/sub/') || parts[2] === 'clash') return false;
    return getLocalSubscriptionHosts(requestUrl, requestHeaders, env).has(normalizeHost(targetUrl.hostname));
}

async function handleLocalSubscriptionUrl(db, subscriptionUrl) {
    const targetUrl = new URL(subscriptionUrl);
    const parts = targetUrl.pathname.split('/');

    if (parts[2] === 'clash') return null;
    if (parts[2] === 'token' && parts[3]) {
        return handleSubscribeByToken(db, parts[3], targetUrl.toString());
    }
    if (parts[2] === 'ss' && parts[3]) {
        return handleSSSubscribe(db, parts[3], targetUrl.toString());
    }
    if (parts[2] === 'argo' && parts[3]) {
        return handleArgoSubscribe(db, parts[3], targetUrl.toString());
    }
    if (parts[2]) {
        return handleSubscribe(db, parts[2], targetUrl.toString());
    }

    return null;
}

async function fetchSubscriptionContent(db, subscriptionUrl, requestUrl, requestHeaders, env) {
    if (isLocalSubscriptionUrl(subscriptionUrl, requestUrl, requestHeaders, env)) {
        const response = await handleLocalSubscriptionUrl(db, subscriptionUrl);
        if (response?.ok) return response.text();
        return null;
    }

    const response = await fetch(subscriptionUrl, {
        headers: { 'User-Agent': 'ClashSubConverter/1.0' }
    });
    if (!response.ok) return null;

    return response.text();
}

async function handleClashSubscribe(db, request, env) {
    const requestUrl = typeof request === 'string' ? request : request.url;
    const requestHeaders = typeof request === 'string' ? new Headers() : request.headers;
    const params = new URL(requestUrl).searchParams;
    const subUrl = params.get('url');

    if (!subUrl) {
        return new Response('Missing url parameter', { status: 400 });
    }

    // Fetch subscriptions
    const subscriptionUrls = safeDecodeURIComponent(subUrl).split('|').map(item => item.trim()).filter(Boolean);
    const subParser = new SubParser();
    let allProxies = [];

    for (const u of subscriptionUrls) {
        try {
            const content = await fetchSubscriptionContent(db, u, requestUrl, requestHeaders, env);
            if (content !== null) {
                const proxies = subParser.parse(content);
                allProxies = allProxies.concat(proxies);
            }
        } catch (e) {
            console.error(`Failed to fetch: ${u}`, e);
        }
    }

    if (allProxies.length === 0) {
        return new Response('No valid proxies found', { status: 400 });
    }

    // Apply filters
    const exclude = params.get('exclude');
    const include = params.get('include');
    const emoji = params.get('emoji') !== 'false';

    if (exclude) {
        try {
            const regex = new RegExp(decodeURIComponent(exclude), 'i');
            allProxies = allProxies.filter(p => !regex.test(p.name));
        } catch (e) { }
    }

    if (include) {
        try {
            const regex = new RegExp(decodeURIComponent(include), 'i');
            allProxies = allProxies.filter(p => regex.test(p.name));
        } catch (e) { }
    }

    if (emoji) {
        allProxies = allProxies.map(p => subParser.addEmoji(p));
    }

    // Generate config
    const generator = new ClashGenerator(CONFIG);
    const output = await generator.generate(allProxies);

    return new Response(output, {
        headers: {
            'Content-Type': 'text/plain; charset=utf-8',
            'Content-Disposition': 'inline; filename="clash.yaml"',
            'Access-Control-Allow-Origin': '*'
        }
    });
}
