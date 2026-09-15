// Swim Log — 텍스트 붙여넣기 → 파싱 검수 → 저장 (이 폰/컴퓨터의 브라우저에 저장, 로그인 없음)
// 나중에 여러 기기 동기화가 필요해지면, saveOneDay/saveSessionEdit/deleteSession 자리에
// 서버 저장(예: Supabase)을 다시 붙이면 됩니다 — 화면 쪽 코드는 그대로 써도 됩니다.
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const P = window.SwimParser;

const SET_TYPES = [['warmup', '웜업'], ['main', '메인'], ['sprint', '스프린트'], ['underwater', '잠영'], ['dolphin', '돌핀킥'], ['down', '다운'], ['other', '기타']];
const STROKES = [['unknown', '미지정'], ['free', '자유형'], ['fly', '접영'], ['back', '배영'], ['breast', '평영'], ['im', 'IM'], ['mixed', '혼합']];

let draftDays = null; // 파싱해서 화면에 올려둔, 아직 저장 안 한 날짜들 (1개든 여러 개든 배열)
// toISOString()은 UTC 기준이라 한국(UTC+9)에서는 자정 근처에 날짜가 하루 밀립니다.
// 반드시 로컬 날짜 값(getFullYear/Month/Date)으로 직접 조합합니다.
const pad2 = (n) => String(n).padStart(2, '0');
const isoLocal = (d) => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
const today = () => isoLocal(new Date());
const uid = () => Math.random().toString(36).slice(2, 9) + Date.now().toString(36).slice(-4);
function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toast._t);
  toast._t = setTimeout(() => (t.hidden = true), 3200);
}

// ── 로컬 저장소 ──
// 세션 하나의 모양이 그대로 "검수 화면"에서 쓰는 모양과 같습니다: date/location/poolLength/condition + blocks(세트) 배열.
const STORE_KEY = 'swimlog.v1';
let S;
function loadStore() {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    S = raw ? JSON.parse(raw) : { v: 1, sessions: [] };
    if (!Array.isArray(S.sessions)) S.sessions = [];
  } catch (e) {
    S = { v: 1, sessions: [] };
  }
}
function saveStore() {
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify(S));
  } catch (e) {
    toast('저장 공간이 부족합니다. 백업 후 오래된 기록을 지워주세요.');
  }
}
loadStore();

// ── 붙여넣기 → 파싱 ──
// 날짜가 하나든 여러 개 섞여 있든 같은 방식으로 처리합니다. 앞에 날짜 줄이 없으면 오늘 날짜 하루로 취급합니다.
$('#parse-btn').addEventListener('click', () => {
  const raw = $('#raw-text').value;
  if (!raw.trim()) return toast('붙여넣은 내용이 없습니다');
  let days = P.splitSwimLog(raw);
  if (!days.length) {
    const { meta, note, blocks } = P.splitSwimText(raw);
    if (!blocks.length) return toast('세트를 찾지 못했습니다. "50m x 8" 같은 형식의 줄이 있는지 확인해 주세요');
    let sessionDate = today();
    if (meta) {
      const now = new Date();
      const d = new Date(now.getFullYear(), meta.month - 1, meta.day);
      if (d.getTime() - now.getTime() > 86400000) d.setFullYear(d.getFullYear() - 1);
      sessionDate = isoLocal(d);
    }
    days = [{ date: sessionDate, location: (meta && meta.location) || '', poolLength: (meta && meta.poolLength) || 25, note, blocks }];
  }
  draftDays = days.map(dayToDraft);
  renderDraft();
  $('#draft-card').scrollIntoView({ behavior: 'smooth', block: 'start' });
});
function dayToDraft(day, di) {
  return {
    date: day.date, location: day.location || '', poolLength: day.poolLength || 25, condition: day.note || '',
    blocks: day.blocks.map((b, i) => blockToDraft(b, `${di}-${i}`)),
  };
}

