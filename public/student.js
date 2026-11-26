(() => {
  const { ROLE, el, fmtTime, toast, store, resultNodes } = window.M;
  const $ = (id) => document.getElementById(id);
  const socket = io();

  let state = null;
  let roleShown = false;
  let chatTab = 'public';
  let lastChatKey = '';
  let lastPhaseKey = '';
  let lastPoliceCount = 0;
  const seenCount = { public: 0, mafia: 0, dead: 0 };

  // ── 입장 ──
  const params = new URLSearchParams(location.search);
  if (params.get('code')) $('codeInput').value = params.get('code').replace(/\D/g, '').slice(0, 4);
  const savedName = store.get('mafia.name');
  if (savedName) $('nameInput').value = savedName;

  function showJoin(msg) {
    $('joinView').classList.remove('hidden');
    $('gameView').classList.add('hidden');
    $('roomBadge').classList.add('hidden');
    $('timer').classList.add('hidden');
    document.body.className = 'phase-lobby';
    $('joinError').textContent = msg || '';
    state = null;
  }
  function showGame() {
    $('joinView').classList.add('hidden');
    $('gameView').classList.remove('hidden');
  }
  function forget() {
    store.del('mafia.token');
    store.del('mafia.code');
  }

  function resume() {
    const token = store.get('mafia.token');
    const code = store.get('mafia.code');
    if (!token || !code) return;
    socket.emit('join', { code, token }, (res) => {
      if (res && res.ok) showGame();
      else {
        forget();
        showJoin(res && res.error ? res.error : '');
      }
    });
  }

  socket.on('connect', resume);
  socket.on('disconnect', () => toast('연결이 끊겼어요. 다시 연결하는 중…', 4000));

  $('joinForm').addEventListener('submit', (e) => {
    e.preventDefault();
    const code = $('codeInput').value.trim();
    const name = $('nameInput').value.trim();
    if (!/^\d{4}$/.test(code)) return ($('joinError').textContent = '방 코드는 숫자 4자리예요.');
    if (!name) return ($('joinError').textContent = '닉네임을 입력하세요.');
    socket.emit('join', { code, name }, (res) => {
      if (!res || !res.ok) return ($('joinError').textContent = (res && res.error) || '입장하지 못했어요.');
      store.set('mafia.token', res.token);
      store.set('mafia.code', res.code);
      store.set('mafia.name', res.name);
      $('joinError').textContent = '';
      showGame();
    });
  });

  $('leaveBtn').addEventListener('click', () => {
    if (!confirm('정말 방에서 나갈까요?')) return;
    socket.emit('leave');
    forget();
    showJoin();
  });

  socket.on('kicked', () => {
    forget();
    showJoin('선생님이 방에서 내보냈어요.');
  });
  socket.on('replaced', () => {
    showJoin('다른 탭에서 같은 참가자로 접속해서 이 화면은 연결이 끊겼어요.');
  });

  // ── 상태 받기 ──
  socket.on('state', (s) => {
    state = s;
    showGame();
    render();
  });
  socket.on('timer', (t) => {
    if (!state) return;
    state.timer = t;
    renderTimer();
  });

  function renderTimer() {
    const t = state.timer;
    const box = $('timer');
    if (!t.active || state.phase === 'lobby' || state.phase === 'end') return box.classList.add('hidden');
    box.classList.remove('hidden');
    box.textContent = (t.paused ? '⏸ ' : '⏱ ') + fmtTime(t.remaining);
    box.classList.toggle('warn', !t.paused && t.remaining <= 10);
  }

  const started = () => state.phase !== 'lobby';
  const nameOf = (id) => state.players.find((p) => p.id === id)?.name || '?';

  function render() {
    const s = state;
    document.body.className = `phase-${s.phase}${started() && !s.me.alive ? ' is-dead' : ''}`;
    const badge = $('roomBadge');
    badge.classList.remove('hidden');
    badge.textContent = `방 ${s.code}${s.day && started() ? ` · ${s.day}일차` : ''}`;
    renderTimer();

    // 단계가 바뀌면 진동 + 채팅 탭 자동 전환
    const phaseKey = `${s.phase}-${s.day}`;
    if (phaseKey !== lastPhaseKey) {
      if (lastPhaseKey && navigator.vibrate) navigator.vibrate(150);
      roleShown = false; // 단계가 바뀌면 직업 카드를 자동으로 가려서 옆 사람이 못 보게
      if (s.phase === 'night' && s.me.role === 'mafia' && s.me.alive) chatTab = 'mafia';
      else if (started() && !s.me.alive && s.phase !== 'end') chatTab = 'dead';
      else if (chatTab === 'mafia') chatTab = 'public';
      lastPhaseKey = phaseKey;
    }

    renderPhase(s);
    renderRole(s);
    $('deadBanner').classList.toggle('hidden', !(started() && !s.me.alive && s.phase !== 'end'));
    renderResult(s);
    renderAction(s);
    renderPredict(s);
    renderEnd(s);
    renderPlayers(s);
    renderChat(s);
  }

  function renderPhase(s) {
    const n = s.players.length;
    const map = {
      lobby: ['⏳ 대기실', `선생님이 게임을 시작할 때까지 기다려 주세요. 지금 ${n}명 (${s.settings.minPlayers}~${s.settings.maxPlayers}명 필요)`],
      day: [`☀️ ${s.day}일차 낮`, '토론 시간이에요. 누가 마피아인지 이야기해 보세요!'],
      vote: ['🗳️ 투표 시간', '처형할 사람을 골라 주세요. 시간이 끝나기 전까지는 바꿀 수 있어요.'],
      voteResult: ['⚖️ 투표 결과', '곧 밤이 됩니다.'],
      night: [`🌙 ${s.day}일차 밤`, '모두 화면을 가리고 조용히 자기 할 일을 하세요.'],
      morning: [`🌅 ${s.day}일차 아침`, '지난밤 무슨 일이 있었을까요?'],
      end: ['🏁 게임 종료', '모든 직업이 공개되었어요.'],
    };
    const [title, desc] = map[s.phase] || ['', ''];
    $('phaseTitle').textContent = title;
    let d = desc;
    if (s.phase === 'lobby') {
      d += ` · 직업: 마피아 ${s.settings.mafia}${s.settings.doctor ? ', 의사 1' : ''}${s.settings.police ? ', 경찰 1' : ''}, 나머지 시민`;
    }
    $('phaseDesc').textContent = d;
  }

  function renderRole(s) {
    const card = $('roleCard');
    if (!started() || !s.me.role) return card.classList.add('hidden');
    card.classList.remove('hidden');
    const r = ROLE[s.me.role];
    const body = $('roleBody');
    body.classList.toggle('hidden', !roleShown);
    $('roleToggle').textContent = roleShown ? '🙈 눌러서 직업 가리기' : '👀 눌러서 내 직업 몰래 보기';
    body.replaceChildren(
      el('div', { class: `role-big role-${s.me.role}` }, `${r.emoji} ${r.name}`),
      el('p', {}, r.desc)
    );
    if (s.me.role === 'mafia') {
      const mates = s.players.filter((p) => p.role === 'mafia' && p.id !== s.me.id).map((p) => p.name + (p.alive ? '' : ' 👻'));
      body.append(el('p', { class: 'mates' }, mates.length ? `동료 마피아: ${mates.join(', ')}` : '이번 게임에서는 혼자 마피아예요.'));
    }
    if (s.me.role === 'police') {
      if (s.policeResults.length) {
        body.append(
          el('div', { class: 'sub' }, '조사 기록'),
          el('ul', { class: 'police-list' }, s.policeResults.map((r) =>
            el('li', { class: r.isMafia ? 'bad' : 'good' }, `${r.day}일차 밤 · ${r.name} → ${r.isMafia ? '🔪 마피아예요!' : '✅ 마피아가 아니에요'}`)))
        );
      }
      if (s.policeResults.length > lastPoliceCount && s.phase === 'morning') toast('🚓 조사 결과가 도착했어요. 내 직업 카드를 눌러 확인하세요.', 4000);
      lastPoliceCount = s.policeResults.length;
    } else lastPoliceCount = 0;
  }
  $('roleToggle').addEventListener('click', () => {
    roleShown = !roleShown;
    if (state) renderRole(state);
  });

  function renderResult(s) {
    const card = $('resultCard');
    const show = (s.phase === 'voteResult' || s.phase === 'morning' || s.phase === 'end') && s.lastResult;
    card.classList.toggle('hidden', !show);
    if (show) card.replaceChildren(...resultNodes(s.lastResult));
  }

  function targetButton(p, selected, onClick, extra = '') {
    return el(
      'button',
      { class: `target${selected ? ' selected' : ''}${p.alive ? '' : ' dead'}`, type: 'button', onclick: onClick },
      el('span', { class: 'tname' }, p.name),
      extra ? el('span', { class: 'tsub' }, extra) : null
    );
  }

  function renderAction(s) {
    const card = $('actionCard');
    const list = $('actionList');
    let title = '';
    let desc = '';
    let status = '';
    let buttons = [];
    const alive = s.players.filter((p) => p.alive);

    if (s.phase === 'vote' && s.me.alive) {
      title = '🗳️ 누구를 처형할까요?';
      desc = '한 명을 고르거나 기권하세요. 동점이면 아무도 처형되지 않아요.';
      buttons = alive.filter((p) => p.id !== s.me.id).map((p) =>
        targetButton(p, s.myAction === p.id, () => socket.emit('vote', { target: p.id })));
      buttons.push(el('button', { class: `target skip${s.myAction === 'skip' ? ' selected' : ''}`, type: 'button', onclick: () => socket.emit('vote', { target: 'skip' }) }, '🤐 기권'));
      const vp = s.voteProgress;
      status = `${s.myAction ? `내 선택: ${s.myAction === 'skip' ? '기권' : nameOf(s.myAction)}` : '아직 투표하지 않았어요'} · 투표 ${vp.done}/${vp.total}명 완료`;
    } else if (s.phase === 'night' && s.me.alive) {
      title = '🌙 밤 행동: 한 명을 고르세요';
      const role = s.me.role;
      let targets = alive.filter((p) => p.id !== s.me.id);
      if (role === 'mafia') {
        desc = '🔪 제거할 사람을 고르세요. 마피아끼리 하나의 대상을 공유하고, 마지막에 누른 사람이 대상이 돼요.';
        targets = alive.filter((p) => p.role !== 'mafia');
        status = s.myAction ? `현재 대상: ${nameOf(s.myAction)} (${s.mafiaBy} 선택)` : '아직 대상을 정하지 않았어요.';
      } else if (role === 'doctor') {
        desc = '💉 오늘 밤 지켜 줄 사람을 고르세요. 자기 자신도 고를 수 있어요.';
        targets = alive;
        status = s.myAction ? `지킬 사람: ${nameOf(s.myAction)}` : '아직 고르지 않았어요.';
      } else if (role === 'police') {
        desc = '🚓 조사할 사람을 고르세요. 결과는 아침에 내 직업 카드에 나와요.';
        status = s.myAction ? `조사할 사람: ${nameOf(s.myAction)}` : '아직 고르지 않았어요.';
      } else {
        desc = '🤔 의심 가는 사람을 골라 보세요. (결과에는 영향이 없지만, 모두 똑같이 화면을 눌러야 정체가 숨겨져요!)';
        status = s.myAction ? `고른 사람: ${nameOf(s.myAction)}` : '';
      }
      buttons = targets.map((p) => targetButton(p, s.myAction === p.id, () => socket.emit('nightAction', { target: p.id })));
    }

    card.classList.toggle('hidden', !title);
    $('actionTitle').textContent = title;
    $('actionDesc').textContent = desc;
    $('actionStatus').textContent = status;
    list.replaceChildren(...buttons);
  }

  function renderPredict(s) {
    const card = $('predictCard');
    const show = started() && !s.me.alive && s.phase !== 'end';
    card.classList.toggle('hidden', !show);
    if (!show) return;
    const max = s.settings.mafia;
    const picks = s.prediction || [];
    $('predictDesc').textContent = `마피아라고 생각하는 사람을 최대 ${max}명 골라 보세요. 게임이 끝나면 몇 명 맞혔는지 알려 드려요. (${picks.length}/${max} 선택)`;
    const others = s.players.filter((p) => p.id !== s.me.id);
    $('predictList').replaceChildren(
      ...others.map((p) =>
        targetButton(p, picks.includes(p.id), () => {
          let next = picks.includes(p.id) ? picks.filter((id) => id !== p.id) : [...picks, p.id];
          if (next.length > max) {
            toast(`최대 ${max}명까지 고를 수 있어요.`);
            return;
          }
          socket.emit('predict', { ids: next });
        }, p.alive ? '' : '탈락'))
    );
  }

  function renderEnd(s) {
    const card = $('endCard');
    if (s.phase !== 'end') return card.classList.add('hidden');
    card.classList.remove('hidden');
    const myTeam = s.me.role ? ROLE[s.me.role].team : null;
    const won = myTeam === s.winner;
    const nodes = [
      el('div', { class: `winner ${s.winner}` }, s.winner === 'mafia' ? '🔪 마피아 팀 승리!' : '🎉 시민 팀 승리!'),
      myTeam ? el('p', { class: 'center' }, won ? '축하해요! 우리 팀이 이겼어요 🙌' : '아쉽지만 다음 판에 다시 도전해요!') : null,
      el('div', { class: 'sub' }, '모든 직업 공개'),
      el('ul', { class: 'reveal-list' }, s.players.map((p) =>
        el('li', {}, el('span', {}, `${p.name}${p.id === s.me.id ? ' (나)' : ''}`), el('span', {}, `${p.role ? ROLE[p.role].emoji + ' ' + ROLE[p.role].name : '-'}${p.alive ? '' : ' 👻'}`)))),
    ];
    if (s.predictions && s.predictions.length) {
      nodes.push(
        el('div', { class: 'sub' }, '🔮 관전 예측 결과'),
        el('ul', { class: 'reveal-list' }, s.predictions.map((r) =>
          el('li', {}, el('span', {}, r.name), el('span', {}, `${r.picks.map((x) => (x.correct ? '✅' : '❌') + x.name).join(' ')} · ${r.correct}명 적중`))))
      );
    }
    nodes.push(el('p', { class: 'hint center' }, '선생님이 새 게임을 시작하면 자동으로 이어져요.'));
    card.replaceChildren(...nodes);
  }

  function renderPlayers(s) {
    const alive = s.players.filter((p) => p.alive).length;
    $('playerCount').textContent = started() ? `(생존 ${alive}/${s.players.length})` : `(${s.players.length}명)`;
    $('playerList').replaceChildren(
      ...s.players.map((p) => {
        const tags = [];
        if (p.id === s.me.id) tags.push(el('span', { class: 'tag me' }, '나'));
        if (p.role && p.id !== s.me.id) tags.push(el('span', { class: `tag role-${p.role}` }, `${ROLE[p.role].emoji} ${ROLE[p.role].name}`));
        if (!p.alive) tags.push(el('span', { class: 'tag dead' }, '👻 탈락'));
        if (!p.connected) tags.push(el('span', { class: 'tag off' }, '📴'));
        return el('li', { class: p.alive ? '' : 'dead' }, el('span', { class: 'pname' }, p.name), el('span', { class: 'tags' }, tags));
      })
    );
  }

  // ── 채팅 ──
  const TAB_NAMES = { public: '💬 전체', mafia: '🔪 마피아', dead: '👻 유령' };
  function renderChat(s) {
    const tabs = Object.keys(s.chats);
    if (!tabs.includes(chatTab)) chatTab = 'public';
    seenCount[chatTab] = s.chats[chatTab].length;

    $('chatTabs').replaceChildren(
      ...tabs.map((t) => {
        const unread = s.chats[t].length > (seenCount[t] || 0);
        return el('button', {
          class: `tab${t === chatTab ? ' active' : ''}${unread ? ' unread' : ''}`,
          type: 'button',
          role: 'tab',
          onclick: () => { chatTab = t; lastChatKey = ''; renderChat(state); },
        }, TAB_NAMES[t]);
      })
    );

    const msgs = s.chats[chatTab];
    const key = `${chatTab}:${msgs.length}:${msgs.length ? msgs[msgs.length - 1].id : ''}`;
    if (key !== lastChatKey) {
      const log = $('chatLog');
      const nearBottom = log.scrollHeight - log.scrollTop - log.clientHeight < 60 || !lastChatKey.startsWith(chatTab);
      log.replaceChildren(
        ...(msgs.length ? msgs.map((m) => {
          if (m.system) return el('div', { class: 'msg system' }, m.text);
          if (m.host) return el('div', { class: 'msg host' }, el('b', {}, '📢 사회자 '), m.text);
          return el('div', { class: `msg${m.from === s.me.id ? ' mine' : ''}` }, el('b', {}, m.name), el('span', {}, m.text));
        }) : [el('div', { class: 'msg system' }, '아직 메시지가 없어요.')])
      );
      if (nearBottom) log.scrollTop = log.scrollHeight;
      lastChatKey = key;
    }

    const can = s.canChat[chatTab];
    $('chatInput').disabled = !can;
    $('chatForm').querySelector('button').disabled = !can;
    let hint = '';
    if (!can) {
      if (chatTab === 'public' && s.phase === 'night') hint = '밤에는 전체 채팅을 할 수 없어요.';
      else if (chatTab === 'public' && !s.me.alive) hint = '탈락하면 전체 채팅은 볼 수만 있어요. 👻 유령 탭에서 이야기하세요.';
      else if (chatTab === 'mafia') hint = '마피아 채팅은 밤에만 쓸 수 있어요.';
      else hint = '지금은 채팅을 할 수 없어요.';
    }
    $('chatHint').textContent = hint;
    $('chatInput').placeholder = can ? `${TAB_NAMES[chatTab]} 채팅에 메시지 입력` : '채팅 불가';
  }

  $('chatForm').addEventListener('submit', (e) => {
    e.preventDefault();
    const input = $('chatInput');
    const text = input.value.trim();
    if (!text || !state) return;
    socket.emit('chat', { channel: chatTab, text });
    input.value = '';
  });
})();
