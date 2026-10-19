import { createApplication } from './app.mjs';

process.umask(0o077);
const { server, db } = await createApplication({
    databasePath: process.env.DATABASE_PATH || '/data/snippets.sqlite',
    apiKey: process.env.API_KEY,
    pagesHostname: process.env.PAGES_HOSTNAME,
});
server.listen(Number(process.env.PORT || 3000), process.env.HOST || '0.0.0.0', () => {
    console.log(`CF Snippets Extend listening on port ${server.address().port}`);
});

for (const signal of ['SIGINT', 'SIGTERM']) {
    process.once(signal, () => {
        server.close(() => { db.close(); process.exit(0); });
        setTimeout(() => process.exit(1), 10000).unref();
    });
}