function guessStroke(laps) {
  const s = new Set(laps.map((l) => l.strokeOverride).filter(Boolean));
  if (s.size === 0) return 'unknown';
  if (s.size === 1) return [...s][0];
  return 'mixed';
}
function blockToDraft(b, i) {
  const h = b.header || {};
  return {
    key: 'b' + i, // 날짜 인덱스까지 포함된 값이라 여러 날짜를 한 화면에 그려도 서로 안 겹칩니다
    setType: 'main',
    stroke: guessStroke(b.laps),
    distance: h.distance ?? null,
    repCount: h.repCount ?? b.laps.length,
    intervalRaw: h.intervalRaw || '',
    rawHeader: h.rawHeader || '',
    laps: b.laps.map((l) => ({
      repNo: l.repNo,
      timeRaw: l.timeSec != null ? P.fmtSec(l.timeSec) : '',
      restRaw: l.restSec != null ? P.fmtSec(l.restSec) : '',
      strokeOverride: l.strokeOverride || '',
      strokeCount: l.strokeCount,
      isMissing: l.isMissing,
      needsReview: l.needsReview,
      note: l.note || '',
      rawText: l.rawText,
    })),
  };
}

// ── 검수 화면 렌더링 (날짜가 여러 개면 하나씩 이어서 보여줌) ──
function renderDraft() {
  const box = $('#draft-card');
  if (!draftDays || !draftDays.length) { box.hidden = true; return; }
  box.hidden = false;
  const totalFlagged = draftDays.reduce((n, d) => n + d.blocks.reduce((m, b) => m + b.laps.filter((l) => l.needsReview).length, 0), 0);
  box.innerHTML = `
    <h2>기록 확인 ${draftDays.length > 1 ? `<span class="small muted">· ${draftDays.length}일치</span>` : ''}</h2>
    ${totalFlagged ? `<p class="warn">⚠️ 확인이 필요한 랩 ${totalFlagged}개가 노란색으로 표시돼 있습니다. 값을 고치거나, 문제없으면 그대로 저장해도 됩니다.</p>` : ''}
    <div id="day-list"></div>
    <div class="row end">
      <button class="ghost" id="cancel-draft">전체 취소</button>
      <button class="primary" id="save-draft">${draftDays.length > 1 ? `${draftDays.length}일 전체 저장` : '저장'}</button>
    </div>`;
  $('#cancel-draft').onclick = () => { draftDays = null; renderDraft(); };
  $('#save-draft').onclick = saveAllDrafts;

  const list = $('#day-list');
  list.innerHTML = draftDays.map((d, di) => dayCardHtml(d, di)).join('');
  draftDays.forEach((d, di) => wireDayCard(d, di));
}

function dayCardHtml(d, di) {
  const flagged = d.blocks.reduce((n, b) => n + b.laps.filter((l) => l.needsReview).length, 0);
  return `<div class="day-card" data-di="${di}">
    <div class="row" style="justify-content:space-between;align-items:flex-start">
      <div class="row" style="margin:0">
        <label>날짜<input data-df="date" type="date" value="${d.date}"></label>
        <label>장소<input data-df="location" value="${esc(d.location)}" placeholder="충무"></label>
        <label>풀 길이<select data-df="poolLength"><option value="25"${d.poolLength == 25 ? ' selected' : ''}>25m</option><option value="50"${d.poolLength == 50 ? ' selected' : ''}>50m</option></select></label>
      </div>
      ${draftDays.length > 1 ? `<button class="ghost sm" data-act="remove-day">이 날짜 제외</button>` : ''}
    </div>
    ${flagged ? `<div class="small" style="color:var(--warn-ink)">확인 필요 ${flagged}개</div>` : ''}
    <label class="block">컨디션/메모<textarea data-df="condition" rows="2" placeholder="컨디션, 특이사항">${esc(d.condition)}</textarea></label>
    <div class="blocks">${d.blocks.map(blockHtml).join('')}</div>
  </div>`;
}
function wireDayCard(d, di) {
  const el = $(`.day-card[data-di="${di}"]`);
  if (!el) return;
  el.querySelectorAll(':scope > .row [data-df], :scope > label [data-df]').forEach((input) => {
    const f = input.dataset.df;
    const ev = input.tagName === 'SELECT' ? 'change' : 'input';
    input.addEventListener(ev, () => (d[f] = f === 'poolLength' ? +input.value : input.value));
  });
  const removeBtn = el.querySelector('[data-act="remove-day"]');
  if (removeBtn) removeBtn.onclick = () => { draftDays.splice(di, 1); renderDraft(); };
  d.blocks.forEach((b) => wireBlock(b));
}

