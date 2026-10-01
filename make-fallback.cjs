const fs = require('node:fs');
const G = require('./game.js');
const data = JSON.parse(fs.readFileSync('anime_list.json','utf8'));
const records = G.filter(data).sort((a,b)=>b.vote_count-a.vote_count).slice(0,200);
fs.writeFileSync('fallback-data.js','// A local snapshot of 200 popular eligible Bangumi titles, including cover URLs.\nwindow.ANICODE_FALLBACK = '+JSON.stringify(records)+';\n');
console.log('Full pool:',G.filter(data).length,'Fallback:',records.length);
