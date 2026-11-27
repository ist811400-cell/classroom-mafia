(() => {
  const { ROLE, PHASE, el, fmtTime, toast, store, resultNodes } = window.M;
  const $ = (id) => document.getElementById(id);
  const socket = io();
  const LS = localStorage;

  let hs = null;
  const lastChatKeys = {};
  let hideRoles = store.get('mafia.hideRoles', LS) === '1';

  // ── 선생님 비밀번호 ──
  // 서버가 브라우저를 열 때 주소 # 뒤에 비밀번호를 붙여 줌 → 저장하고 주소창에서 지움
  const hashPin = (location.hash.match(/pin=(\d+)/) || [])[1];
  if (hashPin) {
    store.set('mafia.pin', hashPin, LS);
    history.replaceState(null, '', location.pathname);
  }
  const getPin = () => store.get('mafia.pin', LS) || '';

  function showLogin(msg) {
    $('hostView').classList.add('hidden');
    $('loginView').classList.remove('hidden');
    $('phaseBadge').textContent = '로그인 필요';
    $('loginError').textContent = msg || '';
    $('pinInput').focus();
  }
  $('loginForm').addEventListener('submit', (e) => {
    e.preventDefault();
    store.set('mafia.pin', $('pinInput').value.trim(), LS);
    $('pinInput').value = '';
    enter();
  });

  // ── 방 만들기 / 다시 연결 ──
  function onHost(res) {
    store.set('mafia.host', JSON.stringify({ code: res.code, token: res.token }), LS);
    $('loginView').classList.add('hidden');
    $('hostView').classList.remove('hidden');
    $('codeBig').textContent = res.code;
    renderInfo(res.info);
  }

  function renderInfo(info) {
    const box = $('joinUrls');
    const nodes = [];
    const t = info.tunnel;
    if (t.status === 'on' && info.internet) {
      nodes.push(el('div', { class: 'join-url big-url' }, info.shortInternet));
      nodes.push(el('div', { class: 'hint' }, t.fixed
        ? '🌐 인터넷 주소 · 와이파이·유선 상관없이 접속돼요. 주소는 항상 같아요.'
        : '🌐 인터넷 주소 · 와이파이·유선 상관없이 접속돼요. 서버를 다시 켜면 주소가 바뀌어요.'));
    } else if (t.status === 'starting' || t.status === 'connecting') {
      nodes.push(el('div', { class: 'warn-box' }, '🌐 학생용 인터넷 주소를 만드는 중이에요… (10~30초)'));
    } else if (t.status === 'error') {
      nodes.push(el('div', { class: 'warn-box' }, `⚠ ${t.error}`));
    }
    if (info.lan.length) {
      const lanList = info.lan.map((u) => el('div', { class: 'hint' }, `${u.url}  (${u.name})`));
      if (t.status === 'off') {
        nodes.push(el('div', { class: 'join-url' }, info.lan[0].url), ...lanList.slice(1));
      } else {
        nodes.push(el('details', {}, el('summary', { class: 'hint' }, '같은 와이파이일 때 쓰는 주소'), ...lanList));
      }
    }
    if (info.localUrl) nodes.push(el('p', { class: 'hint' }, `혼자 테스트할 때: 이 PC 브라우저 새 탭에서 ${info.localUrl}`));
    box.replaceChildren(...nodes);
    const qr = $('qr');
    if (info.qr) {
      qr.src = info.qr;
      qr.classList.remove('hidden');
    } else qr.classList.add('hidden');
  }
  socket.on('host:info', renderInfo);

  function handleFail(res, retry) {
    if (res.needPin) {
      store.del('mafia.pin', LS);
      return showLogin(res.error);
    }
    retry();
  }

  function createRoom() {
    socket.emit('host:create', { pin: getPin() }, (res) => {
      if (!res.ok) return handleFail(res, () => showLogin(res.error));
      onHost(res);
    });
  }

  function enter() {
    if (!getPin()) return showLogin();
    let saved = null;
    try { saved = JSON.parse(store.get('mafia.host', LS) || 'null'); } catch {}
    if (saved && saved.code) {
      socket.emit('host:resume', { ...saved, pin: getPin() }, (res) => {
        if (res.ok) onHost(res);
        else handleFail(res, () => {
          store.del('mafia.host', LS);
          createRoom();
        });
      });
    } else createRoom();
  }

  socket.on('connect', enter);

  // 선생님 화면이 열려 있는 동안 4분마다 서버를 깨워 둠 (Render 무료 서버는 15분 동안 접속이 없으면 잠들어서 게임이 사라짐)
  setInterval(() => {
    fetch('/healthz', { cache: 'no-store' }).catch(() => {});
  }, 4 * 60 * 1000);
  socket.on('disconnect', () => {
    $('phaseBadge').textContent = '연결 끊김…';
    toast('서버와 연결이 끊겼어요. 서버 창이 켜져 있는지 확인하세요.', 5000);
  });

  $('newRoomBtn').addEventListener('click', () => {
    if (!confirm('새 방을 만들까요? 지금 방의 학생들은 새 코드로 다시 들어와야 해요.')) return;
    store.del('mafia.host', LS);
    createRoom();
  });

  function applyHide() {
    document.body.classList.toggle('hide-roles', hideRoles);
    $('hideRolesBtn').textContent = hideRoles ? '👀 직업 보이기' : '🙈 직업 가리기 (TV 화면용)';
  }
  $('hideRolesBtn').addEventListener('click', () => {
    hideRoles = !hideRoles;
    store.set('mafia.hideRoles', hideRoles ? '1' : '0', LS);
    applyHide();
  });
  applyHide();

  // ── 진행 버튼 ──
  $('startBtn').addEventListener('click', () => {
    socket.emit('host:start', {}, (res) => {
      $('startError').textContent = res && !res.ok ? res.error : '';
    });
  });
  $('nextBtn').addEventListener('click', () => socket.emit('host:next'));
  $('plusBtn').addEventListener('click', () => socket.emit('host:time', { delta: 30 }));
  $('minusBtn').addEventListener('click', () => socket.emit('host:time', { delta: -30 }));
  $('pauseBtn').addEventListener('click', () => socket.emit('host:pause'));
  $('restartBtn').addEventListener('click', () => {
    if (hs && hs.phase !== 'lobby' && hs.phase !== 'end' && !confirm('진행 중인 게임을 끝내고 대기실로 돌아갈까요?')) return;
    socket.emit('host:restart');
  });

  $('announceForm').addEventListener('submit', (e) => {
    e.preventDefault();
    const text = $('announceInput').value.trim();
    if (!text) return;
    socket.emit('host:announce', { text });
    $('announceInput').value = '';
  });

  // ── 설정 ──
  const send = (patch) => socket.emit('host:settings', patch);
  $('setMafia').addEventListener('change', (e) => send({ mafia: Number(e.target.value) }));
  $('setDoctor').addEventListener('change', (e) => send({ doctor: e.target.checked }));
  $('setPolice').addEventListener('change', (e) => send({ police: e.target.checked }));
  $('setReveal').addEventListener('change', (e) => send({ revealRole: e.target.checked }));
  $('setChat').addEventListener('change', (e) => send({ chat: e.target.checked }));
  for (const [id, key] of [['setDay', 'day'], ['setVote', 'vote'], ['setNight', 'night'], ['setResult', 'result']]) {
    $(id).addEventListener('change', (e) => send({ [key]: Number(e.target.value) }));
  }
  $('setWords').addEventListener('change', (e) => send({ extraWords: e.target.value.split(',').map((w) => w.trim()).filter(Boolean) }));

  function setIfIdle(id, value, prop = 'value') {
    const input = $(id);
    if (document.activeElement === input) return;
    if (input[prop] !== value) input[prop] = value;
  }

  // ── 상태 받기 ──
  socket.on('hostState', (s) => {
    hs = s;
    render();
  });
  socket.on('timer', (t) => {
    if (!hs) return;
    hs.timer = t;
    renderTimer();
  });

  function renderTimer() {
    const t = hs.timer;
    const box = $('timer');
    const show = t.active && hs.phase !== 'lobby' && hs.phase !== 'end';
    box.classList.toggle('hidden', !show);
    if (show) {
      box.textContent = (t.paused ? '⏸ ' : '⏱ ') + fmtTime(t.remaining);
      box.classList.toggle('warn', !t.paused && t.remaining <= 10);
    }
    $('pauseBtn').textContent = t.paused ? '▶ 다시 시작' : '⏸ 일시정지';
  }

  function recommendMafia(n) {
    if (n <= 7) return 1;
    if (n <= 10) return 2;
    if (n <= 13) return 3;
    return 4;
  }

  function render() {
    const s = hs;
    const playing = s.phase !== 'lobby' && s.phase !== 'end';
    document.body.className = `teacher phase-${s.phase}${hideRoles ? ' hide-roles' : ''}`;
    $('phaseBadge').textContent = `${PHASE[s.phase]}${playing ? ` · ${s.day}일차` : ''}`;
    renderTimer();

    const help = {
      lobby: '학생들이 모두 들어오면 [게임 시작]을 누르세요.',
      day: '토론 중이에요. 시간이 끝나면 자동으로 투표로 넘어가고, [다음 단계로]로 바로 넘길 수도 있어요.',
      vote: '투표 중이에요. 모두 투표하면 3초 뒤 자동으로 결과가 나와요.',
      voteResult: '투표 결과를 발표하는 중이에요. 잠시 뒤 밤이 됩니다.',
      night: '밤이에요. 마피아·의사·경찰이 모두 고르면 5초 뒤 아침이 돼요.',
      morning: '아침 결과를 발표하는 중이에요. 잠시 뒤 낮 토론이 시작돼요.',
      end: `${s.winner === 'mafia' ? '🔪 마피아' : '🎉 시민'} 팀 승리! 같은 학생들로 다시 하려면 [게임 시작]을 누르세요.`,
    };
    $('phaseTitle').textContent = `${PHASE[s.phase]}${playing ? ` (${s.day}일차)` : ''}`;
    $('phaseHelp').textContent = help[s.phase];
    $('startBtn').classList.toggle('hidden', playing);
    $('startBtn').textContent = s.phase === 'end' ? '▶ 같은 인원으로 새 게임' : '▶ 게임 시작';
    for (const id of ['nextBtn', 'plusBtn', 'minusBtn', 'pauseBtn']) $(id).classList.toggle('hidden', !playing);
    $('restartBtn').classList.toggle('hidden', s.phase === 'lobby');
    if (playing) $('startError').textContent = '';

    // 결과
    const rb = $('resultBox');
    const showResult = (s.phase === 'voteResult' || s.phase === 'morning') && s.lastResult;
    rb.classList.toggle('hidden', !showResult);
    if (showResult) rb.replaceChildren(...resultNodes(s.lastResult));

    // 밤 현황
    const nb = $('nightBox');
    nb.classList.toggle('hidden', s.phase !== 'night');
    if (s.phase === 'night') {
      const cell = (label, v, extra) => el('div', {}, el('small', {}, label), v || '고르는 중…', extra ? el('small', {}, extra) : null);
      const alive = (role) => s.players.some((p) => p.alive && p.role === role);
      nb.replaceChildren(
        cell('🔪 마피아 대상', s.night.mafia, s.night.mafiaBy ? `${s.night.mafiaBy} 선택` : ''),
        cell('💉 의사 보호', s.settings.doctor ? (alive('doctor') ? s.night.doctor : '의사 없음') : '없음'),
        cell('🚓 경찰 조사', s.settings.police ? (alive('police') ? s.night.police : '경찰 없음') : '없음')
      );
    }

    renderSettings(s, playing);
    renderPlayers(s);
    renderChats(s);
    $('logList').replaceChildren(...s.log.slice().reverse().map((l) => el('li', {}, l.text)));
  }

  function renderSettings(s, playing) {
    const st = s.settings;
    setIfIdle('setMafia', String(st.mafia));
    setIfIdle('setDoctor', st.doctor, 'checked');
    setIfIdle('setPolice', st.police, 'checked');
    setIfIdle('setReveal', st.revealRole, 'checked');
    setIfIdle('setChat', st.chat, 'checked');
    setIfIdle('setDay', String(st.day));
    setIfIdle('setVote', String(st.vote));
    setIfIdle('setNight', String(st.night));
    setIfIdle('setResult', String(st.result));
    setIfIdle('setWords', st.extraWords.join(', '));
    for (const id of ['setMafia', 'setDoctor', 'setPolice']) $(id).disabled = playing;

    const n = s.players.length;
    const rec = recommendMafia(n);
    const citizens = n - st.mafia - (st.doctor ? 1 : 0) - (st.police ? 1 : 0);
    $('roleHint').textContent = playing
      ? '직업 구성은 게임 중에 바꿀 수 없어요. (시간 설정은 다음 단계부터 바로 적용돼요)'
      : `현재 ${n}명 → 마피아 ${st.mafia}, ${st.doctor ? '의사 1, ' : ''}${st.police ? '경찰 1, ' : ''}시민 ${Math.max(0, citizens)}. ${n >= s.limits.minPlayers ? `${n}명이면 마피아 ${rec}명을 추천해요.` : `최소 ${s.limits.minPlayers}명이 필요해요.`}`;
    const warn = $('roleWarn');
    let w = '';
    if (!playing && n >= s.limits.minPlayers) {
      if (st.mafia >= n - st.mafia) w = '마피아가 너무 많아서 바로 마피아가 이겨요. 수를 줄여 주세요.';
      else if (st.mafia > rec + 1) w = '마피아가 많아서 시민 팀이 꽤 불리해요.';
      else if (citizens < 0) w = '직업 수가 인원보다 많아요.';
    }
    warn.textContent = w;
    warn.classList.toggle('hidden', !w);
  }

  function renderPlayers(s) {
    const alive = s.players.filter((p) => p.alive).length;
    const started = s.phase !== 'lobby';
    $('playerCount').textContent = started ? `(생존 ${alive}/${s.players.length})` : `(${s.players.length}/${s.limits.maxPlayers}명)`;
    $('actionHead').textContent = s.phase === 'vote' ? '투표' : '조사 기록';
    $('playerRows').replaceChildren(
      ...(s.players.length ? s.players.map((p) => {
        const role = p.role ? ROLE[p.role] : null;
        let action = '';
        if (s.phase === 'vote') action = p.alive ? p.vote || '…' : '';
        else if (p.role === 'police' && p.policeResults.length) action = p.policeResults.map((r) => `${r.name}${r.isMafia ? '🔪' : '✅'}`).join(' ');
        return el('tr', { class: p.alive ? '' : 'dead' },
          el('td', { class: 'nm' }, p.name),
          el('td', {}, `${p.connected ? '🟢' : '📴'} ${started ? (p.alive ? '생존' : '👻 탈락') : '대기'}`),
          el('td', { class: `secret ${role ? 'role-' + p.role : ''}` }, role ? `${role.emoji} ${role.name}` : '-'),
          el('td', { class: s.phase === 'vote' ? '' : 'secret' }, action),
          el('td', {}, p.prediction.length ? p.prediction.join(', ') : ''),
          el('td', {}, el('button', {
            class: 'btn small ghost', type: 'button',
            onclick: () => { if (confirm(`${p.name} 학생을 내보낼까요? 이 기기에서는 같은 방에 다시 들어올 수 없어요.`)) socket.emit('host:kick', { id: p.id }); },
          }, '내보내기')));
      }) : [el('tr', {}, el('td', { colspan: '6', class: 'muted' }, '아직 들어온 학생이 없어요.'))])
    );

    const pb = $('predictBox');
    const show = s.phase === 'end' && s.predictions.length;
    pb.classList.toggle('hidden', !show);
    if (show) {
      pb.replaceChildren(
        el('div', { class: 'sub' }, '🔮 관전 예측 결과'),
        el('ul', { class: 'reveal-list' }, s.predictions.map((r) =>
          el('li', {}, el('span', {}, r.name), el('span', {}, `${r.picks.map((x) => (x.correct ? '✅' : '❌') + x.name).join(' ')} · ${r.correct}명 적중`))))
      );
    }
  }

  function renderChats(s) {
    for (const [ch, id] of [['public', 'chatPublic'], ['mafia', 'chatMafia'], ['dead', 'chatDead']]) {
      const msgs = s.chats[ch];
      const key = `${msgs.length}:${msgs.length ? msgs[msgs.length - 1].id : ''}`;
      if (lastChatKeys[ch] === key) continue;
      lastChatKeys[ch] = key;
      const log = $(id);
      log.replaceChildren(...msgs.map((m) => {
        if (m.system) return el('div', { class: 'msg system' }, m.text);
        if (m.host) return el('div', { class: 'msg host' }, el('b', {}, '📢 사회자'), m.text);
        return el('div', { class: 'msg' }, el('b', {}, m.name), el('span', {}, m.text));
      }));
      log.scrollTop = log.scrollHeight;
    }
  }
})();