function blockHtml(b) {
  return `<div class="set-block" data-key="${b.key}">
    <div class="row">
      <label>종류<select data-f="setType">${SET_TYPES.map(([v, l]) => `<option value="${v}"${b.setType === v ? ' selected' : ''}>${l}</option>`).join('')}</select></label>
      <label>영법<select data-f="stroke">${STROKES.map(([v, l]) => `<option value="${v}"${b.stroke === v ? ' selected' : ''}>${l}</option>`).join('')}</select></label>
      <label>거리<input data-f="distance" type="number" value="${b.distance ?? ''}" style="width:70px"></label>
      <label>계획 횟수<input data-f="repCount" type="number" value="${b.repCount ?? ''}" style="width:70px"></label>
      <label>인터벌<input data-f="intervalRaw" value="${esc(b.intervalRaw)}" placeholder="1'40&quot;" style="width:80px"></label>
    </div>
    <div class="small muted">원본: ${esc(b.rawHeader) || '(헤더 없음)'}</div>
    <table class="laps">
      <thead><tr><th>#</th><th>기록</th><th>휴식</th><th>영법</th><th>메모</th><th>누락</th><th></th></tr></thead>
      <tbody>${b.laps.map((l, i) => lapRow(l, i)).join('')}</tbody>
    </table>
    <button class="ghost sm" data-act="add-lap">+ 랩 추가</button>
  </div>`;
}
function lapRow(l, i) {
  return `<tr class="${l.needsReview ? 'flag' : ''}" data-i="${i}">
    <td>${l.repNo}</td>
    <td><input data-f="timeRaw" value="${esc(l.timeRaw)}" placeholder="예: 1'06.89" style="width:78px"></td>
    <td><input data-f="restRaw" value="${esc(l.restRaw)}" placeholder="45초" style="width:64px"></td>
    <td><select data-f="strokeOverride"><option value="">(세트 영법)</option>${STROKES.slice(1).map(([v, lb]) => `<option value="${v}"${l.strokeOverride === v ? ' selected' : ''}>${lb}</option>`).join('')}</select></td>
    <td><input data-f="note" value="${esc(l.note)}" placeholder="메모" style="width:110px"></td>
    <td><input data-f="isMissing" type="checkbox" ${l.isMissing ? 'checked' : ''}></td>
    <td><button class="ghost sm" data-act="del-lap">삭제</button></td>
  </tr>`;
}
function wireBlock(b) {
  const el = $(`.set-block[data-key="${b.key}"]`);
  if (!el) return;
  el.querySelectorAll('[data-f]').forEach((input) => {
    if (input.closest('tr')) return; // 랩 입력은 아래에서 별도 처리
    const f = input.dataset.f;
    input.addEventListener('input', () => (b[f] = input.type === 'number' ? (input.value === '' ? null : +input.value) : input.value));
    input.addEventListener('change', () => (b[f] = input.type === 'number' ? (input.value === '' ? null : +input.value) : input.value));
  });
  el.querySelectorAll('tbody tr').forEach((tr) => {
    const i = +tr.dataset.i, lap = b.laps[i];
    tr.querySelectorAll('[data-f]').forEach((input) => {
      const f = input.dataset.f;
      const ev = input.type === 'checkbox' ? 'change' : 'input';
      input.addEventListener(ev, () => {
        lap[f] = input.type === 'checkbox' ? input.checked : input.value;
        if (f === 'timeRaw') { lap.needsReview = input.value.trim() !== '' && P.toSeconds(input.value.trim()) == null; tr.classList.toggle('flag', lap.needsReview); }
      });
    });
    tr.querySelector('[data-act="del-lap"]').onclick = () => { b.laps.splice(i, 1); b.laps.forEach((l, j) => (l.repNo = j + 1)); renderBlockLaps(b); };
  });
  el.querySelector('[data-act="add-lap"]').onclick = () => {
    b.laps.push({ repNo: b.laps.length + 1, timeRaw: '', restRaw: '', strokeOverride: '', strokeCount: null, isMissing: false, needsReview: false, note: '', rawText: '' });
    renderBlockLaps(b);
  };
}
function renderBlockLaps(b) {
  const el = $(`.set-block[data-key="${b.key}"] tbody`);
  el.innerHTML = b.laps.map((l, i) => lapRow(l, i)).join('');
  wireBlock(b);
}

