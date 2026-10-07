import G from '../game.js';
export {RoomObject} from './room.mjs';

const MAX_BODY = 16384;
const json = (status, value) => Response.json(value, {status, headers:{'Cache-Control':'no-store'}});
// Same-origin only: a request with an Origin must come from this very host.
const sameOrigin = (request, url) => {
  const origin = request.headers.get('Origin');
  return !origin || origin === `http://${url.host}` || origin === `https://${url.host}`;
};
const roomCode = () => String(crypto.getRandomValues(new Uint32Array(1))[0] % 900000 + 100000);
const room = (env, code) => env.ROOMS.get(env.ROOMS.idFromName(code));
const call = (env, code, path, body) => room(env, code).fetch(`https://room${path}`, {method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify(body)});

async function enter(request, env) {
  const text = await request.text();
  if (text.length > MAX_BODY) return json(413, {error:'请求过大。'});
  let input; try { input = JSON.parse(text); } catch { return json(400, {error:'请求格式无效。'}); }
  if (!input || typeof input !== 'object') return json(400, {error:'请求格式无效。'});
  // The browser's id lets a retried join find the player its lost answer created.
  const {name, client} = input;
  if (input.action === 'create') {
    const dataDate = typeof input.dataDate === 'string' ? input.dataDate : G.dataDate;
    // A fresh code almost never collides; the DO refuses one that is taken.
    for (let attempt = 0; attempt < 5; attempt++) {
      const code = roomCode(), response = await call(env, code, '/create', {code, name, dataDate, client});
      if (response.status !== 409) return response;
    }
    return json(503, {error:'暂时无法创建房间，请重试。'});
  }
  if (input.action === 'join') {
    const code = typeof input.code === 'string' ? input.code.trim() : '';
    if (!/^\d{6}$/.test(code)) return json(400, {error:'请输入六位数字房间号。'});
    return call(env, code, '/join', {name, client});
  }
  return json(400, {error:'未知操作。'});
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    // A room link is /123456: it opens the same page, which reads the code from the path.
    if (/^\/\d{6}$/.test(url.pathname)) return env.ASSETS.fetch(new Request(new URL('/', url), request));
    if (!url.pathname.startsWith('/api/')) return new Response('Not found', {status:404});
    if (!sameOrigin(request, url)) return json(403, {error:'不允许跨站请求。'});
    if (url.pathname === '/api/enter') {
      if (request.method !== 'POST') return json(405, {error:'请求方法无效。'});
      return enter(request, env);
    }
    const match = url.pathname.match(/^\/api\/room\/(\d{6})\/ws$/);
    if (match) {
      if (request.headers.get('Upgrade') !== 'websocket') return json(426, {error:'需要 WebSocket 连接。'});
      return room(env, match[1]).fetch(new Request('https://room/ws', request));
    }
    return json(404, {error:'接口不存在。'});
  }
};
