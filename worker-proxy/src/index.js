export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    url.hostname = env.PAGES_HOSTNAME;

    const headers = new Headers(request.headers);
    headers.set('Host', env.PAGES_HOSTNAME);
    headers.set('X-Forwarded-Host', request.headers.get('Host') || '');
    headers.set('X-Forwarded-For', request.headers.get('X-Forwarded-For') || '');
    headers.set('X-Real-IP', request.headers.get('CF-Connecting-IP') || '');

    const response = await fetch(url.toString(), {
      method: request.method,
      headers,
      body: request.method !== 'GET' && request.method !== 'HEAD' ? request.body : undefined,
    });

    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    });
  },
};
