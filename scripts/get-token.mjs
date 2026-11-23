import 'dotenv/config';
import { exec } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:https';
import selfsigned from 'selfsigned';

const kind = process.argv.includes('--kind=bot') ? 'bot' : 'user';
const clientId = process.env.TWITCH_CLIENT_ID;
const clientSecret = process.env.TWITCH_CLIENT_SECRET;

if (!clientId || !clientSecret) {
  console.error('Set TWITCH_CLIENT_ID and TWITCH_CLIENT_SECRET in .env first.');
  process.exit(1);
}

const port = 3001;
const redirectUri = `https://localhost:${port}/callback`;
const scopes = kind === 'user'
  ? ['channel:read:redemptions', 'channel:read:subscriptions', 'bits:read']
  : ['chat:read'];
const state = randomUUID();

const authUrl = new URL('https://id.twitch.tv/oauth2/authorize');
authUrl.searchParams.set('client_id', clientId);
authUrl.searchParams.set('redirect_uri', redirectUri);
authUrl.searchParams.set('response_type', 'code');
authUrl.searchParams.set('scope', scopes.join(' '));
authUrl.searchParams.set('state', state);
authUrl.searchParams.set('force_verify', 'true');

// Twitch requires HTTPS redirect URIs, so serve the callback locally over TLS
// with a throwaway self-signed certificate. The browser will warn; proceed.
const pems = await selfsigned.generate(
  [{ name: 'commonName', value: 'localhost' }],
  {
    days: 1,
    keySize: 2048,
    algorithm: 'sha256',
    extensions: [
      { name: 'basicConstraints', cA: false },
      { name: 'keyUsage', digitalSignature: true, keyEncipherment: true },
      {
        name: 'subjectAltName',
        altNames: [
          { type: 2, value: 'localhost' },
          { type: 7, ip: '127.0.0.1' },
          { type: 7, ip: '::1' }
        ]
      }
    ]
  }
);

console.log(`\nTwitchPC token helper (${kind})\n`);
console.log(`Make sure this redirect URL is registered in your Twitch app:\n  ${redirectUri}\n`);
console.log(`Opening your browser. Log in as the ${kind === 'user' ? 'streamer' : 'bot'} account and click Authorize.`);
console.log('Your browser will warn about a self-signed certificate — choose Advanced / Proceed.\n');

const server = createServer({ key: pems.private, cert: pems.cert }, async (request, response) => {
  const url = new URL(request.url ?? '/', redirectUri);
  if (url.pathname !== '/callback') {
    response.writeHead(404).end('Not found');
    return;
  }
  const code = url.searchParams.get('code');
  if (!code || url.searchParams.get('state') !== state) {
    response.writeHead(400).end('Invalid callback (missing code or state mismatch)');
    return;
  }

  try {
    const tokenResponse = await fetch('https://id.twitch.tv/oauth2/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: clientId,
        client_secret: clientSecret,
        code,
        grant_type: 'authorization_code',
        redirect_uri: redirectUri
      })
    });
    const text = await tokenResponse.text();
    if (!tokenResponse.ok) {
      response.writeHead(400).end(`Token exchange failed: ${text}`);
      console.error(`Token exchange failed: ${text}`);
      return;
    }

    const data = JSON.parse(text);
    response.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
    response.end('Success! You can close this tab and return to the terminal.');

    console.log('\n--- Paste these into your .env file ---');
    if (kind === 'user') {
      console.log(`TWITCH_BROADCASTER_ACCESS_TOKEN=${data.access_token}`);
      console.log(`TWITCH_BROADCASTER_REFRESH_TOKEN=${data.refresh_token}`);
    } else {
      console.log(`TWITCH_BOT_TOKEN=${String(data.access_token).replace(/^oauth:/i, '')}`);
      console.log('TWITCH_BOT_USERNAME=<your bot account login>');
    }
    console.log('--------------------------------------\n');
    server.close();
  } catch (error) {
    response.writeHead(500).end('Token exchange error');
    console.error(error);
    server.close();
  }
});

server.listen(port, () => {
  if (process.env.NO_BROWSER === '1') {
    console.log(`Open this URL manually:\n${authUrl.toString()}\n`);
    return;
  }
  const command = process.platform === 'win32'
    ? `start "" "${authUrl.toString()}"`
    : process.platform === 'darwin'
      ? `open "${authUrl.toString()}"`
      : `xdg-open "${authUrl.toString()}"`;
  exec(command, (error) => {
    if (error) console.log(`Could not open browser automatically. Open this URL manually:\n${authUrl.toString()}\n`);
  });
});

setTimeout(() => {
  console.error('Timed out after 5 minutes without a callback.');
  server.close();
  process.exit(1);
}, 5 * 60 * 1000).unref();
