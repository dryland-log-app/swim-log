/**
 * 수영 훈련 텍스트 로그 파서 (parseSwimLog.js 원본 그대로 + 브라우저용 유틸 추가)
 * 카톡/인스타 캡처에서 옮겨 적은 자유형식 텍스트를 sets/laps 구조로 변환합니다.
 * 완벽한 파싱은 불가능하므로, 애매한 라인은 needsReview: true 로 표시해서
 * 사용자가 확인 화면에서 검수 후 저장하는 흐름을 전제로 합니다.
 */

const STROKE_MAP = {
  '자': 'free', '자유형': 'free',
  '접': 'fly', '접영': 'fly',
  '배': 'back', '배영': 'back',
  '평': 'breast', '평영': 'breast',
  'im': 'im', 'IM': 'im',
};
const STROKE_LABEL = { free: '자유형', fly: '접영', back: '배영', breast: '평영', im: 'IM', mixed: '혼합', unknown: '미지정' };

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

// 세트 헤더 라인 감지: "50m x 8 (1'40")", "75m x 4", "[메인]자유형 50m x4"
function parseSetHeader(line) {
  const m = line.match(/(\d{2,3})m\s*[xX]\s*(\d+)(?:\s*\(([^)]+)\))?/);
  if (!m) return null;
  return {
    distance: parseInt(m[1]),
    repCount: parseInt(m[2]),
    intervalRaw: m[3] || null,
    intervalSec: m[3] ? toSeconds(m[3].replace(/["']/g, (m3) => m3)) : null,
  };
}

// 개별 랩 라인 파싱
function parseLapLine(rawLine, repNo) {
  let line = rawLine.trim();
  if (!line) return null;

  const lap = {
    repNo,
    timeSec: null,
    restSec: null,
    strokeOverride: null,
    strokeCount: null,
    isMissing: false,
    needsReview: false,
    note: null,
    rawText: rawLine,
  };

  for (const [kr, en] of Object.entries(STROKE_MAP)) {
    const re = new RegExp(`(^|\\s)${kr}(\\s|$)`);
    if (re.test(line)) {
      lap.strokeOverride = en;
      line = line.replace(re, ' ').trim();
      break;
    }
  }

  const strokeCountMatch = line.match(/(\d+)\s*strokes?/i);
  if (strokeCountMatch) {
    lap.strokeCount = parseInt(strokeCountMatch[1]);
    line = line.replace(strokeCountMatch[0], '').trim();
  }

  const parenMatch = line.match(/\(([^)]+)\)/);
  if (parenMatch) {
    lap.note = parenMatch[1];
    line = line.replace(parenMatch[0], '').trim();
  }

  const restIdx = line.indexOf('휴식');
  if (restIdx !== -1) {
    const before = line.slice(0, restIdx);
    const after = line.slice(restIdx + 2);
    const beforeMatch = before.match(/([\d'".분초]+(?:\s*[\d'".분초]+)*)\s*$/);
    const afterMatch = after.match(/^\s*([\d'".분초]+(?:\s*[\d'".분초]+)*)/);
    let restRaw = null;
    let consumedBefore = '', consumedAfter = '';
    if (beforeMatch && beforeMatch[1].trim()) {
      restRaw = beforeMatch[1].trim();
      consumedBefore = beforeMatch[0];
    } else if (afterMatch && afterMatch[1].trim()) {
      restRaw = afterMatch[1].trim();
      consumedAfter = afterMatch[0];
    }
    if (restRaw) {
      lap.restSec = toSeconds(restRaw.replace(/\s+/g, ' '));
      line = (before.slice(0, before.length - consumedBefore.length) + ' ' +
              after.slice(consumedAfter.length)).replace('휴식', '').trim();
    } else {
      line = line.replace('휴식', '').trim();
    }
  }

  line = line.replace(/^\d+\.\s+/, '').trim();

  if (/못쟀음|누락|이탈|빠져서/.test(rawLine)) {
    lap.isMissing = true;
    lap.note = (lap.note ? lap.note + ' / ' : '') + rawLine;
  }

  const timeCandidate = line.replace(/[&,]/g, ' ').trim().split(/\s+/)[0];
  const t = toSeconds(timeCandidate);
  if (t !== null) {
    lap.timeSec = t;
  } else if (!lap.isMissing) {
    lap.needsReview = true;
  }

  return lap;
}

/**
 * rawText: 하나의 세트(또는 세션 전체)에 해당하는 텍스트 블록
 * 반환: { header, laps: [...] }
 */
function parseSwimBlock(rawText) {
  const lines = rawText.split('\n').map((l) => l.trim()).filter(Boolean);
  let header = null;
  const lapLines = [];

  for (const line of lines) {
    const h = parseSetHeader(line);
    if (h && !header) {
      header = { ...h, rawHeader: line };
      continue;
    }
    lapLines.push(line);
  }

  const rawLaps = lapLines.map((line) => parseLapLine(line, 0)).filter(Boolean);

  const merged = [];
  for (const lap of rawLaps) {
    const isRestOnlyLine = lap.timeSec === null && lap.restSec !== null;
    if (isRestOnlyLine && merged.length > 0 && merged[merged.length - 1].restSec === null) {
      merged[merged.length - 1].restSec = lap.restSec;
      continue;
    }
    merged.push(lap);
  }
  merged.forEach((lap, i) => { lap.repNo = i + 1; });

  return { header, laps: merged };
}

// ── 여기부터는 원본 파서에 없는, 여러 세트가 섞인 긴 텍스트를 다루기 위한 보조 함수 ──

// 세션 첫 줄이 "9/12(금) 충무" 같은 날짜/장소 메모면 뽑아낸다. 없으면 null.
function parseSessionMeta(firstLine) {
  if (!firstLine || parseSetHeader(firstLine)) return null;
  const m = firstLine.match(/(\d{1,2})\s*\/\s*(\d{1,2})\s*(?:\(([^)]+)\))?/);
  if (!m) return null;
  const rest = firstLine.replace(m[0], '').trim();
  return { month: parseInt(m[1]), day: parseInt(m[2]), weekday: m[3] || null, location: rest || null, rawLine: firstLine };
}

// 붙여넣은 전체 텍스트를 세트 헤더 기준으로 여러 블록으로 나눔.
// 맨 앞에 날짜/장소 메모 줄이 있으면 meta로 분리해서 반환.
function splitSwimText(raw) {
  const lines = raw.split('\n');
  let meta = null;
  let start = 0;
  for (let i = 0; i < lines.length; i++) {
    const t = lines[i].trim();
    if (!t) { start = i + 1; continue; }
    meta = parseSessionMeta(t);
    start = meta ? i + 1 : i;
    break;
  }

  const blocks = [];
  let current = [];
  for (let i = start; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();
    if (parseSetHeader(trimmed) && current.some((l) => l.trim())) {
      blocks.push(current.join('\n'));
      current = [line];
    } else {
      current.push(line);
    }
  }
  if (current.some((l) => l.trim())) blocks.push(current.join('\n'));

  return { meta, blocks: blocks.filter((b) => b.trim()).map(parseSwimBlock) };
}

function fmtSec(sec) {
  if (sec == null) return '';
  const m = Math.floor(sec / 60), s = sec - m * 60;
  const sTxt = Number.isInteger(s) ? String(s) : s.toFixed(2);
  return m > 0 ? `${m}'${sTxt.padStart(m > 0 && s < 10 ? 5 : 0, '0')}` : sTxt;
}

window.SwimParser = { parseSwimBlock, parseSetHeader, parseLapLine, toSeconds, splitSwimText, parseSessionMeta, STROKE_LABEL, fmtSec };