// ── 저장 (이 브라우저의 저장소에 넣기) ──
function saveOneDay(day) {
  S.sessions.push({ id: uid(), ...day });
}
function saveAllDrafts() {
  if (!draftDays || !draftDays.length) return;
  const total = draftDays.length;
  for (const day of draftDays) saveOneDay(day);
  saveStore();
  toast(total > 1 ? `${total}일 전체 저장했습니다` : '저장했습니다');
  draftDays = null;
  $('#raw-text').value = '';
  renderDraft();
  loadRecent();
  loadBests();
}

// ── 최근 기록 (펼치면 보기 좋은 표로, 편집·삭제까지 가능) ──
function loadRecent() {
  const box = $('#recent');
  const list = S.sessions.slice().sort((a, b) => b.date.localeCompare(a.date));
  if (!list.length) { box.innerHTML = '<div class="muted small">아직 저장된 기록이 없습니다.</div>'; return; }
  // 버튼 안에 편집용 입력칸까지 넣으면 브라우저가 클릭을 제대로 못 받아 접기/펴기가 꼬입니다.
  // 그래서 "누르는 줄"과 "펼쳐지는 내용"을 서로 다른 요소로 분리합니다.
  box.innerHTML = list.map((s) => {
    const [yy, mm, dd] = s.date.split('-').map(Number);
    const weekday = ['일', '월', '화', '수', '목', '금', '토'][new Date(yy, mm - 1, dd).getDay()];
    return `<div class="recent-row">
      <button class="recent-head" data-id="${s.id}">
        <b>${s.date}(${weekday})</b>
        <span class="muted">${esc(s.location || '')} · ${s.poolLength}m</span>
        <span class="chev">▾</span>
      </button>
      <div class="detail" hidden></div>
    </div>`;
  }).join('');
  $$('.recent-row', box).forEach((row) => {
    row.querySelector('.recent-head').addEventListener('click', () => toggleDetail(row));
  });
}
function toggleDetail(row) {
  const head = row.querySelector('.recent-head');
  const detail = row.querySelector('.detail');
  const wasOpen = !detail.hidden;
  detail.hidden = wasOpen;
  head.classList.toggle('open', !wasOpen);
  if (wasOpen) return;
  const d = S.sessions.find((s) => s.id === head.dataset.id);
  if (!d) { detail.innerHTML = '<div class="warn">기록을 찾지 못했습니다 (삭제됐을 수 있습니다)</div>'; return; }
  showSessionView(detail, d);
}

