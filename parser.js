/**
 * 수영 훈련 텍스트 로그 파서 (v0.1 원본 유지 + v0.2 확장)
 * 카톡/메모에 옮겨 적은 자유형식 텍스트를 sets/laps 구조로 변환합니다.
 * 완벽한 파싱은 불가능하므로, 애매한 라인은 needsReview: true 로 표시해서
 * 사용자가 확인 화면에서 검수 후 저장하는 흐름을 전제로 합니다.
 *
 * v0.2에서 추가한 것 (실제 기록 노트를 보고 반영):
 *  - "33.39 / 31.58 / ..." 처럼 슬래시로 여러 기록을 한 줄에 적은 경우 랩별로 분리
 *  - "→" 화살표를 "휴식" 표기의 대체 기호로 인식 (단, 화살표가 2개 이상인 줄은
 *    구조가 너무 복잡해서 자동 분리를 포기하고 통째로 검수 대상으로 남김)
 *  - "라벨: 12.31 / 12.51" 처럼 라벨+콜론+슬래시 목록이 이어지는 줄 (Set1:, 자유형: 등)
 *  - 헤더에 종목명이 끼어 있거나("50m 자유형 x8"), 인터벌이 @ 로 표기된 경우("@1'40\"")
 *  - "Set 1 — ..." 같은, 반복 횟수 표기가 없는 세트 제목 줄
 *  - 여러 날짜가 한 문서에 섞인 경우 날짜별로 통째로 분리 (YYYY-MM-DD, M/D(요일) 둘 다)
 *  - "메모:", "웜업:" 줄은 랩으로 파싱하지 않고 세션 메모로 따로 보존
 */

const STROKE_MAP = {
  '자': 'free', '자유형': 'free',
  '접': 'fly', '접영': 'fly',
  '배': 'back', '배영': 'back',
  '평': 'breast', '평영': 'breast',
  'im': 'im', 'IM': 'im',
};
const STROKE_LABEL = { free: '자유형', fly: '접영', back: '배영', breast: '평영', im: 'IM', mixed: '혼합', unknown: '미지정' };

