'use strict';
// 채팅·닉네임 비속어 필터
// 단어를 더 막고 싶으면 아래 목록에 추가하세요. (선생님 화면의 "추가 금지어"로도 방마다 추가할 수 있어요)
// 띄어쓰기·숫자·특수문자를 끼워 넣어도(예: 시1발, 시 발) 걸러집니다.

const BASE_WORDS = [
  // 한국어
  '시발', '씨발', '씨바', '시바', '씨빨', '시빨', '쓰발', '쉬발', '슈발', '씹', '십새', '십세',
  'ㅅㅂ', 'ㅆㅂ', 'ㅅㅃ', 'ㅆㅃ', 'ㅄ', 'ㅂㅅ', 'ㅈㄴ', 'ㅈㄹ', 'ㅁㅊ', 'ㄲㅈ', 'ㅗ',
  '병신', '븅신', '빙신', '병쉰', '좆', '존나', '졸라', '존니', '개새', '새끼', '쌔끼', '새기', '섀끼',
  '미친놈', '미친년', '미친새', '미친', '지랄', '닥쳐', '꺼져', '엿먹', '느금', '니애미', '니엄마',
  '니미', '애미', '애비', '에미', '염병', '썅', '쌍년', '쌍놈', '년아', '놈아', '걸레', '등신', '찐따',
  '한남', '한녀', '틀딱', '급식충', '맘충', '뒤져', '뒤질', '디져', '자살',
  // 영어
  'fuck', 'fck', 'shit', 'bitch', 'asshole', 'bastard', 'dick', 'pussy', 'nigger', 'nigga', 'cunt', 'retard'
];

function normalizeWord(w) {
  return [...String(w).toLowerCase()].filter((c) => /\p{L}/u.test(c)).join('');
}

const BASE = BASE_WORDS.map(normalizeWord).filter(Boolean);

/**
 * 금지어 부분을 *로 바꾼 문자열을 돌려줍니다.
 * @param {string} text
 * @param {string[]} extraWords 방마다 선생님이 추가한 금지어
 */
function cleanText(text, extraWords = []) {
  const chars = [...String(text)];
  const normChars = [];
  const map = []; // normChars 위치 -> chars 위치
  chars.forEach((c, i) => {
    if (/\p{L}/u.test(c)) {
      normChars.push(c.toLowerCase());
      map.push(i);
    }
  });
  const norm = normChars.join('');
  const words = BASE.concat(extraWords.map(normalizeWord).filter(Boolean));
  const mask = new Array(chars.length).fill(false);

  for (const w of words) {
    const wl = [...w].length;
    let from = 0;
    while (true) {
      const idx = indexOfChars(normChars, norm, w, from);
      if (idx === -1) break;
      for (let k = idx; k < idx + wl; k++) mask[map[k]] = true;
      from = idx + 1;
    }
  }
  return chars.map((c, i) => (mask[i] ? '*' : c)).join('');
}

// 코드포인트 단위 indexOf
function indexOfChars(normChars, norm, word, from) {
  const w = [...word];
  outer: for (let i = from; i <= normChars.length - w.length; i++) {
    for (let j = 0; j < w.length; j++) {
      if (normChars[i + j] !== w[j]) continue outer;
    }
    return i;
  }
  return -1;
}

function hasBadWord(text, extraWords = []) {
  return cleanText(text, extraWords) !== String(text);
}

module.exports = { cleanText, hasBadWord };
