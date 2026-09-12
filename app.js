// Swim Log — Supabase 연동 · 텍스트 붙여넣기 → 파싱 검수 → 저장
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const P = window.SwimParser;

const sb = supabase.createClient(window.SUPABASE_URL, window.SUPABASE_KEY);

const SET_TYPES = [['warmup', '웜업'], ['main', '메인'], ['sprint', '스프린트'], ['underwater', '잠영'], ['dolphin', '돌핀킥'], ['down', '다운'], ['other', '기타']];
const STROKES = [['unknown', '미지정'], ['free', '자유형'], ['fly', '접영'], ['back', '배영'], ['breast', '평영'], ['im', 'IM'], ['mixed', '혼합']];

let session = null;      // supabase auth session
let draftDays = null;    // 파싱해서 화면에 올려둔, 아직 저장 안 한 날짜들 (1개든 여러 개든 배열)
// toISOString()은 UTC 기준이라 한국(UTC+9)에서는 자정 근처에 날짜가 하루 밀립니다.
// 반드시 로컬 날짜 값(getFullYear/Month/Date)으로 직접 조합합니다.
const pad2 = (n) => String(n).padStart(2, '0');
const isoLocal = (d) => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
const today = () => isoLocal(new Date());
function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toast._t);
  toast._t = setTimeout(() => (t.hidden = true), 3200);
}

// ── 인증 ──
async function refreshAuthUI() {
  const { data } = await sb.auth.getSession();
  session = data.session;
  $('#authed').hidden = !session;
  $('#anon').hidden = !!session;
  if (session) {
    $('#whoami').textContent = session.user.email;
    loadRecent();
    loadBests();
  }
}
sb.auth.onAuthStateChange((_evt, s) => { session = s; refreshAuthUI(); });

let pendingEmail = '';
async function sendCode() {
  const email = $('#email').value.trim();
  if (!email) return toast('이메일을 입력해 주세요');
  const btn = $('#send-code');
  btn.disabled = true;
  btn.textContent = '보내는 중…';
  const { error } = await sb.auth.signInWithOtp({ email, options: { shouldCreateUser: true } });
  btn.disabled = false;
  btn.textContent = '코드 받기';
  if (error) return toast('전송 실패: ' + error.message);
  pendingEmail = email;
  $('#code-sent-to').textContent = email;
  $('#step-email').hidden = true;
  $('#step-code').hidden = false;
  $('#code').value = '';
  $('#code').focus();
}
$('#send-code').addEventListener('click', sendCode);
$('#email').addEventListener('keydown', (e) => { if (e.key === 'Enter') sendCode(); });

$('#verify-code').addEventListener('click', async () => {
  const code = $('#code').value.trim();
  if (!/^\d{6}$/.test(code)) return toast('6자리 숫자를 입력해 주세요');
  const btn = $('#verify-code');
  btn.disabled = true;
  btn.textContent = '확인 중…';
  const { error } = await sb.auth.verifyOtp({ email: pendingEmail, token: code, type: 'email' });
  btn.disabled = false;
  btn.textContent = '로그인';
  if (error) return toast('코드가 맞지 않거나 만료됐습니다: ' + error.message);
  $('#step-email').hidden = false;
  $('#step-code').hidden = true;
});
$('#code').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('#verify-code').click(); });
$('#resend-code').addEventListener('click', sendCode);
$('#change-email').addEventListener('click', () => { $('#step-email').hidden = false; $('#step-code').hidden = true; });

$('#logout').addEventListener('click', async () => { await sb.auth.signOut(); draftDays = null; renderDraft(); });

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
    <td><input data-f="timeRaw" value="${esc(l.timeRaw)}" placeholder="1'06.89" style="width:78px"></td>
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

// ── 저장 (하루치를 실제로 Supabase에 넣는 부분 — 날짜 1개짜리든 여러 개 묶음이든 이걸 반복 호출) ──
async function saveOneDay(day) {
  const [yy, mm, dd] = day.date.split('-').map(Number);
  const weekday = ['일', '월', '화', '수', '목', '금', '토'][new Date(yy, mm - 1, dd).getDay()];
  const { data: sessRow, error: e1 } = await sb.from('sessions').insert({
    user_id: session.user.id,
    session_date: day.date,
    weekday,
    location: day.location || null,
    pool_length: day.poolLength,
    condition_note: day.condition || null,
  }).select().single();
  if (e1) throw e1;

  for (let i = 0; i < day.blocks.length; i++) {
    const b = day.blocks[i];
    const intervalSec = b.intervalRaw ? P.toSeconds(b.intervalRaw) : null;
    const { data: setRow, error: e2 } = await sb.from('sets').insert({
      session_id: sessRow.id,
      order_index: i,
      set_type: b.setType,
      stroke: b.stroke,
      distance: b.distance,
      rep_count: b.repCount,
      interval_mode: intervalSec ? 'fixed_interval' : 'none',
      interval_or_pace_sec: intervalSec,
      raw_header: b.rawHeader || null,
    }).select().single();
    if (e2) throw e2;

    const lapRows = b.laps.map((l) => ({
      set_id: setRow.id,
      rep_no: l.repNo,
      time_sec: l.timeRaw ? P.toSeconds(l.timeRaw) : null,
      rest_sec: l.restRaw ? P.toSeconds(l.restRaw) : null,
      stroke_override: l.strokeOverride || null,
      stroke_count: l.strokeCount || null,
      is_missing: !!l.isMissing,
      needs_review: !!l.needsReview,
      note: l.note || null,
      raw_text: l.rawText || null,
    }));
    if (lapRows.length) {
      const { error: e3 } = await sb.from('laps').insert(lapRows);
      if (e3) throw e3;
    }
  }
}

