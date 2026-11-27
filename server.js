'use strict';
/*
 * 교실 마피아 게임 서버
 * - 모든 게임 규칙과 직업 정보는 서버에만 있습니다.
 * - 학생에게는 "그 학생이 알아도 되는 정보"만 따로 골라서 보냅니다.
 */
const express = require('express');
const http = require('http');
const path = require('path');
const os = require('os');
const fs = require('fs');
const crypto = require('crypto');
const { spawn, exec } = require('child_process');
const { Server } = require('socket.io');
const QRCode = require('qrcode');
const { cleanText, hasBadWord } = require('./filter');

const PORT = Number(process.env.PORT) || 3000;
// Render 같은 인터넷 서버에서 실행 중인지 (Render는 RENDER, RENDER_EXTERNAL_URL을 자동으로 넣어 줌)
const ON_CLOUD = !!process.env.RENDER || !!process.env.PUBLIC_URL;
const PUBLIC_URL = String(process.env.PUBLIC_URL || process.env.RENDER_EXTERNAL_URL || '').replace(/\/+$/, '');
// 선생님 비밀번호 (숫자 4~12자리). 정하지 않으면 서버를 켤 때마다 새로 만들어 검은 창에 보여 줌
const PIN_FROM_ENV = /^\d{4,12}$/.test(process.env.TEACHER_PIN || '');
const TEACHER_PIN = PIN_FROM_ENV ? process.env.TEACHER_PIN : String(crypto.randomInt(0, 1000000)).padStart(6, '0');
// 인터넷 주소(Cloudflare 터널) 사용 여부. 인터넷 서버에서는 필요 없음. 같은 와이파이에서만 쓰려면 TUNNEL=0
const USE_TUNNEL = !PUBLIC_URL && !ON_CLOUD && process.env.TUNNEL !== '0';
const OPEN_BROWSER = !ON_CLOUD && process.env.OPEN_BROWSER !== '0';
const MIN_PLAYERS = Number(process.env.MIN_PLAYERS) || 6;
const MAX_PLAYERS = 16;
const NAME_MAX = 10;
const CHAT_MAX = 120;
const CHAT_KEEP = 150;

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const ROLE_NAMES = { mafia: '마피아', doctor: '의사', police: '경찰', citizen: '시민' };

// 선생님 화면 자체는 누구나 열 수 있지만, 비밀번호 없이는 아무것도 조작하거나 볼 수 없음
app.get('/teacher', (_req, res) => res.sendFile(path.join(__dirname, 'views', 'teacher.html')));
// 상태 확인용 (Render 무료 서버가 수업 중에 잠들지 않도록 선생님 화면이 주기적으로 호출)
app.get('/healthz', (_req, res) => res.type('text').send('ok'));
app.use(express.static(path.join(__dirname, 'public')));

// ───────────────────────── 선생님 비밀번호 ─────────────────────────
const pinFails = new Map(); // ip -> { count, until }
function clientIp(socket) {
  const h = socket.handshake.headers;
  return h['cf-connecting-ip'] || String(h['x-forwarded-for'] || '').split(',')[0].trim() || socket.handshake.address;
}
function checkPin(socket, pin) {
  const ip = clientIp(socket);
  const f = pinFails.get(ip) || { count: 0, until: 0 };
  if (Date.now() < f.until) return '비밀번호를 여러 번 틀려서 5분 동안 잠겼어요.';
  const a = Buffer.from(String(pin || ''));
  const b = Buffer.from(TEACHER_PIN);
  if (a.length === b.length && crypto.timingSafeEqual(a, b)) {
    pinFails.delete(ip);
    return null;
  }
  f.count++;
  if (f.count >= 5) {
    f.until = Date.now() + 5 * 60 * 1000;
    f.count = 0;
  }
  pinFails.set(ip, f);
  return '선생님 비밀번호가 맞지 않아요.';
}

// ───────────────────────── 인터넷 주소 (Cloudflare 터널) ─────────────────────────
// status: off | starting | connecting | on | error
let tunnel = PUBLIC_URL
  ? { status: 'on', url: PUBLIC_URL, error: null, fixed: true }
  : { status: USE_TUNNEL ? 'starting' : 'off', url: null, error: null };

function findCloudflared() {
  const candidates = [
    process.env.CLOUDFLARED,
    path.join(__dirname, 'cloudflared.exe'),
    'C:\\Program Files (x86)\\cloudflared\\cloudflared.exe',
    'C:\\Program Files\\cloudflared\\cloudflared.exe',
  ].filter(Boolean);
  return candidates.find((p) => fs.existsSync(p)) || 'cloudflared';
}

function setTunnel(next) {
  tunnel = { ...tunnel, ...next };
  broadcastInfo();
}

