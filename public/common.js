// 학생 화면과 선생님 화면이 같이 쓰는 도구들
window.M = (() => {
  const ROLE = {
    mafia: { name: '마피아', emoji: '🔪', team: 'mafia', desc: '밤마다 동료 마피아와 함께 한 명을 제거하세요. 정체를 들키지 마세요!' },
    doctor: { name: '의사', emoji: '💉', team: 'citizen', desc: '밤마다 한 명을 골라 마피아의 공격에서 지켜 주세요. 자기 자신도 지킬 수 있어요.' },
    police: { name: '경찰', emoji: '🚓', team: 'citizen', desc: '밤마다 한 명을 조사해서 마피아인지 아닌지 알아낼 수 있어요.' },
    citizen: { name: '시민', emoji: '🙂', team: 'citizen', desc: '특별한 능력은 없지만, 토론과 투표로 마피아를 찾아내세요!' },
  };
  const PHASE = { lobby: '대기실', day: '낮 토론', vote: '투표', voteResult: '투표 결과', night: '밤', morning: '아침', end: '게임 종료' };

  // 요소 만들기 (텍스트는 항상 textContent로 넣어서 안전하게)
  function el(tag, attrs = {}, ...children) {
    const e = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
      if (v === null || v === undefined || v === false) continue;
      if (k === 'class') e.className = v;
      else if (k === 'text') e.textContent = v;
      else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
      else e.setAttribute(k, v === true ? '' : v);
    }
    for (const c of children.flat()) {
      if (c === null || c === undefined || c === false) continue;
      e.append(c instanceof Node ? c : document.createTextNode(String(c)));
    }
    return e;
  }

  function fmtTime(sec) {
    sec = Math.max(0, sec | 0);
    return `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, '0')}`;
  }

  let toastTimer = null;
  function toast(msg, ms = 2600) {
    const t = document.getElementById('toast');
    if (!t) return;
    t.textContent = msg;
    t.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => t.classList.remove('show'), ms);
  }

  const store = {
    get(k, s = sessionStorage) { try { return s.getItem(k); } catch { return null; } },
    set(k, v, s = sessionStorage) { try { s.setItem(k, v); } catch {} },
    del(k, s = sessionStorage) { try { s.removeItem(k); } catch {} },
  };

  // 결과 카드 내용
  function resultNodes(r, roleOf) {
    if (!r) return [];
    const roleText = (p) => (p && p.role ? ` (${ROLE[p.role].emoji} ${ROLE[p.role].name})` : '');
    if (r.kind === 'vote') {
      const head = r.executed
        ? el('div', { class: 'result-head' }, `⚖️ ${r.executed.name}님이 처형되었습니다.${roleText(r.executed)}`)
        : el('div', { class: 'result-head' }, `⚖️ ${{ tie: '동점이라', skip: '기권이 많아서', none: '표가 없어서' }[r.reason] || ''} 아무도 처형되지 않았습니다.`);
      const rows = r.tally.map((t) => el('li', {}, el('span', {}, t.name), el('b', {}, `${t.count}표`)));
      if (r.skip) rows.push(el('li', {}, el('span', {}, '기권'), el('b', {}, `${r.skip}표`)));
      if (r.notVoted) rows.push(el('li', { class: 'muted' }, el('span', {}, '투표 안 함'), el('b', {}, `${r.notVoted}명`)));
      return [head, rows.length ? el('ul', { class: 'tally' }, rows) : null];
    }
    if (r.kind === 'morning') {
      if (r.killed) return [el('div', { class: 'result-head' }, `🌅 지난밤 ${r.killed.name}님이 마피아에게 당했습니다.${roleText(r.killed)}`)];
      if (r.saved) return [el('div', { class: 'result-head' }, '🌅 누군가 공격받았지만 의사가 살려냈습니다! 💉')];
      return [el('div', { class: 'result-head' }, '🌅 지난밤에는 아무 일도 없었습니다.')];
    }
    return [];
  }

  return { ROLE, PHASE, el, fmtTime, toast, store, resultNodes };
})();