async function saveAllDrafts() {
  if (!draftDays || !draftDays.length || !session) return;
  const btn = $('#save-draft');
  btn.disabled = true;
  const total = draftDays.length;
  let saved = 0;
  try {
    for (const day of draftDays) {
      btn.textContent = total > 1 ? `저장 중… (${saved + 1}/${total})` : '저장 중…';
      await saveOneDay(day);
      saved++;
    }
    toast(total > 1 ? `${total}일 전체 저장했습니다` : '저장했습니다');
    draftDays = null;
    $('#raw-text').value = '';
    renderDraft();
    loadRecent();
    loadBests();
  } catch (err) {
    toast(`${saved}/${total}일 저장 후 실패: ${err.message}`);
  } finally {
    btn.disabled = false;
    btn.textContent = total > 1 ? `${total}일 전체 저장` : '저장';
  }
}

// ── 최근 기록 ──
async function loadRecent() {
  const box = $('#recent');
  box.innerHTML = '<div class="muted small">불러오는 중…</div>';
  const { data, error } = await sb.from('sessions').select('id, session_date, weekday, location, pool_length').order('session_date', { ascending: false }).limit(15);
  if (error) { box.innerHTML = `<div class="warn">불러오기 실패: ${esc(error.message)}</div>`; return; }
  if (!data.length) { box.innerHTML = '<div class="muted small">아직 저장된 기록이 없습니다.</div>'; return; }
  box.innerHTML = data.map((s) => `<button class="recent-row" data-id="${s.id}">
      <b>${s.session_date}${s.weekday ? `(${s.weekday})` : ''}</b>
      <span class="muted">${esc(s.location || '')} · ${s.pool_length}m</span>
      <span class="detail" hidden></span>
    </button>`).join('');
  $$('.recent-row', box).forEach((btn) => {
    btn.addEventListener('click', () => toggleDetail(btn));
  });
}
async function toggleDetail(btn) {
  const detail = btn.querySelector('.detail');
  if (!detail.hidden) { detail.hidden = true; return; }
  if (!detail.dataset.loaded) {
    const { data, error } = await sb.from('sets').select('*, laps(*)').eq('session_id', btn.dataset.id).order('order_index');
    if (error) { detail.textContent = '불러오기 실패: ' + error.message; }
    else {
      detail.innerHTML = data.map((s) => `<div class="set-line"><b>${s.raw_header || `${s.distance}m x${s.rep_count}`}</b> · ${P.STROKE_LABEL[s.stroke] || s.stroke}
        <div class="small muted">${s.laps.sort((a, b) => a.rep_no - b.rep_no).map((l) => (l.time_sec != null ? P.fmtSec(l.time_sec) : (l.is_missing ? '누락' : '?'))).join(' · ')}</div></div>`).join('') || '<div class="small muted">세트 없음</div>';
    }
    detail.dataset.loaded = '1';
  }
  detail.hidden = false;
}

// ── 베스트 기록 · 기록 추이 ──
const cssVar = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
let bestCombos = []; // [{stroke, distance, best_time_sec, best_date}]

async function loadBests() {
  const box = $('#bests');
  const { data, error } = await sb.from('personal_bests').select('*').order('stroke').order('distance');
  if (error) { box.innerHTML = `<div class="warn">불러오기 실패: ${esc(error.message)}</div>`; return; }
  bestCombos = data || [];
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

async function loadTrend() {
  const val = $('#trend-pick').value;
  const chart = $('#trend-chart');
  if (!val) { chart.innerHTML = ''; return; }
  const [stroke, distance] = [val.split('|')[0], +val.split('|')[1]];
  chart.innerHTML = '<p class="small muted">불러오는 중…</p>';
  const { data, error } = await sb.from('laps')
    .select('time_sec, sets!inner(stroke, distance, sessions!inner(session_date))')
    .eq('sets.stroke', stroke).eq('sets.distance', distance)
    .eq('is_missing', false).not('time_sec', 'is', null);
  if (error) { chart.innerHTML = `<div class="warn">${esc(error.message)}</div>`; return; }
  const points = data
    .map((r) => ({ date: r.sets.sessions.session_date, y: r.time_sec }))
    .sort((a, b) => a.date.localeCompare(b.date));
  drawTrendChart(chart, points);
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

refreshAuthUI();
