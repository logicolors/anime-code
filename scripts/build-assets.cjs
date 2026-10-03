'use strict';
// Copies the published static files into dist/ for the Worker's asset binding.
// The allowlist matches the files server.cjs serves; nothing else is published.
// The data files are not in git, so a fresh checkout downloads them first.
const fs = require('node:fs');
const path = require('node:path');
const {execFileSync} = require('node:child_process');
const root = path.join(__dirname, '..');
execFileSync(process.execPath, [path.join(__dirname, 'update-data.cjs'), '--if-missing'], {stdio: 'inherit'});
const dist = path.join(root, 'dist');
const files = ['index.html', 'styles.css', 'app.js', 'multiplayer.js', 'game.js', 'entry.js', 'demo.js', 'fallback-data.js', 'anime_list.json'];
fs.rmSync(dist, {recursive: true, force: true});
fs.mkdirSync(dist);
for (const file of files) fs.copyFileSync(path.join(root, file), path.join(dist, file));
console.log(`Copied ${files.length} files to dist/`);