// ── 보기 모드: 인터벌/스플릿/휴식을 표로, 세트별로 접었다 펼 수 있게 ──
function showSessionView(container, d) {
  container.innerHTML = sessionViewHtml(d);
  wireSessionView(container, d);
}
function sessionViewHtml(d) {
  return `
    <div class="row" style="justify-content:space-between;align-items:flex-start;margin-top:12px">
      <div class="small muted">${esc(d.location || '장소 미입력')} · ${d.poolLength}m 풀${d.condition ? `<br>${esc(d.condition)}` : ''}</div>
      <button class="ghost sm" data-act="edit-session">편집</button>
    </div>
    <div class="set-groups">${d.blocks.map(setGroupHtml).join('') || '<p class="small muted">세트가 없습니다.</p>'}</div>`;
}
function setGroupTitle(b) {
  return (b.distance && b.repCount) ? `${b.distance}m x${b.repCount}` : (b.rawHeader || '세트');
}
function setGroupHtml(b) {
  const done = b.laps.filter((l) => l.timeRaw);
  const secs = done.map((l) => P.toSeconds(l.timeRaw)).filter((v) => v != null);
  const avg = secs.length ? secs.reduce((a, v) => a + v, 0) / secs.length : null;
  return `<div class="set-group">
    <button class="set-group-head">
      <span class="grow"><b>${esc(setGroupTitle(b))}</b>${b.intervalRaw ? ` <span class="small muted">@${esc(b.intervalRaw)}</span>` : ''}</span>
      <span class="small muted">${done.length}/${b.laps.length}${avg != null ? ` · 평균 ${P.fmtSec(Math.round(avg * 100) / 100)}` : ''}</span>
      <span class="chev">▾</span>
    </button>
    <div class="set-group-body">
      <div class="split-hd"><span>#</span><span>기록</span><span>휴식</span><span>영법 · 메모</span></div>
      ${b.laps.map(splitRowHtml).join('')}
    </div>
  </div>`;
}
function splitRowHtml(l) {
  const stroke = l.strokeOverride ? (P.STROKE_LABEL[l.strokeOverride] || l.strokeOverride) : '';
  return `<div class="split-row ${l.needsReview ? 'flag' : ''}">
    <span class="muted">${l.repNo}</span>
    <span class="num">${l.timeRaw ? esc(l.timeRaw) : (l.isMissing ? '<span class="muted">누락</span>' : '<span class="muted">—</span>')}</span>
    <span class="num muted">${l.restRaw ? esc(l.restRaw) : ''}</span>
    <span class="small muted">${[stroke, l.note].filter(Boolean).map(esc).join(' · ')}</span>
  </div>`;
}
function wireSessionView(container, d) {
  container.querySelectorAll('.set-group-head').forEach((btn) => {
    btn.addEventListener('click', () => {
      const body = btn.nextElementSibling;
      const open = body.hidden;
      body.hidden = !open;
      btn.classList.toggle('open', open);
    });
  });
  container.querySelector('[data-act="edit-session"]').onclick = () => {
    const original = JSON.parse(JSON.stringify(d)); // 취소하면 편집 중 바뀐 값을 되돌리기 위한 원본 복사본
    container.innerHTML = sessionEditHtml(d);
    wireSessionEdit(container, d, () => { Object.assign(d, original); showSessionView(container, d); });
  };
}
function sessionEditHtml(d) {
  return `
    <div class="row">
      <label>날짜<input data-ef="date" type="date" value="${d.date}"></label>
      <label>장소<input data-ef="location" value="${esc(d.location)}"></label>
      <label>풀 길이<select data-ef="poolLength"><option value="25"${d.poolLength == 25 ? ' selected' : ''}>25m</option><option value="50"${d.poolLength == 50 ? ' selected' : ''}>50m</option></select></label>
    </div>
    <label class="block">컨디션/메모<textarea data-ef="condition" rows="2">${esc(d.condition)}</textarea></label>
    <div class="blocks">${d.blocks.map(blockHtml).join('') || '<p class="small muted">세트가 없습니다.</p>'}</div>
    <div class="row end">
      <button class="ghost sm" data-act="cancel-edit">취소</button>
      <button class="ghost sm" data-act="delete-session">이 기록 삭제</button>
      <button class="primary sm" data-act="save-session">수정 내용 저장</button>
    </div>`;
}
function wireSessionEdit(container, d, onCancel) {
  container.querySelectorAll('[data-ef]').forEach((input) => {
    const f = input.dataset.ef;
    const ev = input.tagName === 'SELECT' ? 'change' : 'input';
    input.addEventListener(ev, () => (d[f] = f === 'poolLength' ? +input.value : input.value));
  });
  d.blocks.forEach((b) => wireBlock(b));
  container.querySelector('[data-act="save-session"]').onclick = () => saveSessionEdit(d);
  container.querySelector('[data-act="delete-session"]').onclick = () => deleteSession(d);
  if (onCancel) container.querySelector('[data-act="cancel-edit"]').onclick = onCancel;
}
function saveSessionEdit(d) {
  const idx = S.sessions.findIndex((s) => s.id === d.id);
  if (idx === -1) return toast('저장 실패: 기록을 찾지 못했습니다');
  S.sessions[idx] = JSON.parse(JSON.stringify(d));
  saveStore();
  toast('수정했습니다');
  loadRecent();
  loadBests();
}
function deleteSession(d) {
  if (!confirm('이 기록을 완전히 삭제할까요? 되돌릴 수 없습니다.')) return;
  S.sessions = S.sessions.filter((s) => s.id !== d.id);
  saveStore();
  toast('삭제했습니다');
  loadRecent();
  loadBests();
}

