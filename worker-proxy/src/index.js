export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const originalHost = request.headers.get('Host') || url.host;
    const originalProtocol = url.protocol.replace(':', '');

    url.protocol = 'https:';
    url.hostname = env.PAGES_HOSTNAME;
    url.port = '';

    const headers = new Headers(request.headers);
    headers.delete('Host');
    headers.delete('Connection');
    headers.delete('Keep-Alive');
    headers.delete('Proxy-Authenticate');
    headers.delete('Proxy-Authorization');
    headers.delete('TE');
    headers.delete('Trailer');
    headers.delete('Transfer-Encoding');
    headers.delete('Upgrade');

    headers.set('X-Forwarded-Host', originalHost);
    headers.set('X-Forwarded-Proto', originalProtocol);

    const clientIp = request.headers.get('CF-Connecting-IP');
    if (clientIp) {
      const existingForwardedFor = request.headers.get('X-Forwarded-For');
      headers.set('X-Forwarded-For', existingForwardedFor ? `${existingForwardedFor}, ${clientIp}` : clientIp);
      headers.set('X-Real-IP', clientIp);
    }

    const start = Date.now();
    const response = await fetch(url.toString(), {
      method: request.method,
      headers,
      body: request.method !== 'GET' && request.method !== 'HEAD' ? request.body : undefined,
    });
    const upstreamMs = Date.now() - start;

    const responseHeaders = new Headers(response.headers);
    responseHeaders.set('X-Worker-Proxy-Upstream-Ms', String(upstreamMs));
    responseHeaders.append('Server-Timing', `workerProxy;dur=${upstreamMs}`);

    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers: responseHeaders,
    });
  },
};
