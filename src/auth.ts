import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { CodeChallengeMethod, OAuth2Client, type Credentials } from 'google-auth-library';
import { paths, readJson, writePrivateJson } from './config.js';

/** Read-only: ktcal only displays events, so a leaked token can't change anything. */
export const SCOPE = 'https://www.googleapis.com/auth/calendar.readonly';

interface ClientFile {
  installed?: { client_id: string; client_secret: string };
  web?: { client_id: string; client_secret: string };
}

async function loadClientSecrets(): Promise<{ clientId: string; clientSecret: string }> {
  const file = await readJson<ClientFile>(paths.client);
  const app = file?.installed ?? file?.web;
  if (!app) throw new NotSetUpError(`No OAuth client at ${paths.client}`);
  return { clientId: app.client_id, clientSecret: app.client_secret };
}

export class NotSetUpError extends Error {}

/** An OAuth client with stored credentials; refreshed tokens are persisted automatically. */
export async function getAuthorizedClient(): Promise<OAuth2Client> {
  const client = new OAuth2Client(await loadClientSecrets());
  const token = await readJson<Credentials>(paths.token);
  if (!token?.refresh_token) throw new NotSetUpError('Not signed in');
  client.setCredentials(token);
  client.on('tokens', (fresh) => {
    // Refreshes omit the refresh_token: keep the one we have.
    void writePrivateJson(paths.token, { ...token, ...fresh, refresh_token: fresh.refresh_token ?? token.refresh_token });
  });
  return client;
}

/**
 * Browser sign-in using the loopback flow for Desktop-app clients: a one-shot HTTP
 * server on 127.0.0.1 receives the code; PKCE + state guard the exchange.
 */
export async function signIn(log: (msg: string) => void): Promise<void> {
  const secrets = await loadClientSecrets();
  const state = randomBytes(16).toString('hex');

  let resolveCode!: (code: string) => void;
  let rejectCode!: (err: Error) => void;
  const codePromise = new Promise<string>((resolve, reject) => {
    resolveCode = resolve;
    rejectCode = reject;
  });

  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    const code = url.searchParams.get('code');
    const error = url.searchParams.get('error');
    if (!code && !error) {
      res.writeHead(404).end();
      return;
    }
    const ok = code && url.searchParams.get('state') === state;
    // Connection: close so the browser doesn't hold a keep-alive socket that keeps ktcal running.
    res.writeHead(ok ? 200 : 400, { 'Content-Type': 'text/html; charset=utf-8', Connection: 'close' });
    res.end(
      ok
        ? '<h2>ktcal is signed in.</h2><p>You can close this tab and go back to the terminal.</p>'
        : `<h2>Sign-in failed</h2><p>${error ?? 'state mismatch'}</p>`,
    );
    if (ok) resolveCode(code);
    else rejectCode(new Error(`Google sign-in failed: ${error ?? 'state mismatch'}`));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const redirectUri = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  try {
    const client = new OAuth2Client({ ...secrets, redirectUri });
    const { codeVerifier, codeChallenge } = await client.generateCodeVerifierAsync();
    const url = client.generateAuthUrl({
      access_type: 'offline',
      prompt: 'consent', // always hand out a refresh token
      scope: [SCOPE],
      state,
      code_challenge: codeChallenge,
      code_challenge_method: CodeChallengeMethod.S256,
    });
    log(`Opening your browser for Google sign-in. If it doesn't open, visit:\n${url}`);
    spawn(process.platform === 'darwin' ? 'open' : 'xdg-open', [url], { stdio: 'ignore', detached: true })
      .on('error', () => {})
      .unref();

    const timeout = setTimeout(() => rejectCode(new Error('Timed out waiting for sign-in (5 min)')), 5 * 60_000);
    const code = await codePromise.finally(() => clearTimeout(timeout));
    const { tokens } = await client.getToken({ code, codeVerifier, redirect_uri: redirectUri });
    if (!tokens.refresh_token) throw new Error('Google returned no refresh token; try `ktcal setup` again');
    if (tokens.scope && !tokens.scope.split(' ').includes(SCOPE)) {
      throw new Error(`Granted scope was "${tokens.scope}", expected ${SCOPE}`);
    }
    await writePrivateJson(paths.token, tokens);
  } finally {
    server.close();
    server.closeAllConnections(); // drop idle browser connections so the process can exit now
  }
}

/** Revoke the refresh token at Google (best effort) and forget it locally. */
export async function signOut(): Promise<boolean> {
  const token = await readJson<Credentials>(paths.token);
  if (!token) return false;
  try {
    const client = new OAuth2Client(await loadClientSecrets());
    if (token.refresh_token) await client.revokeToken(token.refresh_token);
  } catch {
    // Already revoked / offline: deleting locally is still what the user asked for.
  }
  await rm(paths.token, { force: true });
  return true;
}
