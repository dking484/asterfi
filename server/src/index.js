import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import multipart from '@fastify/multipart';
import fastifyStatic from '@fastify/static';
import { existsSync } from 'node:fs';
import net from 'node:net';
import { rm } from 'node:fs/promises';
import { config } from './config.js';
import { migrate, q } from './db.js';
import { Ami } from './ami.js';
import { initGenerator, applyNow, startTrunkWatch } from './asterisk/generate.js';
import { handleAmiEvent, invalidateUserCache } from './calltracker.js';
import { initVoicemail } from './voicemail.js';
import { initWebhooks } from './notify/webhooks.js';
import { promptFile } from './prompts.js';
import { initUnifi } from './unifi/listener.js';
import { onRegistryEvent } from './trunkstatus.js';
import adminRoutes from './routes/admin.js';
import { versions } from './system.js';
import { annotate as annotateCompat } from './compat.js';
import v1Routes from './routes/v1.js';
import phonebookRoutes from './routes/phonebook.js';
import { initConsole } from './sysadmin.js';

await migrate();
invalidateUserCache();

const ami = new Ami(config.ami);
ami.on('log', (m) => console.warn(m));
ami.on('connected', () => console.log('AMI connected'));
ami.on('event', handleAmiEvent);
ami.on('event', (e) => { if (e.Event === 'Registry') onRegistryEvent(e).catch((err) => console.error('registry', err.message)); });
ami.on('event', async (e) => {
  // A prompt recorded from a phone replaces any older audio for that prompt.
  if (e.Event === 'UserEvent' && e.UserEvent === 'AsterFiPromptRecorded') {
    const id = Number(e.Prompt);
    if (!id) return;
    await rm(promptFile(id, 'wav16'), { force: true });
    await q(`UPDATE prompts SET has_audio=true, kind='phone', tts_text=NULL, updated_at=now() WHERE id=$1`, [id]).catch(() => {});
  }
});
initGenerator(ami);
startTrunkWatch();
ami.start();

// Write config once AMI is up so the first reload takes effect.
let applied = false;
ami.on('connected', () => {
  if (applied) return;
  applied = true;
  applyNow({ transports: true }).then(() => console.log('Asterisk config applied')).catch((e) => console.error('apply failed', e));
  // Say so in the log if anything runs outside the versions this AsterFi release supports.
  versions(ami, q).then((v) => {
    for (const i of annotateCompat(v)) console.warn(`Untested version: ${i.name} ${i.version} (this AsterFi release supports ${i.supported})`);
  }).catch((e) => console.error('version check', e.message));
});

initVoicemail(ami);
initConsole(ami);
initWebhooks();
initUnifi(ami);

const app = Fastify({ logger: { level: 'info' }, disableRequestLogging: true, trustProxy: true, bodyLimit: 5 * 1024 * 1024 });
await app.register(cookie);
await app.register(multipart, { limits: { fileSize: 20 * 1024 * 1024 } });
await app.register(adminRoutes, { ami });
await app.register(v1Routes, { prefix: '/api/v1', ami });
await app.register(phonebookRoutes);

if (existsSync(config.webDir)) {
  await app.register(fastifyStatic, { root: config.webDir, wildcard: false });
  // Client-side routes fall back to index.html.
  app.setNotFoundHandler((req, reply) => {
    if (req.url.startsWith('/api/')) return reply.code(404).send({ error: 'Not found' });
    return reply.sendFile('index.html');
  });
}

// WebSocket SIP for the web phone. nginx normally proxies /ws straight to Asterisk; this covers
// direct access to the app port (e.g. through an SSH tunnel) by piping the upgrade to Asterisk.
app.server.on('upgrade', (req, socket, head) => {
  if (!req.url.startsWith('/ws')) { socket.destroy(); return; }
  const upstream = net.connect(8088, '127.0.0.1', () => {
    const lines = [`${req.method} /ws HTTP/1.1`, ...Object.entries(req.headers).map(([k, v]) => `${k}: ${v}`), '', ''];
    upstream.write(lines.join('\r\n'));
    if (head?.length) upstream.write(head);
    upstream.pipe(socket);
    socket.pipe(upstream);
  });
  upstream.on('error', () => socket.destroy());
  socket.on('error', () => upstream.destroy());
});

await app.listen({ port: config.port, host: config.host });
