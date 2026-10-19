import net from 'node:net';
import { Duplex } from 'node:stream';

// 现有 SOCKS5/HTTP 检测使用 Cloudflare TCP Socket 的 Web Streams 接口。
export function connect({ hostname, port }) {
    const socket = net.createConnection({ host: hostname.replace(/^\[|\]$/g, ''), port });
    const { readable, writable } = Duplex.toWeb(socket);
    return { readable, writable, close() { socket.destroy(); } };
}