function startTunnel() {
  const bin = findCloudflared();
  let child;
  try {
    child = spawn(bin, ['tunnel', '--no-autoupdate', '--url', `http://localhost:${PORT}`], { windowsHide: true });
  } catch (e) {
    return setTunnel({ status: 'error', error: e.message });
  }
  const onData = (buf) => {
    const text = String(buf);
    const m = text.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/);
    if (m && tunnel.url !== m[0]) {
      setTunnel({ status: 'connecting', url: m[0], error: null });
    }
    if (/Registered tunnel connection/i.test(text) && tunnel.url && tunnel.status !== 'on') {
      setTunnel({ status: 'on' });
      console.log('');
      console.log('  ✅ 인터넷 주소가 준비되었어요 (학생은 이 주소로 접속):');
      console.log(`     ${tunnel.url}`);
      console.log('');
    }
  };
  child.stdout.on('data', onData);
  child.stderr.on('data', onData);
  child.on('error', (e) => {
    setTunnel({
      status: 'error',
      url: null,
      error: e.code === 'ENOENT' ? 'cloudflared 프로그램을 찾지 못했어요. README의 설치 방법을 확인하세요.' : `터널 오류: ${e.message}`,
    });
  });
  child.on('exit', (code) => {
    if (tunnel.status === 'error') return;
    const neverStarted = !tunnel.url;
    setTunnel({
      status: 'error',
      url: null,
      error: neverStarted
        ? '이 네트워크에서는 인터넷 주소(터널)를 만들 수 없어요. 학교 보안 프로그램이 막고 있을 수 있어요. 같은 와이파이 주소를 쓰거나 정보 담당 선생님께 문의하세요.'
        : `인터넷 연결(터널)이 끊겼어요 (코드 ${code}). 서버를 껐다가 다시 켜 주세요.`,
    });
    if (neverStarted) console.log('\n  [!] 인터넷 주소(터널)를 만들지 못했어요. 학교 네트워크가 막고 있을 수 있어요.\n');
  });
  const stop = () => {
    try { child.kill(); } catch {}
  };
  process.on('exit', stop);
  for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
    process.on(sig, () => {
      stop();
      process.exit(0);
    });
  }
}

async function broadcastInfo() {
  for (const room of rooms.values()) {
    if (!room.hostSockets.size) continue;
    const info = await joinInfo(room);
    for (const sid of room.hostSockets) io.to(sid).emit('host:info', info);
  }
}

// ───────────────────────── 유틸 ─────────────────────────
const rooms = new Map();
const randId = (bytes = 8) => crypto.randomBytes(bytes).toString('hex');

function newCode() {
  let code;
  do code = String(crypto.randomInt(0, 10000)).padStart(4, '0');
  while (rooms.has(code));
  return code;
}

