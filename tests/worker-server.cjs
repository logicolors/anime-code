'use strict';
// Starts `wrangler dev` for the browser tests on free ports with its own empty
// storage, and resolves once the Worker answers. vars shorten the grace period
// and add a short turn limit so presence and timer paths run in seconds.
const {spawn, execFileSync} = require('node:child_process');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const root = path.join(__dirname, '..');
const wrangler = path.join(root, 'node_modules', 'wrangler', 'bin', 'wrangler.js');

const freePort = () => new Promise((resolve, reject) => {
  const server = net.createServer().once('error', reject);
  server.listen(0, '127.0.0.1', () => { const {port} = server.address(); server.close(() => resolve(port)); });
});

async function startWorker(vars = {}) {
  const [port, inspector] = [await freePort(), await freePort()];
  const state = fs.mkdtempSync(path.join(os.tmpdir(), 'anicode-worker-'));
  const args = [wrangler, 'dev', '--ip', '127.0.0.1', '--port', String(port), '--inspector-port', String(inspector), '--persist-to', state, '--log-level', 'warn'];
  for (const [key, value] of Object.entries(vars)) args.push('--var', `${key}:${value}`);
  const child = spawn(process.execPath, args, {cwd: root, stdio: ['ignore', 'pipe', 'pipe'], env: {...process.env, WRANGLER_SEND_METRICS: 'false', NO_COLOR: '1'}});
  let output = '';
  child.stdout.on('data', d => { output += d; });
  child.stderr.on('data', d => { output += d; });
  const base = `http://127.0.0.1:${port}`;
  const stop = async () => {
    if (child.exitCode === null) {
      // workerd runs as a grandchild; on Windows only a tree kill reaches it.
      if (process.platform === 'win32') { try { execFileSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], {stdio: 'ignore'}); } catch {} }
      else child.kill('SIGTERM');
      await new Promise(resolve => { if (child.exitCode !== null) resolve(); else child.once('exit', resolve); setTimeout(resolve, 5000); });
    }
    fs.rmSync(state, {recursive: true, force: true, maxRetries: 5, retryDelay: 200});
  };
  const deadline = Date.now() + 60000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) break;
    try { if ((await fetch(base + '/')).ok) return {base, stop, output: () => output}; } catch {}
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  await stop();
  throw new Error('wrangler dev did not start:\n' + output);
}

module.exports = {startWorker};