// .md 파일로 붙여넣을 때를 위해 마크다운 문법을 미리 벗겨낸다.
// "## 2026-09-12", "**50m x8**" 처럼 앞뒤에 #, ** 가 붙어 있으면 날짜/세트 헤더 인식이
// 전부 실패하기 때문에, 실제 파싱 전에 반드시 이 전처리를 거친다.
function normalizeLine(line) {
  if (/^[-*_]{3,}\s*$/.test(line.trim())) return ''; // --- 구분선은 빈 줄로 취급
  return line.replace(/^#{1,6}\s*/, '').replace(/\*\*/g, '').replace(/^>\s*/, '');
}
function normalizeText(raw) {
  return raw.split('\n').map(normalizeLine).join('\n');
}

function findStroke(text) {
  for (const [kr, en] of Object.entries(STROKE_MAP)) {
    if (new RegExp(`(^|\\s)${kr}(\\s|$)`).test(text)) return en;
  }
  return null;
}

// "1'06.89" / "1분 6초" / "45초" / "30.18" / "1'40\"" 등을 초 단위로 변환
function toSeconds(str) {
  if (!str) return null;
  str = str.trim();

  let m = str.match(/^(\d+)'(\d+(?:\.\d+)?)"?$/);
  if (m) return parseInt(m[1]) * 60 + parseFloat(m[2]);

  m = str.match(/^(\d+)\s*분\s*(\d+(?:\.\d+)?)\s*초?$/);
  if (m) return parseInt(m[1]) * 60 + parseFloat(m[2]);

  m = str.match(/^(\d+)\s*분$/);
  if (m) return parseInt(m[1]) * 60;

  m = str.match(/^(\d+(?:\.\d+)?)\s*초$/);
  if (m) return parseFloat(m[1]);

  m = str.match(/^\d+(?:\.\d+)?$/);
  if (m) return parseFloat(str);

  return null;
}

// 세트 헤더 라인 감지: "50m x 8 (1'40")", "75m x 4", "50m 자유형 x8 @1'40"", "[메인] 자유형 50m x4"
function parseSetHeader(line) {
  const distM = line.match(/(\d{2,3})m/);
  const repM = line.match(/[xX]\s*(\d+)/);
  if (!distM || !repM) return null;
  let intervalRaw = null;
  const parenM = line.match(/\(([^)]+)\)/);
  const atM = line.match(/@\s*([^\s,，]+)/);
  if (parenM) intervalRaw = parenM[1];
  else if (atM) intervalRaw = atM[1];
  return {
    distance: parseInt(distM[1]),
    repCount: parseInt(repM[1]),
    intervalRaw,
    intervalSec: intervalRaw ? toSeconds(intervalRaw.replace(/["']/g, (m3) => m3)) : null,
    stroke: findStroke(line),
    rawHeader: line,
  };
}

// "Set 1 — 100m 스트로크 카운트" 처럼 반복 횟수 표기가 없는 세트 제목
function parseNamedHeader(line) {
  if (parseSetHeader(line)) return null;
  // "Set1: 13.18 / 13.60 / ..." 처럼 콜론 뒤에 바로 기록이 오는 줄은 세트 제목이 아니라
  // 라벨 붙은 랩 데이터 줄이다 (explodeLabelSegments가 처리). 세트 제목이라면 "Set 1 — 설명"처럼
  // 콜론 뒤가 숫자로 바로 시작하지 않는다.
  if (/^Set\s*\d+\s*:\s*\d/i.test(line)) return null;
  const m = line.match(/^Set\s*\d+\b.*$/i);
  if (!m) return null;
  return { distance: null, repCount: null, intervalRaw: null, intervalSec: null, stroke: findStroke(line), rawHeader: line };
}

// "혼계영/개인 세트 (25m, 종목별 & 휴식 표기)", "자유형 (인터벌 미상)" 처럼 거리·반복
// 표기가 정식 헤더 형태가 아닌 제목 줄. 이런 줄을 헤더로 인식 못 하면 그 아래 랩들이
// 직전 세트에 합쳐져서 거리(25m/50m 등)를 잘못 물려받는 문제가 생겨서 별도로 감지한다.
// 기록처럼 보이는 줄(초 단위 숫자, 랩 번호로 시작)은 제외하고, 괄호로 끝나는 제목 줄만 인정.
function parseOrphanHeader(line) {
  if (parseSetHeader(line) || parseNamedHeader(line)) return null;
  const t = line.trim();
  if (!t) return null;
  if (/\d+['.]\d/.test(t)) return null;
  if (/^\d+[.).]/.test(t)) return null;
  if (!/\)\s*$/.test(t)) return null;
  const distM = t.match(/(\d{2,3})m/);
  return { distance: distM ? parseInt(distM[1]) : null, repCount: null, intervalRaw: null, intervalSec: null, stroke: findStroke(t), rawHeader: t };
}

// ── 랩 한 줄에서 부가 정보를 하나씩 뽑아내는 조각 함수들 (원본 parseLapLine과 동일한 규칙) ──
function extractStroke(line) {
  for (const [kr, en] of Object.entries(STROKE_MAP)) {
    const re = new RegExp(`(^|\\s)${kr}(\\s|$)`);
    if (re.test(line)) return { value: en, line: line.replace(re, ' ').trim() };
  }
  return { value: null, line };
}
function extractStrokeCount(line) {
  const m = line.match(/(\d+)\s*strokes?/i);
  if (!m) return { value: null, line };
  return { value: parseInt(m[1]), line: line.replace(m[0], '').trim() };
}
function extractNote(line) {
  const m = line.match(/\(([^)]+)\)/);
  if (!m) return { value: null, line };
  return { value: m[1], line: line.replace(m[0], '').trim() };
}
// "휴식" 이라는 글자 앞/뒤, 또는 "→" 화살표 뒤에 붙은 시간을 휴식 시간으로 뽑아낸다.
// "값1 / 값2 → 45초" 처럼 화살표는 이 사용자 표기에서 항상 "그 앞은 기록, 뒤는 휴식"
// 이라 화살표일 때는 뒤쪽만 본다 (앞쪽을 보면 마지막 기록값을 휴식으로 착각하게 됨).
function extractRest(line) {
  const idxHu = line.indexOf('휴식');
  const idxAr = line.indexOf('→');
  let idx = -1, len = 0, arrowMode = false;
  if (idxHu !== -1 && (idxAr === -1 || idxHu <= idxAr)) { idx = idxHu; len = 2; }
  else if (idxAr !== -1) { idx = idxAr; len = 1; arrowMode = true; }
  if (idx === -1) return { value: null, line };

  const before = line.slice(0, idx);
  const after = line.slice(idx + len);
  const afterMatch = after.match(/^\s*([\d'".분초]+(?:\s*[\d'".분초]+)*)/);
  let restRaw = null, consumedBefore = '', consumedAfter = '';
  if (!arrowMode) {
    const beforeMatch = before.match(/([\d'".분초]+(?:\s*[\d'".분초]+)*)\s*$/);
    if (beforeMatch && beforeMatch[1].trim()) { restRaw = beforeMatch[1].trim(); consumedBefore = beforeMatch[0]; }
  }
  if (!restRaw && afterMatch && afterMatch[1].trim()) { restRaw = afterMatch[1].trim(); consumedAfter = afterMatch[0]; }

  let rest = restRaw
    ? (before.slice(0, before.length - consumedBefore.length) + ' ' + after.slice(consumedAfter.length))
    : (before + after);
  rest = rest.replace(/휴식/g, '').replace(/→/g, '').trim();
  return { value: restRaw ? toSeconds(restRaw.replace(/\s+/g, ' ')) : null, line: rest };
}
const UNCERTAIN_RE = /불확실|추정/;
function extractMissing(rawLine) {
  return /못쟀음|누락|이탈|빠져서/.test(rawLine);
}

// 개별 랩 라인 파싱 (원본 v0.1과 동일한 순서: 종목 → 스트로크카운트 → 메모 → 휴식 → 순번제거 → 누락감지 → 시간)
function parseLapLine(rawLine, repNo) {
  let line = rawLine.trim().replace(/^[*\-]\s*/, '');
  if (!line) return null;

  let stroke, strokeCount, note, restSec;
  ({ value: stroke, line } = extractStroke(line));
  ({ value: strokeCount, line } = extractStrokeCount(line));
  ({ value: note, line } = extractNote(line));
  ({ value: restSec, line } = extractRest(line));

  line = line.replace(/^\d+\.\s+/, '').trim();
  const isMissing = extractMissing(rawLine);
  if (isMissing) note = (note ? note + ' / ' : '') + rawLine;

  const timeCandidate = line.replace(/[&,]/g, ' ').trim().split(/\s+/)[0];
  const t = toSeconds(timeCandidate);
  const uncertain = UNCERTAIN_RE.test(rawLine);

  return {
    repNo, timeSec: t, restSec, strokeOverride: stroke, strokeCount,
    isMissing, needsReview: (t === null && restSec === null && !isMissing) || uncertain,
    note, rawText: rawLine,
  };
}

// "33.39 / 31.58 / 31.61 / ... / 30.xx" 처럼 한 줄에 여러 기록이 슬래시로 이어진 경우 랩별로 분리.
// 뒤쪽의 메모·스트로크수·휴식은 그 줄 전체에 한 번만 있는 것으로 보고 마지막 랩에 붙인다.
function looksLikeSlashGroup(rawLine) {
  const parts = rawLine.split('/').map((s) => s.trim()).filter(Boolean);
  if (parts.length < 2) return false;
  // "접 14.02 / 자 13.22"처럼 값 앞에 영법이 붙어 있을 수 있어, 그걸 뗀 다음 숫자로 시작하는지 본다.
  const numericish = parts.filter((p) => /^\d/.test(extractStroke(p).line.trim()));
  return numericish.length >= Math.ceil(parts.length / 2);
}
function expandSlashLine(rawLine, startRepNo) {
  let line = rawLine.trim().replace(/^\d+\.\s+/, '').replace(/^[*\-]\s*/, '');
  // 그룹 전체에 한 번만 있는 것으로 보고 뽑아내는 정보 (스트로크 수 · 메모 · 휴식)
  let strokeCount, note, restSec;
  ({ value: strokeCount, line } = extractStrokeCount(line));
  ({ value: note, line } = extractNote(line));
  ({ value: restSec, line } = extractRest(line));
  const isMissing = extractMissing(rawLine);
  const uncertain = UNCERTAIN_RE.test(rawLine);

  // 스트로크는 "접 14.02 / 자 13.22" 처럼 값마다 다를 수 있어 토큰별로 따로 뽑는다.
  const tokens = line.split('/').map((s) => s.trim()).filter(Boolean);
  return tokens.map((tok, i) => {
    const isLast = i === tokens.length - 1;
    const { value: strokeTok, line: tokBody } = extractStroke(tok);
    const t = toSeconds(tokBody.trim());
    return {
      repNo: startRepNo + i,
      timeSec: t,
      restSec: isLast ? restSec : null,
      strokeOverride: strokeTok,
      strokeCount: isLast ? strokeCount : null,
      isMissing: isMissing && isLast,
      needsReview: (t === null && !(isLast && (restSec !== null || (isMissing && isLast)))) || uncertain,
      note: isLast ? (isMissing ? (note ? note + ' / ' : '') + rawLine : note) : null,
      rawText: i === 0 ? rawLine : tok,
    };
  });
}

// "라벨: 12.31 / 12.51 / 12.38" (Set1:, 자유형:, 돌핀킥: 등) 처럼 한 줄에
// 라벨+콜론+기록목록이 하나 이상 이어 붙은 경우, 라벨 단위로 여러 줄로 쪼갠다.
// 라벨은 "Set숫자" 또는 알고 있는 영법 이름으로만 인식한다 (아무 단어나 라벨로 보면
// "Total: 1200m" 같은 요약 문장까지 랩으로 착각하게 됨).
const LABEL_RE = new RegExp(
  `(?:Set\\s*\\d+|${Object.keys(STROKE_MAP).sort((a, b) => b.length - a.length).join('|')})(?:\\s*\\([^)]*\\))?\\s*:\\s*(?=\\d)`,
  'gi'
);
function explodeLabelSegments(line) {
  const idxs = [...line.matchAll(LABEL_RE)].map((m) => m.index);
  if (idxs.length) {
    return idxs.map((idx, i) => {
      const seg = line.slice(idx, idxs[i + 1] ?? line.length).trim();
      const m = seg.match(/^(.*?):\s*(.*)$/);
      return m ? { label: m[1].trim(), body: m[2] } : { label: null, body: seg };
    });
  }
  // 라벨 목록엔 없지만 "설명: 값1 / 값2"처럼 콜론 뒤에 실제 값이 이어지는 경우의 일반 처리
  const m = line.match(/^(.*?)\s*:\s*(?=[\d/])(.*)$/);
  if (m && /\d/.test(m[2])) return [{ label: m[1].trim(), body: m[2] }];
  return [{ label: null, body: line }];
}

/**
 * 한 세트(헤더 1개 + 랩 여러 줄)에 해당하는 텍스트 블록을 sets/laps 구조로 변환.
 * rawText: 세트 하나 분량의 텍스트
 */
function parseSwimBlock(rawText) {
  const lines = normalizeText(rawText).split('\n').map((l) => l.trim()).filter(Boolean);
  let header = null;
  const lapLines = [];
  for (const line of lines) {
    const h = parseSetHeader(line) || parseNamedHeader(line) || parseOrphanHeader(line);
    if (h && !header) { header = h; continue; }
    lapLines.push(line);
  }
  // 제목 줄이 아예 없는 날(예: "자유형25m: 12.04 / 12.18 / 12.24")도 랩 줄 안에
  // "종목+거리" 표기가 일관되게 있으면 그걸로 거리를 채운다. 거리가 여러 개 섞여
  // 있으면(예: 자유형50m와 자유형100m이 한 블록에 같이 있는 경우) 자동으로 정할 수
  // 없으니 손대지 않고 그대로 검수 화면에서 채우게 둔다.
  if (!header) {
    const sniffed = sniffBlockMeta(lapLines);
    if (sniffed) header = { distance: sniffed.distance, repCount: null, intervalRaw: null, intervalSec: null, stroke: sniffed.stroke, rawHeader: null };
  }
  const laps = lapLinesToLaps(lapLines);
  return { header, laps };
}

function sniffBlockMeta(lapLines) {
  const found = [];
  for (const line of lapLines) {
    const re = /([가-힣]{1,3})\s*(\d{2,3})m\b/g;
    let m;
    while ((m = re.exec(line))) found.push({ stroke: STROKE_MAP[m[1]] || null, distance: parseInt(m[2]) });
  }
  if (!found.length) return null;
  const distances = new Set(found.map((f) => f.distance));
  if (distances.size !== 1) return null;
  const strokes = new Set(found.filter((f) => f.stroke).map((f) => f.stroke));
  return { distance: [...distances][0], stroke: strokes.size === 1 ? [...strokes][0] : null };
}

// 한 세트에 속하는 원본 줄들 -> 랩 배열. 라벨 분리 → 화살표 개수 확인 → 슬래시 분리 순으로 처리.
function lapLinesToLaps(lapLines) {
  const rawLaps = [];
  let n = 1;
  for (const rawWithBullet of lapLines) {
    const raw = rawWithBullet.replace(/^[*\-]\s*/, '');
    const arrowCount = (raw.match(/→/g) || []).length;
    if (arrowCount >= 2) {
      // 화살표가 2개 이상인 줄은 준비시간·기록묶음·휴식이 뒤섞여 있어 자동 분리가 위험 —
      // 통째로 검수 대상으로 남기고 사람이 직접 나누게 한다.
      rawLaps.push({ repNo: n++, timeSec: null, restSec: null, strokeOverride: null, strokeCount: null, isMissing: false, needsReview: true, note: null, rawText: raw });
      continue;
    }
    const segs = explodeLabelSegments(raw);
    for (const seg of segs) {
      const body = seg.body.trim();
      if (!body) continue;
      if (looksLikeSlashGroup(body)) {
        const laps = expandSlashLine(body, n);
        n += laps.length;
        rawLaps.push(...laps);
      } else {
        const lap = parseLapLine(body, n);
        if (lap) { n++; rawLaps.push(lap); }
      }
    }
  }
  // 시간 없이 휴식만 있는 단독 줄은 직전 랩의 휴식으로 병합
  const merged = [];
  for (const lap of rawLaps) {
    const restOnly = lap.timeSec === null && lap.restSec !== null && !lap.needsReview;
    if (restOnly && merged.length && merged[merged.length - 1].restSec === null) {
      merged[merged.length - 1].restSec = lap.restSec;
      continue;
    }
    merged.push(lap);
  }
  merged.forEach((lap, i) => { lap.repNo = i + 1; });
  return merged;
}

// ── 여러 세트가 섞인 하루치 텍스트 → 세트 여러 개로 분리 ──
function parseSessionMeta(firstLine) {
  if (!firstLine || parseSetHeader(firstLine) || parseNamedHeader(firstLine)) return null;
  const m = firstLine.match(/(\d{1,2})\s*\/\s*(\d{1,2})\s*(?:\(([^)]+)\))?/);
  if (!m) return null;
  const rest = firstLine.replace(m[0], '').trim();
  return { month: parseInt(m[1]), day: parseInt(m[2]), weekday: m[3] || null, location: rest || null, poolLength: sniffPool(rest), rawLine: firstLine };
}
function sniffPool(text) {
  const m = (text || '').match(/(\d{2,3})m\s*수영장/);
  return m ? parseInt(m[1]) : null;
}

function splitSwimText(raw) {
  const lines = normalizeText(raw).split('\n');
  let meta = null, start = 0;
  for (let i = 0; i < lines.length; i++) {
    const t = lines[i].trim();
    if (!t) { start = i + 1; continue; }
    meta = parseSessionMeta(t);
    start = meta ? i + 1 : i;
    break;
  }
  const { note, lines: bodyLines } = extractNotes(lines.slice(start));
  const blocks = [];
  let current = [];
  for (const line of bodyLines) {
    const trimmed = line.trim();
    if ((parseSetHeader(trimmed) || parseNamedHeader(trimmed) || parseOrphanHeader(trimmed)) && current.some((l) => l.trim())) {
      blocks.push(current.join('\n'));
      current = [line];
    } else current.push(line);
  }
  if (current.some((l) => l.trim())) blocks.push(current.join('\n'));
  return { meta, note, blocks: blocks.filter((b) => b.trim()).map(parseSwimBlock) };
}

// "메모: ...", "웜업: ..." 줄은 랩으로 보지 않고 세션 메모로 뽑아낸다.
function extractNotes(lines) {
  const notes = [];
  const kept = [];
  for (const line of lines) {
    const m = line.trim().replace(/^[*\-]\s*/, '').match(/^(메모|웜업)\s*[:：]?\s*(.*)$/);
    if (m) notes.push(`${m[1]}: ${m[2]}`.trim());
    else kept.push(line);
  }
  return { note: notes.join(' / ') || null, lines: kept };
}

// ── 날짜가 여러 개 섞인 문서 전체 → 하루 단위로 분리 (여러 날짜 한 번에 가져오기용) ──
const DOW = ['일', '월', '화', '수', '목', '금', '토'];
function parseDayHeader(line, refDate) {
  const t = line.trim();
  let m = t.match(/^(\d{4})-(\d{1,2})-(\d{1,2})\s*(?:\(([^)]+)\))?(?:\s*[—-]\s*(.*))?$/);
  if (m) {
    const y = +m[1], mo = +m[2], d = +m[3];
    const loc = (m[5] || '').replace(/,?\s*\d{2,3}m\s*수영장/, '').trim() || null;
    return { y, month: mo, day: d, weekday: m[4] || DOW[new Date(y, mo - 1, d).getDay()], location: loc, poolLength: sniffPool(m[5]) };
  }
  m = t.match(/^(\d{1,2})\s*\/\s*(\d{1,2})\s*(?:\(([^)]+)\))?\s*(.*)$/);
  if (m) {
    const mo = +m[1], d = +m[2];
    const now = refDate || new Date();
    let y = now.getFullYear();
    const cand = new Date(y, mo - 1, d);
    if (cand.getTime() - now.getTime() > 86400000) y -= 1;
    const loc = (m[4] || '').replace(/,?\s*\d{2,3}m\s*수영장/, '').trim() || null;
    return { y, month: mo, day: d, weekday: m[3] || DOW[new Date(y, mo - 1, d).getDay()], location: loc, poolLength: sniffPool(m[4]) };
  }
  return null;
}
function splitSwimLog(fullText) {
  const lines = normalizeText(fullText).split('\n');
  const starts = [];
  lines.forEach((l, i) => { if (parseDayHeader(l)) starts.push(i); });
  const days = [];
  for (let k = 0; k < starts.length; k++) {
    const h = parseDayHeader(lines[starts[k]]);
    const bodyLines = lines.slice(starts[k] + 1, starts[k + 1] ?? lines.length);
    const { note, lines: kept } = extractNotes(bodyLines);
    const blocks = [];
    let current = [];
    for (const line of kept) {
      const trimmed = line.trim();
      if ((parseSetHeader(trimmed) || parseNamedHeader(trimmed) || parseOrphanHeader(trimmed)) && current.some((l) => l.trim())) {
        blocks.push(current.join('\n'));
        current = [line];
      } else current.push(line);
    }
    if (current.some((l) => l.trim())) blocks.push(current.join('\n'));
    days.push({
      date: `${h.y}-${String(h.month).padStart(2, '0')}-${String(h.day).padStart(2, '0')}`,
      weekday: h.weekday, location: h.location, poolLength: h.poolLength || 25, note,
      blocks: blocks.filter((b) => b.trim()).map(parseSwimBlock),
    });
  }
  return days;
}

function fmtSec(sec) {
  if (sec == null) return '';
  const m = Math.floor(sec / 60), s = sec - m * 60;
  const sTxt = Number.isInteger(s) ? String(s) : s.toFixed(2);
  return m > 0 ? `${m}'${sTxt.padStart(s < 10 ? 5 : 0, '0')}` : sTxt;
}

const SwimParser = { parseSwimBlock, parseSetHeader, parseLapLine, toSeconds, splitSwimText, splitSwimLog, parseSessionMeta, parseDayHeader, STROKE_LABEL, fmtSec };
if (typeof module !== 'undefined') module.exports = SwimParser;
if (typeof window !== 'undefined') window.SwimParser = SwimParser;