// ── 베스트 기록 · 기록 추이 (전부 이 브라우저에 저장된 기록에서 바로 계산) ──
const cssVar = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
let bestCombos = []; // [{stroke, distance, best_time_sec, best_date}]

function personalBests() {
  const map = {};
  for (const s of S.sessions) {
    for (const b of s.blocks) {
      if (!b.distance) continue;
      for (const l of b.laps) {
        if (l.isMissing || !l.timeRaw) continue;
        const t = P.toSeconds(l.timeRaw);
        if (t == null) continue;
        const key = b.stroke + '|' + b.distance;
        if (!map[key] || t < map[key].best_time_sec) map[key] = { stroke: b.stroke, distance: b.distance, best_time_sec: t, best_date: s.date };
      }
    }
  }
  return Object.values(map).sort((a, b) => a.stroke.localeCompare(b.stroke) || a.distance - b.distance);
}
function trendPoints(stroke, distance) {
  const pts = [];
  for (const s of S.sessions) {
    for (const b of s.blocks) {
      if (b.stroke !== stroke || b.distance !== distance) continue;
      for (const l of b.laps) {
        if (l.isMissing || !l.timeRaw) continue;
        const t = P.toSeconds(l.timeRaw);
        if (t != null) pts.push({ date: s.date, y: t });
      }
    }
  }
  return pts.sort((a, b) => a.date.localeCompare(b.date));
}

function loadBests() {
  const box = $('#bests');
  bestCombos = personalBests();
  if (!bestCombos.length) {
    box.innerHTML = '<p class="small muted">기록을 저장하면 종목별 베스트가 여기 모입니다.</p>';
    $('#trend-pick').innerHTML = '';
    $('#trend-chart').innerHTML = '<div class="empty">기록이 쌓이면 그래프가 생깁니다</div>';
    return;
  }
  box.innerHTML = `<div class="best-grid">${bestCombos.map((b) => `<div class="best-tile">
      <div class="l">${P.STROKE_LABEL[b.stroke] || b.stroke} ${b.distance}m</div>
      <div class="v">${P.fmtSec(b.best_time_sec)}</div>
      <div class="d">${b.best_date}</div>
    </div>`).join('')}</div>`;

  const pick = $('#trend-pick');
  const prev = pick.value;
  pick.innerHTML = bestCombos.map((b) => `<option value="${b.stroke}|${b.distance}">${P.STROKE_LABEL[b.stroke] || b.stroke} ${b.distance}m</option>`).join('');
  pick.value = bestCombos.some((b) => `${b.stroke}|${b.distance}` === prev) ? prev : pick.options[0].value;
  loadTrend();
}
$('#trend-pick').addEventListener('change', loadTrend);
function loadTrend() {
  const val = $('#trend-pick').value;
  const chart = $('#trend-chart');
  if (!val) { chart.innerHTML = ''; return; }
  const [stroke, distance] = [val.split('|')[0], +val.split('|')[1]];
  drawTrendChart(chart, trendPoints(stroke, distance));
}

