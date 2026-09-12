// Swim Log — Supabase 연동 · 텍스트 붙여넣기 → 파싱 검수 → 저장
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const P = window.SwimParser;

const sb = supabase.createClient(window.SUPABASE_URL, window.SUPABASE_KEY);

const SET_TYPES = [['warmup', '웜업'], ['main', '메인'], ['sprint', '스프린트'], ['underwater', '잠영'], ['dolphin', '돌핀킥'], ['down', '다운'], ['other', '기타']];
const STROKES = [['unknown', '미지정'], ['free', '자유형'], ['fly', '접영'], ['back', '배영'], ['breast', '평영'], ['im', 'IM'], ['mixed', '혼합']];

let session = null;   // supabase auth session
let draft = null;     // 파싱해서 화면에 올려둔, 아직 저장 안 한 세션
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
  }
}
sb.auth.onAuthStateChange((_evt, s) => { session = s; refreshAuthUI(); });

$('#send-link').addEventListener('click', async () => {
  const email = $('#email').value.trim();
  if (!email) return toast('이메일을 입력해 주세요');
  const btn = $('#send-link');
  btn.disabled = true;
  const { error } = await sb.auth.signInWithOtp({ email, options: { emailRedirectTo: location.href.split('#')[0] } });
  btn.disabled = false;
  if (error) return toast('전송 실패: ' + error.message);
  $('#link-status').hidden = false;
  $('#link-status').textContent = `${email} 로 로그인 링크를 보냈습니다. 메일함(스팸함도)을 확인해 주세요.`;
});
$('#logout').addEventListener('click', async () => { await sb.auth.signOut(); draft = null; renderDraft(); });

// ── 붙여넣기 → 파싱 ──
$('#parse-btn').addEventListener('click', () => {
  const raw = $('#raw-text').value;
  if (!raw.trim()) return toast('붙여넣은 내용이 없습니다');
  const { meta, blocks } = P.splitSwimText(raw);
  if (!blocks.length) return toast('세트를 찾지 못했습니다. "50m x 8" 같은 형식의 줄이 있는지 확인해 주세요');

  const now = new Date();
  let sessionDate = today();
  if (meta) {
    const y = now.getFullYear();
    const d = new Date(y, meta.month - 1, meta.day);
    if (d.getTime() - now.getTime() > 86400000) d.setFullYear(y - 1); // 미래 날짜면 작년으로 보정 (예: 1월에 12월 로그 입력)
    sessionDate = isoLocal(d);
  }

  draft = {
    date: sessionDate,
    location: (meta && meta.location) || '',
    poolLength: 25,
    condition: '',
    blocks: blocks.map((b, i) => blockToDraft(b, i)),
  };
  renderDraft();
  $('#draft-card').scrollIntoView({ behavior: 'smooth', block: 'start' });
});

function guessStroke(laps) {
  const s = new Set(laps.map((l) => l.strokeOverride).filter(Boolean));
  if (s.size === 0) return 'unknown';
  if (s.size === 1) return [...s][0];
  return 'mixed';
}
function blockToDraft(b, i) {
  const h = b.header || {};
  return {
    key: 'b' + i,
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

// ── 검수 화면 렌더링 ──
function renderDraft() {
  const box = $('#draft-card');
  if (!draft) { box.hidden = true; return; }
  box.hidden = false;
  const flagged = draft.blocks.reduce((n, b) => n + b.laps.filter((l) => l.needsReview).length, 0);
  box.innerHTML = `
    <h2>기록 확인</h2>
    ${flagged ? `<p class="warn">⚠️ 확인이 필요한 랩 ${flagged}개가 노란색으로 표시돼 있습니다. 값을 고치거나, 문제없으면 그대로 저장해도 됩니다.</p>` : ''}
    <div class="row">
      <label>날짜<input id="d-date" type="date" value="${draft.date}"></label>
      <label>장소<input id="d-loc" value="${esc(draft.location)}" placeholder="충무"></label>
      <label>풀 길이<select id="d-pool"><option value="25"${draft.poolLength == 25 ? ' selected' : ''}>25m</option><option value="50"${draft.poolLength == 50 ? ' selected' : ''}>50m</option></select></label>
    </div>
    <label class="block">컨디션/메모<textarea id="d-note" rows="2" placeholder="컨디션, 특이사항">${esc(draft.condition)}</textarea></label>
    <div id="blocks"></div>
    <div class="row end">
      <button class="ghost" id="cancel-draft">취소</button>
      <button class="primary" id="save-draft">저장</button>
    </div>`;
  $('#d-date').onchange = (e) => (draft.date = e.target.value);
  $('#d-loc').oninput = (e) => (draft.location = e.target.value);
  $('#d-pool').onchange = (e) => (draft.poolLength = +e.target.value);
  $('#d-note').oninput = (e) => (draft.condition = e.target.value);
  $('#cancel-draft').onclick = () => { draft = null; renderDraft(); };
  $('#save-draft').onclick = saveDraft;

  const blocksEl = $('#blocks');
  blocksEl.innerHTML = draft.blocks.map(blockHtml).join('');
  draft.blocks.forEach((b) => wireBlock(b));
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

// ── 저장 ──
async function saveDraft() {
  if (!draft || !session) return;
  const btn = $('#save-draft');
  btn.disabled = true;
  btn.textContent = '저장 중…';
  try {
    const [yy, mm, dd] = draft.date.split('-').map(Number);
    const weekday = ['일', '월', '화', '수', '목', '금', '토'][new Date(yy, mm - 1, dd).getDay()];
    const { data: sessRow, error: e1 } = await sb.from('sessions').insert({
      user_id: session.user.id,
      session_date: draft.date,
      weekday,
      location: draft.location || null,
      pool_length: draft.poolLength,
      condition_note: draft.condition || null,
    }).select().single();
    if (e1) throw e1;

    for (let i = 0; i < draft.blocks.length; i++) {
      const b = draft.blocks[i];
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

    toast('저장했습니다');
    draft = null;
    $('#raw-text').value = '';
    renderDraft();
    loadRecent();
  } catch (err) {
    toast('저장 실패: ' + err.message);
  } finally {
    btn.disabled = false;
    btn.textContent = '저장';
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

refreshAuthUI();
