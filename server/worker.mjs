import { registerHooks } from 'node:module';

// 仅在 Node 中替换 Cloudflare 内置模块，Pages 入口继续保持原样。
registerHooks({
    resolve(specifier, context, nextResolve) {
        if (specifier === 'cloudflare:sockets') {
            return { url: new URL('./sockets.mjs', import.meta.url).href, shortCircuit: true };
        }
        return nextResolve(specifier, context);
    },
});

export const worker = (await import('../public/_worker.js')).default;