function shuffle(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = crypto.randomInt(0, i + 1);
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

function lanAddresses() {
  const list = [];
  for (const [name, addrs] of Object.entries(os.networkInterfaces())) {
    for (const a of addrs || []) {
      if (a.family === 'IPv4' && !a.internal) list.push({ name, address: a.address });
    }
  }
  // 와이파이/이더넷을 앞으로, 가상 어댑터는 뒤로
  const score = (n) => (/wi-?fi|wlan|무선|wireless/i.test(n) ? 0 : /ethernet|이더넷/i.test(n) ? 1 : /vethernet|virtual|vmware|vbox|hyper-v|wsl|docker/i.test(n) ? 3 : 2);
  list.sort((a, b) => score(a.name) - score(b.name));
  return list;
}

function safeAck(ack) {
  return typeof ack === 'function' ? ack : () => {};
}

// ───────────────────────── 방 ─────────────────────────
function createRoom() {
  const room = {
    code: newCode(),
    hostToken: randId(16),
    hostSockets: new Set(),
    settings: {
      mafia: 2,
      doctor: true,
      police: true,
      day: 180,
      vote: 60,
      night: 60,
      result: 10,
      revealRole: false,
      chat: true,
      extraWords: [],
    },
    players: new Map(), // id -> player
    banned: new Set(), // 내보낸 학생의 token
    phase: 'lobby', // lobby | day | vote | voteResult | night | morning | end
    day: 0,
    timer: { active: false, paused: false, endsAt: 0, remaining: 0 },
    votes: new Map(), // voterId -> targetId | 'skip'
    night: emptyNight(),
    lastResult: null,
    log: [],
    chats: { public: [], mafia: [], dead: [] },
    winner: null,
    lastActivity: Date.now(),
  };
  rooms.set(room.code, room);
  return room;
}

function emptyNight() {
  return { mafia: null, mafiaBy: null, doctor: null, police: null, suspects: new Map() };
}

const inGame = (room) => room.phase !== 'lobby' && room.phase !== 'end';
const alivePlayers = (room) => [...room.players.values()].filter((p) => p.alive);
const findRole = (room, role) => [...room.players.values()].filter((p) => p.role === role);

function addLog(room, text) {
  room.log.push({ t: Date.now(), text });
  if (room.log.length > 80) room.log.shift();
}

function addChat(room, channel, msg) {
  const list = room.chats[channel];
  list.push({ id: randId(4), t: Date.now(), ...msg });
  if (list.length > CHAT_KEEP) list.shift();
}

// ───────────────────────── 타이머 ─────────────────────────
function setTimer(room, sec) {
  room.timer = { active: sec > 0, paused: false, endsAt: Date.now() + sec * 1000, remaining: sec * 1000 };
}
function remainingMs(room) {
  const t = room.timer;
  if (!t.active) return 0;
  return t.paused ? t.remaining : Math.max(0, t.endsAt - Date.now());
}
function adjustTimer(room, deltaSec) {
  const t = room.timer;
  if (!t.active) return;
  if (t.paused) t.remaining = Math.max(1000, t.remaining + deltaSec * 1000);
  else t.endsAt = Math.max(Date.now() + 1000, t.endsAt + deltaSec * 1000);
}
function togglePause(room) {
  const t = room.timer;
  if (!t.active) return;
  if (t.paused) {
    t.endsAt = Date.now() + t.remaining;
    t.paused = false;
  } else {
    t.remaining = remainingMs(room);
    t.paused = true;
  }
}
// 모두 선택을 마쳤으면 몇 초 뒤 자동으로 넘어가도록 시간을 줄임
function shortenTimer(room, sec) {
  const t = room.timer;
  if (t.active && !t.paused && remainingMs(room) > sec * 1000) t.endsAt = Date.now() + sec * 1000;
}
function timerPayload(room) {
  return { remaining: Math.ceil(remainingMs(room) / 1000), paused: room.timer.paused, active: room.timer.active };
}

setInterval(() => {
  const now = Date.now();
  for (const room of rooms.values()) {
    if (room.timer.active && !room.timer.paused && now >= room.timer.endsAt) advance(room);
    io.to(room.code).emit('timer', timerPayload(room));
    // 3시간 동안 아무도 없으면 방 정리
    const someone = room.hostSockets.size > 0 || [...room.players.values()].some((p) => p.connected);
    if (!someone && now - room.lastActivity > 3 * 60 * 60 * 1000) rooms.delete(room.code);
  }
}, 1000);

// ───────────────────────── 게임 진행 ─────────────────────────
function startGame(room) {
  const players = [...room.players.values()];
  const n = players.length;
  const s = room.settings;
  if (n < MIN_PLAYERS) return `최소 ${MIN_PLAYERS}명이 필요해요. (현재 ${n}명)`;
  if (n > MAX_PLAYERS) return `최대 ${MAX_PLAYERS}명까지 할 수 있어요.`;
  if (s.mafia >= n - s.mafia) return `마피아 ${s.mafia}명은 ${n}명에게 너무 많아요. 마피아 수를 줄여 주세요.`;
  const roles = [];
  for (let i = 0; i < s.mafia; i++) roles.push('mafia');
  if (s.doctor) roles.push('doctor');
  if (s.police) roles.push('police');
  if (roles.length > n) return '직업 수가 인원보다 많아요.';
  while (roles.length < n) roles.push('citizen');
  shuffle(roles);
  shuffle(players).forEach((p, i) => {
    p.role = roles[i];
    p.alive = true;
    p.diedDay = null;
    p.diedBy = null;
    p.policeResults = [];
    p.prediction = [];
  });
  room.chats = { public: [], mafia: [], dead: [] };
  room.log = [];
  room.winner = null;
  room.lastResult = null;
  room.day = 1;
  addLog(room, `게임 시작! ${n}명 (마피아 ${s.mafia}${s.doctor ? ', 의사 1' : ''}${s.police ? ', 경찰 1' : ''})`);
  addChat(room, 'public', { system: true, text: '게임이 시작되었습니다. 자기 직업을 몰래 확인하세요!' });
  enterPhase(room, 'day');
  return null;
}

function resetToLobby(room) {
  for (const p of room.players.values()) {
    p.role = null;
    p.alive = true;
    p.diedDay = null;
    p.diedBy = null;
    p.policeResults = [];
    p.prediction = [];
  }
  room.phase = 'lobby';
  room.day = 0;
  room.timer = { active: false, paused: false, endsAt: 0, remaining: 0 };
  room.votes.clear();
  room.night = emptyNight();
  room.lastResult = null;
  room.winner = null;
  room.log = [];
  room.chats = { public: [], mafia: [], dead: [] };
  addChat(room, 'public', { system: true, text: '대기실로 돌아왔습니다. 선생님이 새 게임을 시작할 거예요.' });
  sync(room);
}

function enterPhase(room, phase) {
  const s = room.settings;
  room.phase = phase;
  switch (phase) {
    case 'day':
      setTimer(room, s.day);
      addLog(room, `${room.day}일차 낮 토론 시작`);
      addChat(room, 'public', { system: true, text: `☀️ ${room.day}일차 낮입니다. 토론을 시작하세요.` });
      break;
    case 'vote':
      room.votes.clear();
      setTimer(room, s.vote);
      addChat(room, 'public', { system: true, text: '🗳️ 투표 시간입니다.' });
      break;
    case 'voteResult':
      resolveVote(room);
      setTimer(room, s.result);
      break;
    case 'night':
      room.night = emptyNight();
      setTimer(room, s.night);
      addChat(room, 'public', { system: true, text: `🌙 ${room.day}일차 밤이 되었습니다.` });
      addChat(room, 'mafia', { system: true, text: `🌙 ${room.day}일차 밤: 마피아끼리 상의해서 대상을 고르세요.` });
      break;
    case 'morning':
      room.day += 1;
      resolveNight(room);
      setTimer(room, s.result);
      break;
    case 'end':
      room.timer = { active: false, paused: false, endsAt: 0, remaining: 0 };
      break;
  }
  sync(room);
}

function advance(room) {
  switch (room.phase) {
    case 'day':
      return enterPhase(room, 'vote');
    case 'vote':
      return enterPhase(room, 'voteResult');
    case 'voteResult':
      return room.winner ? endGame(room) : enterPhase(room, 'night');
    case 'night':
      return enterPhase(room, 'morning');
    case 'morning':
      return room.winner ? endGame(room) : enterPhase(room, 'day');
  }
}

function kill(room, p, by) {
  p.alive = false;
  p.diedDay = room.day;
  p.diedBy = by;
}

function publicDead(room, p) {
  return { id: p.id, name: p.name, role: room.settings.revealRole ? p.role : null };
}

function resolveVote(room) {
  const alive = alivePlayers(room);
  const counts = new Map();
  let skip = 0;
  let voted = 0;
  for (const [voterId, target] of room.votes) {
    const v = room.players.get(voterId);
    if (!v || !v.alive) continue;
    voted++;
    if (target === 'skip') {
      skip++;
      continue;
    }
    const t = room.players.get(target);
    if (!t || !t.alive) continue;
    counts.set(target, (counts.get(target) || 0) + 1);
  }
  const tally = [...counts.entries()]
    .map(([id, count]) => ({ id, name: room.players.get(id).name, count }))
    .sort((a, b) => b.count - a.count);

  let executed = null;
  let reason = null;
  if (!tally.length) reason = 'none';
  else {
    const top = tally[0].count;
    const tops = tally.filter((t) => t.count === top);
    if (tops.length > 1) reason = 'tie';
    else if (skip >= top) reason = 'skip';
    else executed = room.players.get(tops[0].id);
  }

  if (executed) {
    kill(room, executed, 'vote');
    addLog(room, `${room.day}일차 투표: ${executed.name} 처형 (${ROLE_NAMES[executed.role]})`);
    addChat(room, 'public', {
      system: true,
      text: `⚖️ 투표 결과 ${executed.name}님이 처형되었습니다.` + (room.settings.revealRole ? ` (${ROLE_NAMES[executed.role]})` : ''),
    });
  } else {
    const why = { tie: '동점이라', skip: '기권이 많아서', none: '표가 없어서' }[reason];
    addLog(room, `${room.day}일차 투표: ${why} 아무도 처형되지 않음`);
    addChat(room, 'public', { system: true, text: `⚖️ ${why} 아무도 처형되지 않았습니다.` });
  }
  room.lastResult = {
    kind: 'vote',
    day: room.day,
    executed: executed ? publicDead(room, executed) : null,
    reason,
    tally: tally.map(({ name, count }) => ({ name, count })),
    skip,
    notVoted: alive.length - voted,
  };
  checkWin(room);
}

function resolveNight(room) {
  const n = room.night;
  const target = n.mafia ? room.players.get(n.mafia) : null;
  let killed = null;
  let saved = false;
  if (target && target.alive) {
    if (n.doctor && n.doctor === target.id) saved = true;
    else {
      kill(room, target, 'mafia');
      killed = target;
    }
  }
  // 경찰 조사 결과 (경찰 본인에게만 전달)
  const police = findRole(room, 'police')[0];
  if (police && n.police) {
    const t = room.players.get(n.police);
    if (t) police.policeResults.push({ day: room.day - 1, name: t.name, isMafia: t.role === 'mafia' });
  }

  const doctorTarget = n.doctor ? room.players.get(n.doctor) : null;
  const policeTarget = n.police ? room.players.get(n.police) : null;
  addLog(
    room,
    `${room.day - 1}일차 밤: 마피아→${target ? target.name : '없음'}, 의사→${doctorTarget ? doctorTarget.name : '없음'}, 경찰→${policeTarget ? policeTarget.name : '없음'} ⇒ ` +
      (killed ? `${killed.name} 사망` : saved ? '의사가 살림' : '사망자 없음')
  );
  if (killed) {
    addChat(room, 'public', {
      system: true,
      text: `🌅 ${room.day}일차 아침. 지난밤 ${killed.name}님이 마피아에게 당했습니다.` + (room.settings.revealRole ? ` (${ROLE_NAMES[killed.role]})` : ''),
    });
  } else {
    addChat(room, 'public', {
      system: true,
      text: saved ? `🌅 ${room.day}일차 아침. 누군가 공격받았지만 의사가 살려냈습니다!` : `🌅 ${room.day}일차 아침. 지난밤에는 아무 일도 없었습니다.`,
    });
  }
  room.lastResult = { kind: 'morning', day: room.day, killed: killed ? publicDead(room, killed) : null, saved };
  checkWin(room);
}

function checkWin(room) {
  const alive = alivePlayers(room);
  const mafia = alive.filter((p) => p.role === 'mafia').length;
  const others = alive.length - mafia;
  if (mafia === 0) room.winner = 'citizen';
  else if (mafia >= others) room.winner = 'mafia';
  return room.winner;
}

function endGame(room) {
  addLog(room, room.winner === 'mafia' ? '마피아 승리!' : '시민 승리!');
  addChat(room, 'public', { system: true, text: room.winner === 'mafia' ? '🔪 마피아 팀이 승리했습니다!' : '🎉 시민 팀이 승리했습니다!' });
  enterPhase(room, 'end');
}

function nightActionsDone(room) {
  const alive = alivePlayers(room);
  const n = room.night;
  if (alive.some((p) => p.role === 'mafia') && !n.mafia) return false;
  if (alive.some((p) => p.role === 'doctor') && !n.doctor) return false;
  if (alive.some((p) => p.role === 'police') && !n.police) return false;
  return true;
}

// ───────────────────────── 화면에 보낼 정보 ─────────────────────────
function predictionScores(room) {
  return [...room.players.values()]
    .filter((p) => !p.alive && p.prediction && p.prediction.length)
    .map((p) => ({
      name: p.name,
      picks: p.prediction.map((id) => room.players.get(id)).filter(Boolean).map((t) => ({ name: t.name, correct: t.role === 'mafia' })),
    }))
    .map((r) => ({ ...r, correct: r.picks.filter((x) => x.correct).length }))
    .sort((a, b) => b.correct - a.correct);
}

function playerView(room, me) {
  const started = room.phase !== 'lobby';
  const ended = room.phase === 'end';
  const isMafia = started && me.role === 'mafia';
  const s = room.settings;

  const players = [...room.players.values()].map((p) => {
    let role = null;
    if (started) {
      if (ended || p.id === me.id) role = p.role;
      else if (isMafia && p.role === 'mafia') role = 'mafia';
      else if (!p.alive && s.revealRole) role = p.role;
    }
    return { id: p.id, name: p.name, alive: p.alive, connected: p.connected, role };
  });

  let myAction = null;
  if (room.phase === 'vote') myAction = room.votes.get(me.id) || null;
  if (room.phase === 'night' && me.alive) {
    if (me.role === 'mafia') myAction = room.night.mafia;
    else if (me.role === 'doctor') myAction = room.night.doctor;
    else if (me.role === 'police') myAction = room.night.police;
    else myAction = room.night.suspects.get(me.id) || null;
  }
  const mafiaBy = isMafia && room.night.mafiaBy ? room.players.get(room.night.mafiaBy) : null;

  const chats = { public: room.chats.public };
  if (isMafia || ended) chats.mafia = room.chats.mafia;
  if ((started && !me.alive) || ended) chats.dead = room.chats.dead;

  const canChat = {
    public: s.chat && (ended || room.phase === 'lobby' || (me.alive && room.phase !== 'night')),
    mafia: s.chat && isMafia && me.alive && room.phase === 'night',
    dead: s.chat && started && !ended && !me.alive,
  };

  return {
    code: room.code,
    phase: room.phase,
    day: room.day,
    timer: timerPayload(room),
    settings: { mafia: s.mafia, doctor: s.doctor, police: s.police, revealRole: s.revealRole, minPlayers: MIN_PLAYERS, maxPlayers: MAX_PLAYERS },
    me: { id: me.id, name: me.name, alive: me.alive, role: started ? me.role : null },
    players,
    myAction,
    mafiaBy: mafiaBy ? mafiaBy.name : null,
    voteProgress: room.phase === 'vote' ? { done: [...room.votes.keys()].filter((id) => room.players.get(id)?.alive).length, total: alivePlayers(room).length } : null,
    policeResults: started && me.role === 'police' ? me.policeResults : [],
    prediction: started && !me.alive ? me.prediction : [],
    lastResult: room.lastResult,
    chats,
    canChat,
    winner: ended ? room.winner : null,
    predictions: ended ? predictionScores(room) : null,
  };
}

function hostView(room) {
  const name = (id) => (id && id !== 'skip' ? room.players.get(id)?.name || '?' : id === 'skip' ? '기권' : null);
  return {
    code: room.code,
    phase: room.phase,
    day: room.day,
    timer: timerPayload(room),
    settings: room.settings,
    limits: { minPlayers: MIN_PLAYERS, maxPlayers: MAX_PLAYERS },
    players: [...room.players.values()].map((p) => ({
      id: p.id,
      name: p.name,
      alive: p.alive,
      connected: p.connected,
      role: p.role,
      vote: room.phase === 'vote' ? name(room.votes.get(p.id)) : null,
      prediction: (p.prediction || []).map(name),
      policeResults: p.policeResults || [],
    })),
    night: {
      mafia: name(room.night.mafia),
      mafiaBy: name(room.night.mafiaBy),
      doctor: name(room.night.doctor),
      police: name(room.night.police),
    },
    lastResult: room.lastResult,
    log: room.log,
    chats: room.chats,
    winner: room.winner,
    predictions: predictionScores(room),
  };
}

function sync(room) {
  room.lastActivity = Date.now();
  for (const p of room.players.values()) {
    if (p.socketId) io.to(p.socketId).emit('state', playerView(room, p));
  }
  if (room.hostSockets.size) {
    const hv = hostView(room);
    for (const sid of room.hostSockets) io.to(sid).emit('hostState', hv);
  }
}

async function joinInfo(room) {
  const lan = ON_CLOUD ? [] : lanAddresses().map((a) => ({ name: a.name, url: `http://${a.address}:${PORT}/?code=${room.code}` }));
  const internet = tunnel.url ? `${tunnel.url}/?code=${room.code}` : null;
  // 인터넷 주소가 있으면 그것을, 터널을 안 쓰면 같은 와이파이 주소를 QR로
  const qrTarget = tunnel.status === 'on' ? internet : tunnel.status === 'off' ? lan[0]?.url : null;
  let qr = null;
  if (qrTarget) {
    try {
      qr = await QRCode.toDataURL(qrTarget, { margin: 1, width: 260 });
    } catch {
      qr = null;
    }
  }
  return {
    tunnel: { status: tunnel.status, error: tunnel.error, fixed: !!tunnel.fixed },
    internet,
    shortInternet: tunnel.url ? tunnel.url.replace(/^https?:\/\//, '') : null,
    lan,
    qr,
    localUrl: ON_CLOUD ? null : `http://localhost:${PORT}/?code=${room.code}`,
  };
}

// ───────────────────────── 소켓 ─────────────────────────
io.on('connection', (socket) => {
  const getPlayerCtx = () => {
    const room = rooms.get(socket.data.code);
    if (!room) return {};
    const me = room.players.get(socket.data.pid);
    if (!me || me.socketId !== socket.id) return {};
    return { room, me };
  };
  const getHostRoom = () => {
    const room = rooms.get(socket.data.hostCode);
    if (!room || !room.hostSockets.has(socket.id)) return null;
    return room;
  };

  // ── 학생 ──
  socket.on('join', (data, ack) => {
    ack = safeAck(ack);
    data = data || {};
    const code = String(data.code || '').trim();
    const room = rooms.get(code);
    if (!room) return ack({ ok: false, error: '방 코드를 찾을 수 없어요. 선생님께 코드를 다시 확인하세요.' });

    // 이전에 들어왔던 학생이면 다시 연결
    const token = typeof data.token === 'string' ? data.token : '';
    if (token && room.banned.has(token)) return ack({ ok: false, error: '선생님이 이 방에서 내보냈어요.' });
    const existing = token && [...room.players.values()].find((p) => p.token === token);
    if (existing) {
      if (existing.socketId && existing.socketId !== socket.id) {
        io.to(existing.socketId).emit('replaced');
      }
      existing.socketId = socket.id;
      existing.connected = true;
      socket.data.code = room.code;
      socket.data.pid = existing.id;
      socket.join(room.code);
      ack({ ok: true, token: existing.token, code: room.code, name: existing.name });
      return sync(room);
    }

    const name = String(data.name || '').trim().replace(/\s+/g, ' ');
    if (!name) return ack({ ok: false, error: '닉네임을 입력하세요.' });
    if ([...name].length > NAME_MAX) return ack({ ok: false, error: `닉네임은 ${NAME_MAX}글자까지 쓸 수 있어요.` });
    if (hasBadWord(name, room.settings.extraWords)) return ack({ ok: false, error: '사용할 수 없는 닉네임이에요.' });
    if (/사회자|선생님|관리자/.test(name)) return ack({ ok: false, error: '그 닉네임은 쓸 수 없어요.' });
    if (room.phase !== 'lobby') return ack({ ok: false, error: '이미 게임이 시작되었어요. 다음 판을 기다려 주세요.' });
    if (room.players.size >= MAX_PLAYERS) return ack({ ok: false, error: `방이 가득 찼어요. (최대 ${MAX_PLAYERS}명)` });
    if ([...room.players.values()].some((p) => p.name === name)) return ack({ ok: false, error: '이미 같은 닉네임이 있어요.' });

    const player = {
      id: randId(4),
      token: randId(16),
      name,
      socketId: socket.id,
      connected: true,
      alive: true,
      role: null,
      policeResults: [],
      prediction: [],
      lastChat: 0,
    };
    room.players.set(player.id, player);
    socket.data.code = room.code;
    socket.data.pid = player.id;
    socket.join(room.code);
    addChat(room, 'public', { system: true, text: `${name}님이 들어왔습니다.` });
    ack({ ok: true, token: player.token, code: room.code, name });
    sync(room);
  });

  socket.on('leave', () => {
    const { room, me } = getPlayerCtx();
    if (!room) return;
    socket.leave(room.code);
    socket.data.code = null;
    if (room.phase === 'lobby') {
      room.players.delete(me.id);
      addChat(room, 'public', { system: true, text: `${me.name}님이 나갔습니다.` });
    } else {
      me.socketId = null;
      me.connected = false;
    }
    sync(room);
  });

  socket.on('chat', (data) => {
    const { room, me } = getPlayerCtx();
    if (!room || !data) return;
    const channel = data.channel;
    const view = playerView(room, me);
    if (!['public', 'mafia', 'dead'].includes(channel) || !view.canChat[channel]) return;
    const raw = String(data.text || '').trim().slice(0, CHAT_MAX);
    if (!raw) return;
    const now = Date.now();
    if (now - me.lastChat < 700) return; // 도배 방지
    me.lastChat = now;
    addChat(room, channel, { from: me.id, name: me.name, text: cleanText(raw, room.settings.extraWords) });
    sync(room);
  });

  socket.on('vote', (data) => {
    const { room, me } = getPlayerCtx();
    if (!room || room.phase !== 'vote' || !me.alive || !data) return;
    const target = data.target;
    if (target !== 'skip') {
      const t = room.players.get(target);
      if (!t || !t.alive || t.id === me.id) return;
    }
    room.votes.set(me.id, target);
    const aliveIds = alivePlayers(room).map((p) => p.id);
    if (aliveIds.every((id) => room.votes.has(id))) shortenTimer(room, 3);
    sync(room);
  });

  socket.on('nightAction', (data) => {
    const { room, me } = getPlayerCtx();
    if (!room || room.phase !== 'night' || !me.alive || !data) return;
    const t = room.players.get(data.target);
    if (!t || !t.alive) return;
    if (me.role === 'mafia') {
      if (t.role === 'mafia') return;
      room.night.mafia = t.id;
      room.night.mafiaBy = me.id;
    } else if (me.role === 'doctor') {
      room.night.doctor = t.id;
    } else if (me.role === 'police') {
      if (t.id === me.id) return;
      room.night.police = t.id;
    } else {
      // 시민도 화면을 누르게 해서 누가 특수 직업인지 티 나지 않게 함 (결과에는 영향 없음)
      if (t.id === me.id) return;
      room.night.suspects.set(me.id, t.id);
    }
    if (nightActionsDone(room)) shortenTimer(room, 5);
    sync(room);
  });

  socket.on('predict', (data) => {
    const { room, me } = getPlayerCtx();
    if (!room || !inGame(room) || me.alive || !data || !Array.isArray(data.ids)) return;
    const ids = [...new Set(data.ids)].filter((id) => id !== me.id && room.players.has(id)).slice(0, room.settings.mafia);
    me.prediction = ids;
    sync(room);
  });

  // ── 선생님 ──
  socket.on('host:create', async (data, ack) => {
    ack = safeAck(ack);
    const err = checkPin(socket, data?.pin);
    if (err) return ack({ ok: false, needPin: true, error: err });
    const room = createRoom();
    room.hostSockets.add(socket.id);
    socket.data.hostCode = room.code;
    socket.join(room.code);
    ack({ ok: true, code: room.code, token: room.hostToken, info: await joinInfo(room) });
    sync(room);
  });

  socket.on('host:resume', async (data, ack) => {
    ack = safeAck(ack);
    const err = checkPin(socket, data?.pin);
    if (err) return ack({ ok: false, needPin: true, error: err });
    const room = rooms.get(String(data?.code || ''));
    if (!room || room.hostToken !== data?.token) return ack({ ok: false, error: '방이 없어요.' });
    room.hostSockets.add(socket.id);
    socket.data.hostCode = room.code;
    socket.join(room.code);
    ack({ ok: true, code: room.code, token: room.hostToken, info: await joinInfo(room) });
    sync(room);
  });

  socket.on('host:settings', (data, ack) => {
    ack = safeAck(ack);
    const room = getHostRoom();
    if (!room || !data) return;
    const s = room.settings;
    const int = (v, min, max) => {
      const n = Math.round(Number(v));
      return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : null;
    };
    if (room.phase === 'lobby' || room.phase === 'end') {
      if (data.mafia !== undefined) s.mafia = int(data.mafia, 1, 4) ?? s.mafia;
      if (data.doctor !== undefined) s.doctor = !!data.doctor;
      if (data.police !== undefined) s.police = !!data.police;
    }
    if (data.day !== undefined) s.day = int(data.day, 10, 900) ?? s.day;
    if (data.vote !== undefined) s.vote = int(data.vote, 10, 300) ?? s.vote;
    if (data.night !== undefined) s.night = int(data.night, 10, 300) ?? s.night;
    if (data.result !== undefined) s.result = int(data.result, 3, 60) ?? s.result;
    if (data.revealRole !== undefined) s.revealRole = !!data.revealRole;
    if (data.chat !== undefined) s.chat = !!data.chat;
    if (Array.isArray(data.extraWords)) {
      s.extraWords = data.extraWords.map((w) => String(w).trim().slice(0, 20)).filter(Boolean).slice(0, 100);
    }
    ack({ ok: true });
    sync(room);
  });

  socket.on('host:start', (_d, ack) => {
    ack = safeAck(ack);
    const room = getHostRoom();
    if (!room) return;
    if (room.phase !== 'lobby' && room.phase !== 'end') return ack({ ok: false, error: '이미 게임 중이에요.' });
    if (room.phase === 'end') resetToLobby(room);
    const err = startGame(room);
    ack(err ? { ok: false, error: err } : { ok: true });
  });

  socket.on('host:next', () => {
    const room = getHostRoom();
    if (room && inGame(room)) advance(room);
  });

  socket.on('host:time', (data) => {
    const room = getHostRoom();
    if (!room) return;
    adjustTimer(room, Math.max(-600, Math.min(600, Number(data?.delta) || 0)));
    io.to(room.code).emit('timer', timerPayload(room));
    sync(room);
  });

  socket.on('host:pause', () => {
    const room = getHostRoom();
    if (!room) return;
    togglePause(room);
    io.to(room.code).emit('timer', timerPayload(room));
    sync(room);
  });

  socket.on('host:kick', (data) => {
    const room = getHostRoom();
    const p = room && room.players.get(data?.id);
    if (!p) return;
    room.banned.add(p.token);
    room.players.delete(p.id);
    room.votes.delete(p.id);
    if (p.socketId) {
      io.to(p.socketId).emit('kicked');
      const s = io.sockets.sockets.get(p.socketId);
      if (s) {
        s.leave(room.code);
        s.data.code = null;
      }
    }
    addChat(room, 'public', { system: true, text: `${p.name}님이 퇴장했습니다.` });
    if (inGame(room)) {
      addLog(room, `${p.name} 퇴장 (${ROLE_NAMES[p.role] || '-'})`);
      if (checkWin(room)) return endGame(room);
    }
    sync(room);
  });

  socket.on('host:restart', () => {
    const room = getHostRoom();
    if (room) resetToLobby(room);
  });

  socket.on('host:announce', (data) => {
    const room = getHostRoom();
    if (!room) return;
    const text = String(data?.text || '').trim().slice(0, 200);
    if (!text) return;
    addChat(room, 'public', { host: true, name: '사회자', text });
    sync(room);
  });

  socket.on('disconnect', () => {
    const hostRoom = rooms.get(socket.data.hostCode);
    if (hostRoom) hostRoom.hostSockets.delete(socket.id);
    const { room, me } = getPlayerCtx();
    if (room) {
      me.socketId = null;
      me.connected = false;
      sync(room);
    }
  });
});

server.on('error', (e) => {
  if (e.code === 'EADDRINUSE') {
    console.log(`\n  [!] ${PORT}번 포트를 이미 쓰고 있어요. 서버 창이 이미 켜져 있는지 확인하세요.\n`);
  } else console.log(e);
  process.exit(1);
});

server.listen(PORT, '0.0.0.0', () => {
  if (ON_CLOUD) {
    console.log(`교실 마피아 서버 시작 (포트 ${PORT})`);
    console.log(`학생 주소: ${PUBLIC_URL || '(Render 주소)'}   선생님 화면: ${PUBLIC_URL}/teacher`);
    if (PIN_FROM_ENV) console.log('선생님 비밀번호: TEACHER_PIN 환경 변수에 설정된 값을 사용합니다.');
    else console.log(`⚠ TEACHER_PIN 환경 변수가 없어 임시 비밀번호를 만들었어요: ${TEACHER_PIN} (서버가 다시 시작되면 바뀝니다. Render의 Environment에서 TEACHER_PIN을 설정하세요)`);
    return;
  }
  const addrs = lanAddresses();
  console.log('');
  console.log('==============================================');
  console.log('  교실 마피아 게임 서버가 켜졌습니다!');
  console.log('==============================================');
  console.log(`  선생님 화면:  http://localhost:${PORT}/teacher`);
  console.log(`  🔑 선생님 비밀번호:  ${TEACHER_PIN}   (학생에게 보여 주지 마세요)`);
  console.log('');
  if (USE_TUNNEL) {
    console.log('  🌐 학생용 인터넷 주소를 만드는 중… (10~30초)');
    console.log('     주소는 선생님 화면과 이 창에 나타나요.');
  }
  if (addrs.length) {
    console.log(`  ${USE_TUNNEL ? '(참고) ' : ''}같은 와이파이일 때 주소:`);
    for (const a of addrs) console.log(`     http://${a.address}:${PORT}   (${a.name})`);
  }
  console.log('');
  console.log('  끄려면 이 창을 닫거나 Ctrl + C');
  console.log('==============================================');
  if (USE_TUNNEL) startTunnel();
  if (OPEN_BROWSER && process.platform === 'win32') {
    // 비밀번호는 # 뒤에 붙여서 서버로 전송되지 않고 이 PC 브라우저에만 전달됨
    exec(`start "" "http://localhost:${PORT}/teacher#pin=${TEACHER_PIN}"`);
  }
});