// 얇은 선 + 마지막 값 라벨의 심플한 추이 차트 (기록은 낮을수록 좋으므로 y축 최댓값이 위)
function drawTrendChart(box, points) {
  if (!points.length) { box.innerHTML = '<div class="empty">아직 기록이 없습니다</div>'; return; }
  const W = 640, H = 180, L = 44, R = 16, T = 14, B = 22;
  const ys = points.map((p) => p.y);
  let y0 = Math.min(...ys), y1 = Math.max(...ys);
  if (y0 === y1) { y0 -= 1; y1 += 1; }
  const pad = (y1 - y0) * 0.1;
  y0 -= pad; y1 += pad;
  const X = (i) => (points.length === 1 ? (W - L - R) / 2 + L : L + (i / (points.length - 1)) * (W - L - R));
  const Y = (v) => T + (1 - (v - y0) / (y1 - y0)) * (H - T - B);
  const pts = points.map((p, i) => ({ ...p, px: X(i), py: Y(p.y) }));
  const line = pts.map((p, i) => `${i ? 'L' : 'M'}${p.px.toFixed(1)},${p.py.toFixed(1)}`).join('');
  const gridC = cssVar('--line'), mutedC = cssVar('--mute'), lineC = cssVar('--acc'), surfC = cssVar('--s1'), inkC = cssVar('--ink');
  const last = pts[pts.length - 1];
  const ticks = [y0 + pad, (y0 + y1) / 2, y1 - pad];
  box.innerHTML = `<svg viewBox="0 0 ${W} ${H}">
    ${ticks.map((v) => `<line x1="${L}" x2="${W - R}" y1="${Y(v)}" y2="${Y(v)}" stroke="${gridC}" stroke-width="1"/>
      <text x="${L - 6}" y="${Y(v) + 4}" text-anchor="end" font-size="11" fill="${mutedC}">${P.fmtSec(v)}</text>`).join('')}
    <path d="${line}" fill="none" stroke="${lineC}" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>
    ${pts.map((p) => `<circle cx="${p.px}" cy="${p.py}" r="3.5" fill="${lineC}" stroke="${surfC}" stroke-width="1.5"><title>${p.date} · ${P.fmtSec(p.y)}</title></circle>`).join('')}
    <text x="${last.px}" y="${last.py - 9}" text-anchor="middle" font-size="13" font-weight="600" fill="${inkC}">${P.fmtSec(last.y)}</text>
    <text x="${L}" y="${H - 5}" font-size="11" fill="${mutedC}">${points[0].date}</text>
    ${points.length > 1 ? `<text x="${W - R}" y="${H - 5}" text-anchor="end" font-size="11" fill="${mutedC}">${points[points.length - 1].date}</text>` : ''}
  </svg>`;
}

// ── 백업 (기기를 바꾸거나 브라우저 데이터를 지우기 전에) ──
function saveBackup() {
  const blob = new Blob([JSON.stringify({ app: 'swim-log', exportedAt: new Date().toISOString(), ...S }, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = `swim-log-backup-${today()}.json`;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
  toast('백업 파일을 다운로드했습니다');
}
$('#backup-save').addEventListener('click', saveBackup);
$('#backup-save2').addEventListener('click', saveBackup);
$('#backup-file').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  e.target.value = '';
  if (!file) return;
  let data;
  try { data = JSON.parse(await file.text()); } catch (err) { return toast('백업 파일을 읽을 수 없습니다'); }
  if (!data || !Array.isArray(data.sessions)) return toast('Swim Log 백업 파일이 아닙니다');
  if (!confirm(`지금 있는 기록이 백업 파일의 기록 ${data.sessions.length}개로 바뀝니다. 계속할까요?`)) return;
  S = { v: 1, sessions: data.sessions };
  saveStore();
  loadRecent();
  loadBests();
  toast('백업을 불러왔습니다');
});

loadRecent();
loadBests();
