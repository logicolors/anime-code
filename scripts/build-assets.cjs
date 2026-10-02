'use strict';
// Copies the published static files into dist/ for the Worker's asset binding.
// The allowlist matches the files server.cjs serves; nothing else is published.
const fs = require('node:fs');
const path = require('node:path');
const root = path.join(__dirname, '..');
const dist = path.join(root, 'dist');
const files = ['index.html', 'styles.css', 'app.js', 'multiplayer.js', 'game.js', 'entry.js', 'demo.js', 'fallback-data.js', 'anime_list.json'];
fs.rmSync(dist, {recursive: true, force: true});
fs.mkdirSync(dist);
for (const file of files) fs.copyFileSync(path.join(root, file), path.join(dist, file));
console.log(`Copied ${files.length} files to dist/`);
