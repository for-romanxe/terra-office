// 연성 사무실 — 부서제: 서버가 보내는 부서 명단으로 탭·방·직원을 동적으로 구성한다.
// 활성 부서의 장면만 연기하고, 다른 부서의 메신저 기록은 뒤에서 계속 쌓인다.

// 좌표계: 아이소메트릭 사무실의 바닥 타일 (Scene이 화면 좌표로 바꿔준다)
const stageEl = document.getElementById("stage");
const sceneEl = document.getElementById("scene");
let stage = null; // Scene.build()가 돌려주는 무대 핸들
const deptTitleEl = document.getElementById("deptTitle");
const mHeadTextEl = document.getElementById("mHeadText");
const bubbleEl = document.getElementById("bubble");
const logsEl = document.getElementById("logs");
const tabsEl = document.getElementById("tabs");
const legendEl = document.getElementById("legend");
const sessionSel = document.getElementById("sessionSel");
const newSessionBtn = document.getElementById("newSessionBtn");
const delSessionBtn = document.getElementById("delSessionBtn");
const formEl = document.getElementById("sayForm");
const inputEl = document.getElementById("sayInput");
const boardListEl = document.getElementById("boardList");
const boardForm = document.getElementById("boardForm");
const boardInput = document.getElementById("boardInput");
const sendBtn = document.getElementById("sendBtn"); // 폼 첫 버튼은 📎라 id로 정확히 잡는다
const workStateEl = document.getElementById("workState");
const deptDeleteBtn = document.getElementById("deptDeleteBtn");
const noteCountEl = document.getElementById("noteCount");
const prBoardEl = document.getElementById("prBoard");
const pmBotEl = document.getElementById("pmBot");
const pmLogEl = document.getElementById("pmLog");
const pmRepoEl = document.getElementById("pmRepo");

const REDUCED = matchMedia("(prefers-reduced-motion: reduce)").matches;
const CORRIDOR_Y = 7.6; // 두 책상 줄 사이 통로

// 바닥 타일 좌표. scene.js가 그려둔 가구 위치와 맞춰져 있다.
const STATIONS = {
  chiefDesk:  { x: 8.85, y: 4.25, sit: true },  // 앞줄 가운데 책상
  chiefFront: { x: 8.85, y: 6.9 },              // 실장 앞 (보고 받는 자리)
  cabinet:    { x: 13.2, y: 11.2 },             // 자료실 캐비닛
  coffee:     { x: 2.4, y: 12.9 },              // 탕비실 카운터
  door:       { x: 14.6, y: 14.2 },             // 출입구
  smoke:      { x: 13.6, y: 3.2 },              // 유리 회의실
};
// 직원 자리 — 각 책상 앞 의자
const DESK_SLOTS = [
  { x: 4.05, y: 4.25 },
  { x: 11.25, y: 4.25 },
  { x: 5.05, y: 9.25 },
  { x: 7.45, y: 9.25 },
  { x: 9.85, y: 9.25 },
  { x: 12.25, y: 9.25 },
];
const STAND_SLOTS = [{ x: 6.4, y: 7.2 }, { x: 11.2, y: 7.2 }]; // 7명 초과 시에만 (설마)

const DEPT_LOOK = {
  비서실:   { icon: "work" },
  개발실:   { icon: "biotech" },
  물커톤실: { icon: "science" },
};
const DEFAULT_LOOK = { icon: "domain" };

// ── 부서/월드 상태 ────────────────────────────────────────────
// DEPTS[id] = { name, theme, roster, meta, busy, sessions, activeSession, logs }
// logs: 세션 id → { el, loaded } — 세션마다 메신저 기록이 분리된다
const DEPTS = {};
let active = null;   // 현재 보고 있는 부서 id
let CHARS = {};      // 활성 부서의 직원 메타 (id → {name, model, duty, color, home})
const world = { chars: {} }; // 활성 부서 캐릭터의 위치/이동 상태

let markers = {};     // 직원 id → 이름표 요소
let figures = {};     // 직원 id → SVG 사람 요소
let staffCards = {};  // 직원 id → {state, task} 상태 카드 요소
const busyChars = new Set();

const state = {
  bubbleChar: "chief",
  bubble: "",
  built: false,
  me: null,   // { name, rank, level } — 로그인한 사람
  level: 0,   // 사장 3 · 이사 2 · 본부장 1 · 미로그인 0
};

// ── 사원증: 로그인 토큰을 서버 요청마다 자동으로 붙인다 ────────────
// 호출 지점이 열 곳 넘게 흩어져 있어서 fetch를 한 번만 감싸는 쪽을 택했다.
const TOKEN_KEY = "officeToken";
const rawFetch = window.fetch.bind(window);
window.fetch = (input, init = {}) => {
  const t = localStorage.getItem(TOKEN_KEY);
  if (t && typeof input === "string" && input.startsWith("/")) {
    init = { ...init, headers: { ...(init.headers || {}), "x-office-token": t } };
  }
  return rawFetch(input, init);
};

// 부서 명단 → 직원 메타 (자리 배정 포함)
function buildMeta(roster) {
  const meta = {};
  meta.chief = {
    name: roster.chief.name,
    model: roster.chief.model,
    duty: "부서 총괄 — 지시 접수·위임·결과 보고",
    color: roster.chief.color,
    home: "chiefDesk",
    chief: true,
  };
  roster.employees.forEach((e, i) => {
    const desk = i < DESK_SLOTS.length;
    const s = desk ? DESK_SLOTS[i] : STAND_SLOTS[(i - DESK_SLOTS.length) % STAND_SLOTS.length];
    const home = `${desk ? "desk" : "stand"}_${e.id}`;
    STATIONS[home] = { x: s.x, y: s.y, sit: desk };
    meta[e.id] = { name: e.name, model: e.model, duty: e.duty || "", color: e.color, home };
  });
  return meta;
}

function releasePendingWalks() {
  for (const c of Object.values(world.chars)) {
    c.resolve?.();
    c.resolve = null;
    c.path = null;
  }
}

function switchDept(id) {
  if (opsOpen) closeOps(); // 부서를 고르면 관제실에서 나온다
  if (!DEPTS[id] || id === active) return;
  releasePendingWalks();
  jobs.length = 0;
  setBubble(null, "");
  busyChars.clear();

  active = id;
  const dept = DEPTS[id];
  CHARS = dept.meta;

  deptTitleEl.textContent = dept.name;
  // 쉘이 켜진 방은 제목 옆에 표시한다 — 켜둔 걸 잊으면 위험한 권한이라 눈에 보여야 한다
  if (dept.shell) {
    const badge = document.createElement("span");
    badge.className = "shellBadge";
    badge.textContent = "쉘 허용";
    badge.title = "이 방 직원은 터미널 명령을 실행할 수 있습니다 (node office/shell.mjs off 로 회수)";
    deptTitleEl.appendChild(badge);
  }
  mHeadTextEl.textContent = `사내 메신저 — ${dept.name} 직통`;
  stage = Scene.build(sceneEl, { lab: dept.theme?.preset === "lab" });

  // 직원들은 처음부터 자기 자리에 앉아 있다
  world.chars = {};
  for (const [cid, c] of Object.entries(CHARS)) {
    const st = STATIONS[c.home];
    world.chars[cid] = { x: st.x, y: st.y, sit: !!st.sit, walking: false, path: null, resolve: null };
  }
  buildStage();
  buildStaffCards();

  inputEl.placeholder = `${dept.name}에 지시 사항을 입력하세요`;
  selectSession(id, dept.activeSession);
  loadBoard(id);
  renderPrBoard();
  renderPmBot();
  refreshTabs();
  refreshBusyUI();
  // 방 삭제 버튼은 사장이 볼 때, 그리고 이 기능으로 만든 프로젝트 방에서만
  deptDeleteBtn.hidden = !(state.level >= 3 && dept.project);
}

// ── 사진 위 직원 마커 ────────────────────────────────────────
// 캔버스에 그리지 않고, 전경 사진 위에 얹은 이름표가 실제로 자리를 옮겨 다닌다.
function buildStage() {
  stageEl.textContent = "";
  markers = {};
  figures = {};
  for (const [id, c] of Object.entries(CHARS)) {
    figures[id] = stage.addPerson(c.color);

    const el = document.createElement("div");
    el.className = "marker" + (c.chief ? " chief" : "");
    const dot = document.createElement("span");
    dot.className = "dot";
    dot.style.background = c.color;
    el.appendChild(dot);
    el.appendChild(document.createTextNode(c.name));
    stageEl.appendChild(el);
    markers[id] = el;
  }
}

// ── 직원 상태 카드 ───────────────────────────────────────────
const STAFF_STATE = {
  idle: { cls: "", label: "대기 중", icon: "schedule", task: "more_horiz" },
  busy: { cls: "busy", label: "작업 중", icon: "", task: "autorenew" },
  wait: { cls: "wait", label: "결재 대기", icon: "approval", task: "gavel" },
};

function buildStaffCards() {
  legendEl.textContent = "";
  staffCards = {};
  for (const [id, c] of Object.entries(CHARS)) {
    const card = document.createElement("div");
    card.className = "staffCard" + (c.chief ? " isChief" : "");

    const accent = document.createElement("div");
    accent.className = "accent";
    accent.style.background = c.color;
    card.appendChild(accent);

    const top = document.createElement("div");
    top.className = "staffTop";
    const who = document.createElement("div");
    who.className = "staffWho";

    const av = document.createElement("div");
    av.className = "staffAvatar";
    av.textContent = c.name.slice(0, 1);
    who.appendChild(av);

    const info = document.createElement("div");
    const nm = document.createElement("div");
    nm.className = "staffName";
    nm.textContent = c.name;
    info.appendChild(nm);
    if (c.duty) {
      const duty = document.createElement("div");
      duty.className = "staffDuty";
      duty.textContent = c.duty;
      duty.title = c.duty;
      info.appendChild(duty);
    }
    if (c.model) {
      const md = document.createElement("div");
      md.className = "staffModel";
      md.textContent = c.model;
      info.appendChild(md);
    }
    who.appendChild(info);
    top.appendChild(who);

    const st = document.createElement("span");
    st.className = "staffState";
    top.appendChild(st);
    card.appendChild(top);

    const task = document.createElement("div");
    task.className = "staffTask";
    card.appendChild(task);

    legendEl.appendChild(card);
    staffCards[id] = { state: st, task };
    setStaff(id, "idle", "대기 중");
  }
}

function setStaff(id, kind, taskText) {
  const s = staffCards[id];
  if (!s) return;
  const def = STAFF_STATE[kind] || STAFF_STATE.idle;

  if (kind === "idle") busyChars.delete(id);
  else busyChars.add(id);

  s.state.className = "staffState " + def.cls;
  s.state.textContent = "";
  const badge = document.createElement("span");
  if (def.icon) {
    badge.className = "material-symbols-outlined";
    badge.textContent = def.icon;
  } else {
    badge.className = "sDot";
  }
  s.state.appendChild(badge);
  s.state.appendChild(document.createTextNode(def.label));

  s.task.className = "staffTask" + (kind === "idle" ? " idle" : "");
  s.task.textContent = "";
  const ic = document.createElement("span");
  ic.className = "material-symbols-outlined";
  ic.textContent = def.task;
  s.task.appendChild(ic);
  const t = document.createElement("span");
  t.textContent = taskText;
  t.title = taskText;
  s.task.appendChild(t);
}

// 모든 직원을 대기 상태로 (업무 종료 시)
function restStaff() {
  for (const id of Object.keys(staffCards)) setStaff(id, "idle", "대기 중");
}

// ── PR 스코어보드 (물커톤실 상단 — 팀원별 push 접수 횟수 + 복합 기여도 %) ────
// 기여도 = (push 횟수 비율 + 변경 줄수 비율) / 2 — 잦은 push와 큰 작업을 반반 반영
function prRec(v) {
  // 구버전 파일(숫자만)도 읽을 수 있게 정규화
  return typeof v === "object" && v
    ? { prs: v.prs || 0, lines: v.lines || 0 }
    : { prs: Number(v) || 0, lines: 0 };
}
function renderPrBoard() {
  const d = DEPTS[active];
  if (!d?.prBoard) {
    prBoardEl.hidden = true;
    return;
  }
  prBoardEl.hidden = false;
  prBoardEl.textContent = "";
  const title = document.createElement("span");
  title.className = "prTitle";
  title.textContent = "PR 집계";
  prBoardEl.appendChild(title);

  const members = Object.entries(d.prStats || {}).map(([name, v]) => ({ name, ...prRec(v) }));
  if (!members.length) {
    const empty = document.createElement("span");
    empty.className = "prEmpty";
    empty.textContent = "채팅에 이름을 남기면 여기에 올라갑니다";
    prBoardEl.appendChild(empty);
    return;
  }
  const totalPrs = members.reduce((s, m) => s + m.prs, 0);
  const totalLines = members.reduce((s, m) => s + m.lines, 0);
  for (const m of members) {
    const parts = [];
    if (totalPrs) parts.push(m.prs / totalPrs);
    if (totalLines) parts.push(m.lines / totalLines);
    m.pct = parts.length ? Math.round((parts.reduce((s, p) => s + p, 0) / parts.length) * 100) : 0;
  }
  members.sort((a, b) => b.pct - a.pct || b.prs - a.prs || a.name.localeCompare(b.name, "ko"));
  members.forEach((m, i) => {
    const lead = i === 0 && m.pct > 0;
    const chip = document.createElement("div");
    chip.className = "prChip" + (lead ? " lead" : "");
    const who = document.createElement("span");
    who.textContent = `${lead ? "🏆 " : ""}${m.name} PR ${m.prs}개`;
    const pct = document.createElement("span");
    pct.className = "prPct";
    pct.textContent = `${m.pct}%`;
    chip.appendChild(who);
    chip.appendChild(pct);
    prBoardEl.appendChild(chip);
  });
}

// ── PM 봇 알림 (물커톤실 전용 — 깃허브 push·PR·병합만 따로 흐른다) ────
const PM_KIND = {
  push:  { icon: "🚀", label: "push" },
  pr:    { icon: "🔀", label: "pr" },
  merge: { icon: "🛠", label: "merge" },
  gate:  { icon: "🔏", label: "결재" },
  info:  { icon: "📝", label: "info" },
};

function pmRow(entry) {
  const kind = PM_KIND[entry.kind] ? entry.kind : "info";
  // 점검 의견이 딸린 줄(결재)은 눌러서 펼치는 묶음으로 만든다 — 평소엔 한 줄, 필요할 때 전문
  if (entry.detail) return pmRowWithDetail(entry, kind);

  const row = document.createElement("div");
  row.className = "pmRow " + kind;

  const icon = document.createElement("span");
  icon.className = "pmIcon";
  icon.textContent = PM_KIND[kind].icon;
  row.appendChild(icon);

  const text = document.createElement("span");
  text.className = "pmText";
  text.textContent = entry.text;
  row.appendChild(text);

  const when = document.createElement("span");
  when.className = "pmTime";
  const d = new Date(entry.at);
  when.textContent = Number.isNaN(d.getTime())
    ? ""
    : `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  row.appendChild(when);
  return row;
}

// 결재 줄 — 요약 한 줄을 누르면 점검관 의견 전문이 그 자리에서 펼쳐진다
function pmRowWithDetail(entry, kind) {
  const wrap = document.createElement("details");
  wrap.className = "pmDetails " + kind;

  const sum = document.createElement("summary");
  sum.className = "pmRow " + kind;
  const icon = document.createElement("span");
  icon.className = "pmIcon";
  icon.textContent = PM_KIND[kind].icon;
  sum.appendChild(icon);
  const text = document.createElement("span");
  text.className = "pmText";
  text.textContent = entry.text;
  sum.appendChild(text);
  const when = document.createElement("span");
  when.className = "pmTime";
  const d = new Date(entry.at);
  when.textContent = Number.isNaN(d.getTime())
    ? ""
    : `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  sum.appendChild(when);
  wrap.appendChild(sum);

  const body = document.createElement("div");
  body.className = "pmDetailBody";
  body.textContent = entry.detail;
  wrap.appendChild(body);
  return wrap;
}

function renderPmBot() {
  const d = DEPTS[active];
  if (!d?.prBoard) {
    pmBotEl.hidden = true;
    return;
  }
  pmBotEl.hidden = false;
  pmRepoEl.textContent = d.gitRepo || "";
  pmLogEl.textContent = "";
  const log = d.gitLog || [];
  if (!log.length) {
    const empty = document.createElement("div");
    empty.className = "pmEmpty";
    empty.textContent = "아직 감지된 깃허브 활동이 없습니다. 팀원이 push하면 여기에 올라옵니다.";
    pmLogEl.appendChild(empty);
    return;
  }
  for (const e of log) pmLogEl.appendChild(pmRow(e));
  pmLogEl.scrollTop = pmLogEl.scrollHeight;
}

// ── 부서 게시판 (팀 공유 메모 — 직원 호출 없이 사람끼리 공유) ────
function renderBoard(memos) {
  boardListEl.innerHTML = "";
  if (!memos.length) {
    const p = document.createElement("div");
    p.className = "boardEmpty";
    p.textContent = "붙은 메모가 없습니다. 첫 메모를 남겨보세요.";
    boardListEl.appendChild(p);
    return;
  }
  for (const m of memos) {
    const card = document.createElement("div");
    card.className = "memo";
    const text = document.createElement("div");
    text.className = "mText";
    text.textContent = m.text;
    const meta = document.createElement("div");
    meta.className = "mMeta";
    const d = new Date(m.at);
    const when = `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
    const who = document.createElement("div");
    const whoName = document.createElement("span");
    whoName.className = "mWho";
    whoName.textContent = (m.rank ? m.rank + " " : "") + (m.name || "익명");
    const whoTime = document.createElement("span");
    whoTime.className = "mTime";
    whoTime.textContent = when;
    who.appendChild(whoName);
    who.appendChild(whoTime);
    meta.appendChild(who);
    // 남의 메모는 사장만 뗀다. 이사·본부장은 자기가 붙인 것만 — 서버도 같은 기준으로 막는다
    const mine = m.name && m.name === myName();
    if (mine || state.level >= 3) {
      const del = document.createElement("button");
      del.type = "button";
      del.className = "mDel";
      del.innerHTML = '<span class="material-symbols-outlined">delete</span>';
      del.title = mine ? "내 메모 떼기" : "메모 떼기 (사장 전용)";
      del.addEventListener("click", () => {
        fetch("/board/delete", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ dept: active, id: m.id }),
        }).catch(() => {});
      });
      meta.appendChild(del);
    }
    card.appendChild(text);
    card.appendChild(meta);
    boardListEl.appendChild(card);
  }
}

async function loadBoard(deptId) {
  try {
    const r = await fetch(`/board?dept=${encodeURIComponent(deptId)}`);
    if (!r.ok) return;
    const { memos } = await r.json();
    if (deptId === active) renderBoard(memos || []);
  } catch {}
}

boardForm.addEventListener("submit", (e) => {
  e.preventDefault();
  enableAlerts();
  const text = boardInput.value.trim();
  if (!text || !active) return;
  boardInput.value = "";
  fetch("/board", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ dept: active, text, name: myName() }),
  }).catch(() => {});
});

// ── 메모함 (사장 전용) ────────────────────────────────────────
// 직원의 save_note/delete_note와 같은 파일을 쓴다. 여기서 고치면 다음 지시부터 바로 반영된다.
const noteBoxEl = document.getElementById("noteBox");
const noteListEl = document.getElementById("noteList");
const noteModalEl = document.getElementById("noteModal");
const noteFormEl = document.getElementById("noteForm");
const noteTitleEl = document.getElementById("noteTitle");
const noteTextEl = document.getElementById("noteText");
const noteErrEl = document.getElementById("noteErr");
const noteDelBtn = document.getElementById("noteDelBtn");
const noteModalHead = document.getElementById("noteModalHead");
let editingNote = null; // 고치는 중인 메모의 원래 제목 (새 메모면 null)

async function loadNotes() {
  if (state.level < 3) {
    noteBoxEl.hidden = true;
    return;
  }
  noteBoxEl.hidden = false;
  try {
    const r = await fetch("/notes");
    if (!r.ok) return;
    const { notes } = await r.json();
    renderNotes(notes || []);
  } catch {}
}

function renderNotes(notes) {
  noteListEl.textContent = "";
  if (!notes.length) {
    const p = document.createElement("p");
    p.className = "nbEmpty";
    p.textContent = "메모가 없습니다. ＋로 직접 쓰거나, 직원에게 저장을 시키세요.";
    noteListEl.appendChild(p);
    return;
  }
  for (const n of notes) {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "noteItem";
    const t = document.createElement("span");
    t.className = "niTitle";
    t.textContent = n.title;
    const p = document.createElement("span");
    p.className = "niPreview";
    p.textContent = n.preview || "(빈 메모)";
    b.append(t, p);
    b.addEventListener("click", () => openNote(n.title));
    noteListEl.appendChild(b);
  }
}

async function openNote(title) {
  editingNote = title;
  noteErrEl.hidden = true;
  resetDelBtn();
  noteDelBtn.hidden = !title; // 새 메모에는 삭제 버튼이 없다
  noteModalHead.textContent = title ? "메모 고치기" : "새 메모";
  noteTitleEl.value = title || "";
  noteTextEl.value = "";
  noteModalEl.hidden = false;
  if (title) {
    try {
      const r = await fetch(`/note?title=${encodeURIComponent(title)}`);
      if (r.ok) noteTextEl.value = (await r.json()).text;
    } catch {}
  }
  (title ? noteTextEl : noteTitleEl).focus();
  noteTextEl.setSelectionRange(0, 0); // 긴 메모도 첫 줄부터 보이게
  noteTextEl.scrollTop = 0;
}

function closeNote() {
  noteModalEl.hidden = true;
  editingNote = null;
  resetDelBtn();
}

// 삭제는 한 번 더 눌러야 실행된다 (브라우저 confirm 창을 쓰지 않는다)
function resetDelBtn() {
  noteDelBtn.classList.remove("confirming");
  noteDelBtn.textContent = "삭제";
}

document.getElementById("noteAddBtn").addEventListener("click", () => openNote(null));
document.getElementById("noteCloseBtn").addEventListener("click", closeNote);
noteModalEl.addEventListener("click", (e) => {
  if (e.target === noteModalEl) closeNote();
});
addEventListener("keydown", (e) => {
  if (e.key === "Escape" && !noteModalEl.hidden) closeNote();
});

noteFormEl.addEventListener("submit", async (e) => {
  e.preventDefault();
  noteErrEl.hidden = true;
  const title = noteTitleEl.value.trim();
  if (!title) return;
  const r = await fetch("/note", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ title, text: noteTextEl.value, oldTitle: editingNote || "" }),
  }).catch(() => null);
  if (!r || !r.ok) {
    noteErrEl.textContent = r?.status === 403 ? "사장만 고칠 수 있습니다." : "저장하지 못했습니다.";
    noteErrEl.hidden = false;
    return;
  }
  closeNote();
  loadNotes();
});

noteDelBtn.addEventListener("click", async () => {
  if (!editingNote) return;
  if (!noteDelBtn.classList.contains("confirming")) {
    noteDelBtn.classList.add("confirming");
    noteDelBtn.textContent = "정말 삭제";
    return;
  }
  const r = await fetch("/note/delete", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ title: editingNote }),
  }).catch(() => null);
  if (!r || !r.ok) {
    noteErrEl.textContent = "삭제하지 못했습니다.";
    noteErrEl.hidden = false;
    resetDelBtn();
    return;
  }
  closeNote();
  loadNotes();
});

// ── 세션 (부서별 대화방 — 대회·프로젝트 단위) ──────────────────
function ensureLog(deptId, sid) {
  const d = DEPTS[deptId];
  if (!d.logs[sid]) {
    const el = document.createElement("div");
    el.className = "log";
    logsEl.appendChild(el);
    d.logs[sid] = { el, loaded: false };
  }
  return d.logs[sid];
}

function updateLogVisibility() {
  for (const d of Object.values(DEPTS)) {
    for (const [sid, l] of Object.entries(d.logs)) {
      l.el.classList.toggle("active", d.id === active && sid === d.activeSession);
    }
  }
}

function selectSession(deptId, sid) {
  const d = DEPTS[deptId];
  if (!d || !sid) return;
  const changed = d.activeSession !== sid;
  d.activeSession = sid;
  if (d.unread[sid]) {
    d.unread[sid] = 0; // 들어와서 봤으면 읽은 것
    refreshTabs();
  }
  const l = ensureLog(deptId, sid);
  if (!l.loaded) {
    l.loaded = true; // 저장된 기록을 불러와 복원
    fetch(`/history?dept=${encodeURIComponent(deptId)}&session=${encodeURIComponent(sid)}`)
      .then((r) => r.json())
      .then(({ events }) => {
        for (const ev of events || []) replayEvent(ev);
        l.el.scrollTop = l.el.scrollHeight;
      })
      .catch(() => {});
  }
  if (deptId === active) {
    if (changed) {
      releasePendingWalks();
      jobs.length = 0;
      setBubble(null, "");
    }
    renderSessionBar();
    updateLogVisibility();
    l.el.scrollTop = l.el.scrollHeight;
  }
}

function renderSessionBar() {
  const d = DEPTS[active];
  if (!d) return;
  sessionSel.innerHTML = "";
  let unseen = 0;
  for (const s of d.sessions) {
    const o = document.createElement("option");
    o.value = s.id;
    const n = d.unread[s.id] || 0;
    unseen += n;
    o.textContent = n ? `● ${s.title} (${n})` : s.title;
    sessionSel.appendChild(o);
  }
  sessionSel.value = d.activeSession;
  sessionSel.classList.toggle("hasUnread", unseen > 0);
  // 대화방 정리는 사장만 — 이사·본부장에게는 버튼을 숨긴다
  delSessionBtn.hidden = state.level < 3;
}

sessionSel.addEventListener("change", () => selectSession(active, sessionSel.value));

newSessionBtn.addEventListener("click", async () => {
  const title = window.prompt("새 세션(대회) 이름을 입력하세요:");
  if (!title || !title.trim()) return;
  const res = await fetch("/session", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ dept: active, title: title.trim() }),
  }).catch(() => null);
  if (res && res.ok) {
    const s = await res.json();
    const d = DEPTS[active];
    if (!d.sessions.some((x) => x.id === s.id)) d.sessions.push(s);
    selectSession(active, s.id);
  }
});

delSessionBtn.addEventListener("click", async () => {
  const d = DEPTS[active];
  if (!d || !d.activeSession) return;
  const s = d.sessions.find((x) => x.id === d.activeSession);
  const ok = window.confirm(
    `세션 「${s?.title ?? ""}」을(를) 삭제할까요?\n대화 기록이 완전히 사라지며 복구할 수 없습니다.`
  );
  if (!ok) return;
  const res = await fetch("/session/delete", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ dept: active, session: d.activeSession }),
  }).catch(() => null);
  if (!res || !res.ok) {
    addChat(active, d.activeSession, {
      text: "⚠ 삭제 실패 — 부서가 일하는 중이면 끝난 뒤에 다시 시도하세요.",
      cls: "err",
    });
  }
});

// ── 프로젝트 방 개설·삭제 (사장 전용) ────────────────────────
// 물커톤실과 같은 구조(실장 + 전략·코드점검·통합)의 방을 이름만 정해 만든다.
function openRoomModal() {
  const name = window.prompt(
    "새 프로젝트 방 이름을 입력하세요 (예: 쌤노트실).\n한글·영문·숫자·공백 1~20자."
  );
  if (name == null) return;
  createRoom(name.trim());
}

async function createRoom(name) {
  if (!name) return;
  state.wantSwitchNext = true; // 개설 성공 시 그 방으로 바로 이동
  const res = await fetch("/dept/create", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name }),
  }).catch(() => null);
  if (!res || !res.ok) {
    state.wantSwitchNext = false;
    let msg = "개설 실패 — 서버에 연결하지 못했습니다.";
    if (res) { try { msg = (await res.json()).error || "개설 실패"; } catch { msg = "개설 실패"; } }
    window.alert(msg);
  }
  // 성공 시 SSE dept_created가 방을 심고 탭을 갱신한다.
}

deptDeleteBtn.addEventListener("click", async () => {
  const d = DEPTS[active];
  if (!d || !d.project) return;
  const ok = window.confirm(
    `「${d.name}」 방을 삭제할까요?\n이 방의 세션·대화·게시판·PR 기록이 모두 사라지며 복구할 수 없습니다.`
  );
  if (!ok) return;
  const res = await fetch("/dept/delete", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ dept: active }),
  }).catch(() => null);
  if (!res || !res.ok) {
    let msg = "삭제 실패 — 방이 일하는 중이면 끝난 뒤 다시 시도하세요.";
    if (res) { try { msg = (await res.json()).error || msg; } catch {} }
    window.alert(msg);
  }
  // 성공 시 SSE dept_deleted가 정리한다.
});

// ── 접속 로비: 지금 들어와 있는 사람을 게임 로비처럼 실시간으로 ────
const lobbyEl = document.getElementById("lobby");
const lobbyListEl = document.getElementById("lobbyList");
const lobbyCountEl = document.getElementById("lobbyCount");
const RANK_ORDER = { 사장: 3, 이사: 2, 본부장: 1 };

function renderLobby(people) {
  if (!state.me) { lobbyEl.hidden = true; return; }
  lobbyEl.hidden = false;
  lobbyCountEl.textContent = people.length;
  lobbyListEl.innerHTML = "";
  for (const p of people) {
    const row = document.createElement("div");
    row.className = "lobbyMember" + (p.name === state.me.name ? " me" : "");

    const av = document.createElement("span");
    av.className = "lobbyAvatar rank-" + p.rank;
    av.textContent = (p.name || "?").slice(0, 1);
    // 접속 표시 — 초록 점이 아바타 위에서 맥동한다
    const dot = document.createElement("span");
    dot.className = "lobbyOnline";
    av.appendChild(dot);
    row.appendChild(av);

    const mid = document.createElement("div");
    mid.className = "lobbyMid";
    const nm = document.createElement("span");
    nm.className = "lobbyName";
    nm.textContent = p.name + (p.name === state.me.name ? " (나)" : "");
    mid.appendChild(nm);
    const rk = document.createElement("span");
    rk.className = "lobbyRank rank-" + p.rank;
    rk.textContent = p.rank;
    mid.appendChild(rk);
    row.appendChild(mid);

    // 한 사람이 탭 여러 개를 열어두면 그 수를 작게 표시
    if (p.tabs > 1) {
      const tabs = document.createElement("span");
      tabs.className = "lobbyTabs";
      tabs.title = `탭 ${p.tabs}개 열어둠`;
      tabs.textContent = "×" + p.tabs;
      row.appendChild(tabs);
    }
    lobbyListEl.appendChild(row);
  }
}

// ── 관제실 ────────────────────────────────────────────────────
// 규칙 판정은 서버가 하고(무료), "왜?"를 누를 때만 AI 진단을 부른다(구독 소모).
// ── 테마 (다크/화이트) — 초기 적용은 head 인라인 스크립트가, 전환은 여기서 ──
const themeToggle = document.getElementById("themeToggle");
function applyThemeIcon() {
  const dark = document.documentElement.dataset.theme === "dark";
  // 지금이 다크면 "해"(화이트로 전환), 화이트면 "달"(다크로 전환)을 보여준다
  themeToggle.querySelector(".material-symbols-outlined").textContent = dark ? "light_mode" : "dark_mode";
  themeToggle.title = dark ? "화이트 모드로 전환" : "다크 모드로 전환";
}
applyThemeIcon();
themeToggle.addEventListener("click", () => {
  const next = document.documentElement.dataset.theme === "dark" ? "light" : "dark";
  document.documentElement.dataset.theme = next;
  localStorage.setItem("officeTheme", next);
  applyThemeIcon();
});

const contentEl = document.getElementById("content");
const opsTab = document.getElementById("opsTab");
const opsView = document.getElementById("opsView");
const opsList = document.getElementById("opsList");
const opsBadge = document.getElementById("opsBadge");
const opsAtEl = document.getElementById("opsAt");
const OPS_MARK = { ok: "○", warn: "△", bad: "●" };
let opsOpen = false;
let opsTimer = null;
// 받아둔 AI 진단 (항목 id → 답변). 자동 갱신으로 다시 그려도 지우지 않는다 — 구독을 써서 받은 것이라
const opsAnswers = new Map();

async function loadOps(render = true) {
  if (state.level < 3) return;
  const r = await fetch("/ops").catch(() => null);
  if (!r?.ok) return;
  const { checks, at } = await r.json();
  // 탭 뱃지는 관제실을 안 보고 있어도 이상을 알려주는 용도라 항상 갱신한다
  const bad = checks.filter((c) => c.level !== "ok").length;
  opsBadge.hidden = !bad;
  opsBadge.textContent = bad;
  opsBadge.className = "opsBadge" + (checks.some((c) => c.level === "bad") ? " bad" : "");
  if (render && opsOpen) renderOps(checks, at);
}

// 문제부터 위로: 이상 → 주의 → 정상
const LEVEL_RANK = { bad: 0, warn: 1, ok: 2 };
const byLevel = (a, b) => (LEVEL_RANK[a.level] ?? 3) - (LEVEL_RANK[b.level] ?? 3);

// "왜?" 버튼 하나에 진단 요청을 붙인다 (타일·행 공용)
function attachDiagnose(btn, ai, c) {
  btn.addEventListener("click", async () => {
    btn.disabled = true;
    btn.textContent = "확인 중…";
    ai.hidden = false;
    ai.textContent = "진단 중입니다…";
    const r = await fetch("/ops/diagnose", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: c.id }),
    }).catch(() => null);
    const j = r && r.ok ? await r.json() : null;
    const text = j?.text || "진단을 받지 못했습니다.";
    ai.textContent = text;
    if (j?.text) opsAnswers.set(c.id, text); // 갱신돼도 남도록 보관
    btn.textContent = "다시 묻기";
    btn.disabled = false;
  });
}

// 인프라 점검 하나 = 전폭 행 (힌트·진단까지 들어갈 자리가 있다)
function opsRow(c) {
  const row = document.createElement("div");
  row.className = "opsItem " + c.level;

  const mark = document.createElement("span");
  mark.className = "opsMark";
  mark.textContent = OPS_MARK[c.level] || "○";
  row.appendChild(mark);

  const mid = document.createElement("div");
  mid.className = "opsMid";
  const t = document.createElement("div");
  t.className = "opsTitle";
  t.textContent = c.title;
  mid.appendChild(t);
  const d = document.createElement("div");
  d.className = "opsDetail";
  d.textContent = c.detail;
  mid.appendChild(d);
  if (c.hint) {
    const h = document.createElement("div");
    h.className = "opsHint";
    h.textContent = c.hint;
    mid.appendChild(h);
  }
  const ai = document.createElement("div");
  ai.className = "opsAi";
  const kept = opsAnswers.get(c.id);
  ai.hidden = !kept;
  if (kept) ai.textContent = kept;
  mid.appendChild(ai);
  row.appendChild(mid);

  // 정상인 항목까지 AI를 부를 이유가 없다 — 문제 있는 것만 버튼을 준다
  if (c.level !== "ok") {
    const ask = document.createElement("button");
    ask.type = "button";
    ask.className = "opsAsk";
    ask.textContent = "왜?";
    ask.title = "AI에게 원인과 대처를 물어봅니다 (구독 사용)";
    attachDiagnose(ask, ai, c);
    row.appendChild(ask);
  }
  return row;
}

// 부서 하나 = 촘촘한 타일. 대기 중이면 작게, 문제면 색으로 튄다
function opsTile(c) {
  const tile = document.createElement("div");
  tile.className = "opsTile " + c.level;

  const head = document.createElement("div");
  head.className = "opsTileHead";
  const dot = document.createElement("span");
  dot.className = "opsTileDot";
  dot.textContent = OPS_MARK[c.level] || "○";
  head.appendChild(dot);
  const name = document.createElement("span");
  name.className = "opsTileName";
  name.textContent = c.title;
  head.appendChild(name);
  tile.appendChild(head);

  const st = document.createElement("div");
  st.className = "opsTileState";
  st.textContent = c.detail;
  tile.appendChild(st);

  // 문제 있는 부서만 진단 버튼과 답변 자리를 준다
  if (c.level !== "ok") {
    const ai = document.createElement("div");
    ai.className = "opsAi";
    const kept = opsAnswers.get(c.id);
    ai.hidden = !kept;
    if (kept) ai.textContent = kept;

    const ask = document.createElement("button");
    ask.type = "button";
    ask.className = "opsAsk";
    ask.textContent = "왜?";
    ask.title = "AI에게 원인과 대처를 물어봅니다 (구독 사용)";
    attachDiagnose(ask, ai, c);
    head.appendChild(ask);
    tile.appendChild(ai);
  }
  return tile;
}

function renderOps(checks, at) {
  opsAtEl.textContent = at ? `점검 ${new Date(at).toLocaleTimeString("ko-KR", { hour: "2-digit", minute: "2-digit", second: "2-digit" })}` : "";
  opsList.innerHTML = "";

  const depts = checks.filter((c) => c.id.startsWith("dept:")).sort(byLevel);
  const sys = checks.filter((c) => !c.id.startsWith("dept:")).sort(byLevel);

  // ── 상태 요약 스트립: 한눈에 "지금 괜찮은가" ──
  const counts = { ok: 0, warn: 0, bad: 0 };
  for (const c of checks) counts[c.level] = (counts[c.level] || 0) + 1;

  const summary = document.createElement("div");
  summary.className = "opsSummary " + (counts.bad ? "bad" : counts.warn ? "warn" : "ok");
  const verdict = document.createElement("div");
  verdict.className = "opsVerdict";
  verdict.innerHTML =
    `<span class="opsVerdictMark">${counts.bad ? OPS_MARK.bad : counts.warn ? OPS_MARK.warn : OPS_MARK.ok}</span>` +
    (counts.bad ? "이상 감지" : counts.warn ? "주의 필요" : "모두 정상");
  summary.appendChild(verdict);

  const pills = document.createElement("div");
  pills.className = "opsPills";
  for (const [lvl, label] of [["bad", "이상"], ["warn", "주의"], ["ok", "정상"]]) {
    const p = document.createElement("div");
    p.className = "opsPill " + lvl + (counts[lvl] ? "" : " zero");
    p.innerHTML = `<b>${counts[lvl]}</b>${label}`;
    pills.appendChild(p);
  }
  summary.appendChild(pills);
  opsList.appendChild(summary);

  // ── 부서 현황: 타일 그리드 ──
  if (depts.length) {
    const sec = document.createElement("div");
    sec.className = "opsSection";
    const h = document.createElement("div");
    h.className = "opsSecHead";
    h.textContent = `부서 현황 · ${depts.length}`;
    sec.appendChild(h);
    const grid = document.createElement("div");
    grid.className = "opsGrid";
    for (const c of depts) grid.appendChild(opsTile(c));
    sec.appendChild(grid);
    opsList.appendChild(sec);
  }

  // ── 시스템 점검: 전폭 행 ──
  if (sys.length) {
    const sec = document.createElement("div");
    sec.className = "opsSection";
    const h = document.createElement("div");
    h.className = "opsSecHead";
    h.textContent = "시스템 점검";
    sec.appendChild(h);
    const rows = document.createElement("div");
    rows.className = "opsRows";
    for (const c of sys) rows.appendChild(opsRow(c));
    sec.appendChild(rows);
    opsList.appendChild(sec);
  }
}

function openOps() {
  opsOpen = true;
  opsView.hidden = false;
  contentEl.hidden = true;
  deptTitleEl.textContent = "관제실";
  workStateEl.hidden = true;
  refreshTabs();
  loadOps();
  clearInterval(opsTimer);
  opsTimer = setInterval(() => loadOps(), 20000); // 열어둔 동안만 자동 갱신
}

function closeOps() {
  opsOpen = false;
  opsView.hidden = true;
  contentEl.hidden = false;
  workStateEl.hidden = false;
  clearInterval(opsTimer);
  opsTimer = null;
  refreshTabs();
}

opsTab.addEventListener("click", () => (opsOpen ? closeOps() : openOps()));
document.getElementById("opsRefresh").addEventListener("click", () => loadOps());

// 서버가 내려준 부서 하나를 DEPTS에 심는다 (hello 최초 구축 + 새 방 개설 공용).
function addDept(d) {
  DEPTS[d.id] = {
    id: d.id, name: d.name, theme: d.theme || {}, roster: d.roster,
    meta: buildMeta(d.roster), busy: d.busy,
    sessions: d.sessions || [],
    activeSession: d.sessions?.[d.sessions.length - 1]?.id || null,
    logs: {}, unread: {},
    prBoard: Boolean(d.prBoard), prStats: d.prStats || {},
    gitLog: d.gitLog || [], gitRepo: d.gitRepo || "",
    project: Boolean(d.project),
    shell: Boolean(d.shell),
  };
  return DEPTS[d.id];
}

function refreshTabs() {
  opsTab.hidden = state.level < 3;
  opsTab.classList.toggle("on", opsOpen);
  tabsEl.innerHTML = "";
  for (const d of Object.values(DEPTS)) {
    const b = document.createElement("button");
    b.type = "button";
    b.className = d.id === active && !opsOpen ? "tab on" : "tab";
    const icon = document.createElement("span");
    icon.className = "material-symbols-outlined";
    icon.textContent = (DEPT_LOOK[d.id] || DEFAULT_LOOK).icon;
    b.appendChild(icon);
    b.appendChild(document.createTextNode(`${d.busy ? "● " : ""}${d.name}`));
    const total = Object.values(d.unread || {}).reduce((a, n) => a + n, 0);
    if (total) {
      const badge = document.createElement("span");
      badge.className = "unreadBadge";
      badge.textContent = total > 99 ? "99+" : total;
      b.appendChild(badge);
    }
    b.addEventListener("click", () => switchDept(d.id));
    tabsEl.appendChild(b);
  }
  // 새 프로젝트 방 개설 — 사장만
  if (state.level >= 3) {
    const add = document.createElement("button");
    add.type = "button";
    add.className = "tab tabAdd";
    const ic = document.createElement("span");
    ic.className = "material-symbols-outlined";
    ic.textContent = "add";
    add.appendChild(ic);
    add.appendChild(document.createTextNode("새 프로젝트 방"));
    add.addEventListener("click", openRoomModal);
    tabsEl.appendChild(add);
  }
}

function refreshBusyUI() {
  const busy = DEPTS[active]?.busy;
  // 업무 중이어도 입력은 열어둔다 — 미리 쳐놓을 수 있게. 전송(보내기)만 막는다.
  inputEl.disabled = false;
  sendBtn.disabled = !!busy;
  inputEl.placeholder = busy
    ? "업무 중 — 미리 작성해두면 끝나는 대로 보낼 수 있어요"
    : "지시 사항을 입력하세요";
  workStateEl.textContent = busy ? "● 업무중" : "○ 대기중";
  workStateEl.classList.toggle("on", !!busy);
  if (!busy) inputEl.focus();
}

function setBubble(charId, text) {
  if (charId) state.bubbleChar = charId;
  if (text && !world.chars[state.bubbleChar]) text = "";
  state.bubble = text;
  if (!text) { bubbleEl.hidden = true; return; }
  bubbleEl.textContent = text;
  bubbleEl.hidden = false;
}

const cut = (t, n = 46) => (t.length > n ? t.slice(0, n) + "…" : t);
const fmtSize = (n) =>
  n < 1024 ? `${n}B` : n < 1048576 ? `${(n / 1024).toFixed(1)}KB` : `${(n / 1048576).toFixed(1)}MB`;

// ── 걷기: 복도를 경유하는 L자 경로 ──────────────────────────────
const WALK_SPEED = 3.2; // 타일/초
function walkTo(charId, stationName) {
  const c = world.chars[charId];
  const st = STATIONS[stationName];
  if (!c || !st) return Promise.resolve();
  return new Promise((resolve) => {
    if (REDUCED) {
      c.x = st.x; c.y = st.y; c.sit = !!st.sit;
      resolve();
      return;
    }
    c.sit = false; // 걸어가는 동안은 서 있는다
    c.sitOnArrive = !!st.sit;
    const pts = [];
    // 가로·세로로 다 움직여야 하면 통로를 경유해 ㄱ자로 돈다 (책상을 뚫고 가지 않도록)
    if (Math.abs(c.y - st.y) > 1.4 && Math.abs(c.x - st.x) > 1.4) {
      pts.push({ x: c.x, y: CORRIDOR_Y });
      pts.push({ x: st.x, y: CORRIDOR_Y });
    }
    pts.push({ x: st.x, y: st.y });
    c.path = pts;
    c.resolve = resolve;
  });
}

// ── 연기 큐 (활성 부서 전용) ──────────────────────────────────
const jobs = [];
let acting = false;
function push(job) {
  jobs.push(job);
  if (!acting) pump();
}
async function pump() {
  acting = true;
  while (jobs.length) await act(jobs.shift());
  acting = false;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, REDUCED ? Math.min(ms, 150) : ms));

async function act(j) {
  if (j.goto) await walkTo(j.char, j.goto);
  if (j.bubble !== undefined) setBubble(j.char, j.bubble);
  await sleep(j.hold ?? 800);
  if (!j.keepBubble) setBubble(null, "");
}

// 이벤트의 부서·세션이 화면에 떠 있을 때만 장면을 연기한다
function scene(ev, job) {
  if (ev.dept === active && ev.session === DEPTS[active]?.activeSession) push(job);
}

// ── 메신저 로그 (부서·세션별) ──────────────────────────────────
// 말풍선 복사 버튼 — 눌러 클립보드에 넣고 잠깐 체크 표시로 바뀐다
function makeCopyBtn(text) {
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "copyBtn";
  btn.title = "복사";
  btn.innerHTML = '<span class="material-symbols-outlined">content_copy</span>';
  btn.addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      // clipboard API가 막힌 환경(비보안 컨텍스트 등) 대비 폴백
      const ta = document.createElement("textarea");
      ta.value = text;
      ta.style.position = "fixed";
      ta.style.opacity = "0";
      document.body.appendChild(ta);
      ta.select();
      try { document.execCommand("copy"); } catch {}
      ta.remove();
    }
    btn.classList.add("copied");
    btn.innerHTML = '<span class="material-symbols-outlined">check</span>';
    setTimeout(() => {
      btn.classList.remove("copied");
      btn.innerHTML = '<span class="material-symbols-outlined">content_copy</span>';
    }, 1200);
  });
  return btn;
}

function addChat(deptId, sessionId, { who, rank, text, cls, color, file, files, trace, icon }) {
  if (!DEPTS[deptId] || !sessionId) return;
  const log = ensureLog(deptId, sessionId).el;
  let div;

  if (trace) {
    // 위임·도구·시스템 줄 — 본문 왼쪽에 들여쓴 한 줄 로그
    div = document.createElement("div");
    div.className = "trace " + trace + (cls === "err" ? " err" : "");
    const ic = document.createElement("span");
    ic.className = "material-symbols-outlined";
    ic.textContent = icon || "chevron_right";
    div.appendChild(ic);
    const t = document.createElement("span");
    t.textContent = who ? `${who} — ${text}` : text;
    div.appendChild(t);
  } else {
    div = document.createElement("div");
    div.className = "line " + (cls || "");
    if (who) {
      const tag = document.createElement("span");
      tag.className = "who";
      if (rank) {
        // 사람이 말한 줄에는 직급 꼬리표를 붙인다 (AI 직원과 구분)
        const badge = document.createElement("span");
        badge.className = "rankTag " + rank;
        badge.textContent = rank;
        tag.appendChild(badge);
      }
      tag.appendChild(document.createTextNode(who));
      if (color) tag.style.color = color;
      div.appendChild(tag);
    }
    const body = document.createElement("div");
    body.className = "body";
    body.textContent = text;
    div.appendChild(body);

    // 복사 버튼 — 드래그 없이 이 말풍선 내용을 그대로 복사한다
    if (text) div.appendChild(makeCopyBtn(text));
  }

  // 첨부 파일: files(배열) 또는 옛 file(단일) 둘 다 받는다. 누르면 다운로드된다
  const fileList = files || (file ? [file] : []);
  for (const f of fileList) {
    const a = document.createElement("a");
    a.className = "att";
    a.href = f.url;
    a.innerHTML = '<span class="material-symbols-outlined" style="font-size:13px">attach_file</span>';
    a.appendChild(document.createTextNode(`${f.name} (${fmtSize(f.size)})`));
    div.appendChild(a);
  }
  log.appendChild(div);
  if (deptId === active && DEPTS[deptId].activeSession === sessionId) log.scrollTop = log.scrollHeight;
}

// ── 결재 카드 ─────────────────────────────────────────────────
const confirmMeta = new Map(); // 결재 id → {dept, agent}

function addConfirmCard(ev) {
  if (!DEPTS[ev.dept] || !ev.session) return;
  const log = ensureLog(ev.dept, ev.session).el;
  const card = document.createElement("div");
  card.className = "confirm";
  card.id = "confirm-" + ev.id;

  const bar = document.createElement("div");
  bar.className = "cBar";
  card.appendChild(bar);

  const inner = document.createElement("div");
  inner.className = "cInner";
  card.appendChild(inner);

  const head = document.createElement("div");
  head.className = "cHead";
  head.textContent = "〈 결재 요청 〉";
  inner.appendChild(head);

  const drafter = document.createElement("div");
  drafter.className = "cDrafter";
  const emp = DEPTS[ev.dept].meta[ev.agent];
  drafter.textContent = `기안: ${emp?.name || ev.agent}${emp?.model ? ` (${emp.model})` : ""}`;
  inner.appendChild(drafter);

  const body = document.createElement("div");
  body.className = "cBody";
  const what = document.createElement("div");
  what.className = "cWhat";
  what.textContent = ev.description;
  body.appendChild(what);
  // 점검관이 뭘 지적했는지 카드 안에서 바로 읽고 판단하도록 원문을 붙인다
  if (ev.review?.text) {
    const rv = document.createElement("div");
    rv.className = "cReview";
    const rvHead = document.createElement("div");
    rvHead.className = "cReviewHead";
    const who = DEPTS[ev.dept]?.meta?.[ev.review.by]?.name || "점검관";
    rvHead.textContent = `${who} 점검 의견`;
    rv.appendChild(rvHead);
    const rvBody = document.createElement("div");
    rvBody.className = "cReviewBody";
    rvBody.textContent = ev.review.text;
    rv.appendChild(rvBody);
    body.appendChild(rv);
  }
  const warn = document.createElement("div");
  warn.className = "cWarn";
  warn.textContent = "※ 이 작업은 되돌릴 수 없습니다.";
  body.appendChild(warn);
  inner.appendChild(body);

  // 승인 가능한 최소 직급은 카드마다 다르다 — 병합·푸시는 이사·본부장도, 나머지는 사장만.
  // 못 누르는 사람에게는 누구를 기다리는 중인지 보여준다 (서버도 403으로 막는다)
  const minRank = ev.minRank || 3;
  if (state.level < minRank) {
    const waiting = document.createElement("div");
    waiting.className = "cWaiting";
    waiting.textContent = minRank >= 3
      ? "사장님 결재 대기 중 — 이 작업은 사장님만 승인할 수 있습니다."
      : "결재 대기 중 — 출근한 사원(본부장 이상)이 승인할 수 있습니다.";
    inner.appendChild(waiting);
    log.appendChild(card);
    if (ev.dept === active && DEPTS[ev.dept].activeSession === ev.session) log.scrollTop = log.scrollHeight;
    return;
  }

  const btns = document.createElement("div");
  btns.className = "cBtns";
  const mk = (label, approve, cls) => {
    const b = document.createElement("button");
    b.type = "button";
    b.className = cls;
    b.textContent = label;
    b.addEventListener("click", async () => {
      btns.querySelectorAll("button").forEach((x) => (x.disabled = true));
      const res = await fetch("/confirm", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: ev.id, approve }),
      }).catch(() => null);
      if (res && res.status === 403) {
        btns.querySelectorAll("button").forEach((x) => (x.disabled = false));
        addChat(ev.dept, ev.session, {
          text: minRank >= 3
            ? "결재 권한이 없습니다 — 사장으로 다시 출근하세요."
            : "결재 권한이 없습니다 — 접속 코드로 다시 출근하세요.",
          trace: "sys", icon: "error", cls: "err",
        });
      }
    });
    return b;
  };
  btns.appendChild(mk("승인 〔印〕", true, "ok"));
  btns.appendChild(mk("반려", false, "no"));
  inner.appendChild(btns);

  log.appendChild(card);
  if (ev.dept === active && DEPTS[ev.dept].activeSession === ev.session) log.scrollTop = log.scrollHeight;
}

function resolveConfirmCard(ev) {
  const card = document.getElementById("confirm-" + ev.id);
  if (!card) return;
  card.classList.add(ev.approve ? "approved" : "denied");
  card.querySelector(".cPinRow")?.remove();
  card.querySelector(".cBtns")?.remove();

  const wrap = document.createElement("div");
  wrap.className = "stampWrap";
  const stamp = document.createElement("div");
  stamp.className = "stamp";
  stamp.textContent = ev.timeout ? "시한 경과" : ev.approve ? "〔 승 인 〕" : "〔 반 려 〕";
  wrap.appendChild(stamp);
  const when = document.createElement("div");
  when.className = "stampTime";
  const d = new Date();
  when.textContent = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")} ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  wrap.appendChild(when);
  card.querySelector(".cInner")?.appendChild(wrap);
}

// ── 도구 → 장면/로그 매핑 ─────────────────────────────────────
const TOOL_LABELS = {
  web_search:   (i) => [`자료 조사 중 —\n"${cut(i.query ?? "")}"`, `🔎 웹 검색: ${i.query ?? ""}`, "phone"],
  web_fetch:    (i) => [`링크 확인 중 —\n${cut(i.url ?? "", 40)}`, `🔗 링크 확인: ${i.url ?? ""}`, "phone"],
  save_note:    (i) => [`메모 정리 중 —\n『${cut(i.title ?? "", 24)}』`, `📁 메모 저장: ${i.title ?? ""}`, "cabinet"],
  read_note:    (i) => [`서류 확인 중 —\n『${cut(i.title ?? "", 24)}』`, `📂 메모 열람: ${i.title ?? ""}`, "cabinet"],
  list_notes:   () => ["서류함 훑어보는 중…", "🗂 메모 목록 확인", "cabinet"],
  read_user_context: (i) => [
    i.name ? `인사 기록 열람 중 —\n『${cut(i.name, 24)}』` : "인사 기록 목차 확인 중…",
    `🗄 사장님 기록 열람${i.name ? ": " + i.name : " (목차)"}`,
    "cabinet",
  ],
  archive_list_scraps: () => ["아카이버 장부 조회 중…", "📋 아카이버 스크랩 조회"],
  archive_list_activities: () => ["활동 기록부 조회 중…", "📋 아카이버 활동 기록 조회"],
  archive_add_scrap: (i) => [`스크랩 등록 중 —\n『${cut(i.title ?? "", 24)}』`, `📌 스크랩 등록: ${i.title ?? ""}`],
  archive_set_scrap_status: (i) => [`상태 변경 중 —\n"${cut(i.status ?? "", 20)}"`, `✏️ 스크랩 상태 변경: ${i.status ?? ""}`],
  archive_delete_scrap: () => ["삭제 결재 준비 중…", "🗑 스크랩 삭제 요청 (결재 대기)"],
  list_files:   (i) => [`폴더 확인 중 —\n${cut(i.path ?? "", 36)}`, `📁 폴더 확인: ${i.path ?? ""}`],
  read_file:    (i) => [`코드 검토 중 —\n${cut((i.path ?? "").split("/").pop(), 30)}`, `📖 파일 열람: ${i.path ?? ""}`],
  git_status:   (i) => ["변경사항 확인 중…", `🔍 git status: ${i.repo ?? ""}`],
  git_diff:     (i) => [`diff 검토 중${i.file ? " —\n" + cut(i.file, 30) : "…"}`, `🔍 git diff${i.file ? ": " + i.file : ""}`],
  git_log:      () => ["커밋 이력 확인 중…", "🔍 git log"],
  git_commit:   (i) => [`커밋 작성 중 —\n"${cut(i.message ?? "", 36)}"`, `✅ 커밋: ${i.message ?? ""}`],
  git_branch:   (i) => [i.name ? `브랜치 이동 중 —\n${cut(i.name, 26)}` : "브랜치 확인 중…", `🌿 브랜치${i.name ? ": " + i.name : " 목록"}`],
  git_merge:    (i) => [`병합 결재 준비 중 —\n${cut(i.branch ?? "", 26)}`, `🔀 병합 요청: ${i.branch ?? ""} (결재 대기)`],
  git_push:     () => ["푸시 결재 준비 중…", "🚀 push 요청 (결재 대기)"],
};

// ── 이벤트 → 채팅 줄 변환 (라이브·기록 복원 공용) ─────────────────
function chatFor(ev) {
  const M = DEPTS[ev.dept]?.meta || {};
  switch (ev.type) {
    case "user":
      return { who: ev.name || "나", rank: ev.rank, text: ev.text, cls: "me", file: ev.file, files: ev.files };
    case "delegate": {
      const emp = M[ev.to];
      if (!emp) return null;
      return {
        text: `${M.chief?.name || "실장"} → ${emp.name} (업무 위임)`,
        trace: "delegate", icon: "arrow_forward",
      };
    }
    case "tool": {
      const [, logText] = (TOOL_LABELS[ev.name] || (() => ["", `🛠 ${ev.name}`]))(ev.input || {});
      return { text: logText, trace: "tool", icon: "terminal" };
    }
    case "report": {
      const emp = M[ev.from];
      if (!emp) return null;
      return { who: emp.name, text: ev.text, color: emp.color };
    }
    case "assistant":
      return { who: M.chief?.name || "실장", text: ev.text, cls: "sec" };
    case "error":
      return { text: "오류: " + ev.text, trace: "sys", icon: "error", cls: "err" };
  }
  return null;
}

// 저장된 세션 기록을 채팅으로만 복원한다 (장면 연기는 하지 않음)
function replayEvent(ev) {
  if (ev.type === "confirm_request") {
    if (state.pendingIds?.has(ev.id)) return; // 아직 대기 중 — 아래에서 카드로 다시 뜬다
    addChat(ev.dept, ev.session, { text: `결재 요청 — ${ev.description}`, trace: "sys", icon: "gavel" });
    return;
  }
  if (ev.type === "confirm_result") {
    addChat(ev.dept, ev.session, {
      text: ev.timeout ? "결재 〔시한 경과 · 자동 반려〕" : ev.approve ? "결재 〔승 인〕" : "결재 〔반 려〕",
      trace: "sys", icon: ev.approve ? "verified" : "block",
    });
    return;
  }
  const chat = chatFor(ev);
  if (chat) addChat(ev.dept, ev.session, chat);
}

// ── 알림: 다른 창을 보고 있을 때 보고·결재 도착을 알려준다 ─────────
// 시스템 알림(권한 필요) + 삐 소리 + 탭 제목 📬 — 셋 다 화면을 보고 있으면 울리지 않는다
const BASE_TITLE = document.title;
let audioCtx = null;

function enableAlerts() {
  // 브라우저 규칙상 권한 요청·소리 준비는 사용자가 뭔가 눌렀을 때만 가능하다
  if ("Notification" in window && Notification.permission === "default") {
    Notification.requestPermission().catch(() => {});
  }
  if (!audioCtx) {
    try { audioCtx = new (window.AudioContext || window.webkitAudioContext)(); } catch {}
  }
}

function beep() {
  if (!audioCtx) return;
  try {
    if (audioCtx.state === "suspended") audioCtx.resume();
    const o = audioCtx.createOscillator();
    const g = audioCtx.createGain();
    o.type = "square"; // 도트 사무실이니 8비트 호출음
    o.frequency.setValueAtTime(880, audioCtx.currentTime);
    o.frequency.setValueAtTime(1174, audioCtx.currentTime + 0.12);
    g.gain.setValueAtTime(0.06, audioCtx.currentTime);
    g.gain.exponentialRampToValueAtTime(0.0001, audioCtx.currentTime + 0.4);
    o.connect(g).connect(audioCtx.destination);
    o.start();
    o.stop(audioCtx.currentTime + 0.4);
  } catch {}
}

function notify(ev, title, body) {
  // 화면을 보고 있든 말든 무조건 알림을 보낸다 (📬 표시는 딴 데 보고 있을 때만)
  if (document.hidden || !document.hasFocus()) document.title = "📬 " + title;
  beep();
  // 크롬 시스템 알림 — https(터널)·localhost에서만 지원된다 (와이파이 IP 접속은 소리·📬만)
  if ("Notification" in window && Notification.permission === "granted") {
    try {
      const n = new Notification(title, { body: cut(body, 90), tag: "office-" + ev.dept });
      n.onclick = () => { window.focus(); n.close(); };
    } catch {}
  }
}
addEventListener("focus", () => (document.title = BASE_TITLE));
document.addEventListener("visibilitychange", () => {
  if (!document.hidden) document.title = BASE_TITLE;
});
// 지시를 안 보내고 구경만 하는 사람도 알림을 받도록, 첫 클릭·입력 때 바로 권한을 요청한다
addEventListener("click", enableAlerts, { once: true });
addEventListener("keydown", enableAlerts, { once: true });

// ── 안읽음 뱃지: 보고 있지 않은 세션에 새 소식이 오면 개수를 센다 ──
// 기록 복원(replayEvent)은 세지 않고, 라이브 이벤트만 센다
const UNREAD_TYPES = new Set(["user", "report", "assistant", "confirm_request"]);
function markUnread(ev) {
  const d = DEPTS[ev.dept];
  if (!d || !ev.session || !UNREAD_TYPES.has(ev.type)) return;
  if (ev.dept === active && d.activeSession === ev.session) return; // 지금 보고 있는 세션
  d.unread[ev.session] = (d.unread[ev.session] || 0) + 1;
  refreshTabs();
  if (ev.dept === active) renderSessionBar();
}

// ── 서버 이벤트 처리 ──────────────────────────────────────────
function handleEvent(ev) {
  markUnread(ev);
  switch (ev.type) {
    case "hello": {
      noteCountEl.textContent = ev.notes;
      state.owner = Boolean(ev.owner);
      state.me = ev.me || null;
      state.level = ev.me?.level || 0;
      showMe();
      renderLobby(ev.presence || []);
      if (state.built) break;
      state.built = true;
      for (const d of ev.departments) addDept(d);
      // 아직 안 끝난 결재는 기록 복원 때 글자 한 줄로 흘리지 않고 카드로 되살린다
      state.pendingIds = new Set((ev.pendingConfirms || []).map((c) => c.id));
      switchDept(ev.departments[0].id);
      for (const c of ev.pendingConfirms || []) {
        confirmMeta.set(c.id, { dept: c.dept, session: c.session, agent: c.agent });
        addConfirmCard(c);
      }
      break;
    }

    case "presence": {
      renderLobby(ev.people || []);
      break;
    }

    case "board_updated": {
      if (ev.dept === active) renderBoard(ev.memos || []);
      break;
    }

    case "pr_stats": {
      const d = DEPTS[ev.dept];
      if (!d) break;
      d.prStats = ev.stats || {};
      if (ev.dept === active) renderPrBoard();
      break;
    }

    case "git_log": {
      const d = DEPTS[ev.dept];
      if (!d || !ev.entry) break;
      (d.gitLog ||= []).push(ev.entry);
      if (d.gitLog.length > 60) d.gitLog.shift();
      if (ev.dept === active && !pmBotEl.hidden) {
        pmLogEl.querySelector(".pmEmpty")?.remove();
        pmLogEl.appendChild(pmRow(ev.entry));
        pmLogEl.scrollTop = pmLogEl.scrollHeight;
      }
      break;
    }

    case "session_created": {
      const d = DEPTS[ev.dept];
      if (!d) break;
      if (!d.sessions.some((s) => s.id === ev.session.id)) d.sessions.push(ev.session);
      if (!d.activeSession) selectSession(ev.dept, ev.session.id); // 마지막 세션 삭제 후 자동 생성분
      if (ev.dept === active) renderSessionBar();
      break;
    }

    case "dept_created": {
      const d = ev.department;
      if (!d || DEPTS[d.id]) break;
      addDept(d);
      refreshTabs();
      if (state.wantSwitchNext) { state.wantSwitchNext = false; switchDept(d.id); }
      break;
    }

    case "dept_deleted": {
      const d = DEPTS[ev.dept];
      if (!d) break;
      for (const sid in (d.logs || {})) d.logs[sid]?.el?.remove();
      const wasActive = active === ev.dept;
      delete DEPTS[ev.dept];
      if (wasActive) {
        active = null;
        const next = Object.keys(DEPTS)[0];
        if (next) switchDept(next);
      }
      refreshTabs();
      break;
    }

    case "session_deleted": {
      const d = DEPTS[ev.dept];
      if (!d) break;
      d.sessions = d.sessions.filter((s) => s.id !== ev.session);
      delete d.unread[ev.session];
      const l = d.logs[ev.session];
      if (l) {
        l.el.remove();
        delete d.logs[ev.session];
      }
      if (d.activeSession === ev.session) {
        d.activeSession = null;
        const next = d.sessions[d.sessions.length - 1];
        if (next) selectSession(ev.dept, next.id);
      }
      if (ev.dept === active) renderSessionBar();
      break;
    }

    case "user":
      addChat(ev.dept, ev.session, chatFor(ev));
      DEPTS[ev.dept] && (DEPTS[ev.dept].busy = true);
      if (ev.dept === active) setStaff("chief", "busy", "지시 접수 — 검토 중");
      refreshTabs();
      if (ev.dept === active) refreshBusyUI();
      break;

    case "status": {
      if (ev.state !== "thinking") break;
      const M = DEPTS[ev.dept]?.meta || {};
      if (ev.dept === active) setStaff(ev.agent, "busy", "검토 중");
      if (ev.agent === "chief") {
        scene(ev, { char: "chief", goto: "chiefDesk", bubble: "음… 생각 중", keepBubble: true, hold: 500 });
      } else if (M[ev.agent]) {
        scene(ev, { char: ev.agent, goto: M[ev.agent].home, bubble: "확인 중…", keepBubble: true, hold: 400 });
      }
      break;
    }

    case "working":
      if (ev.dept === active && ev.session === DEPTS[active]?.activeSession && !acting && CHARS[ev.agent] && ev.seconds >= 30) {
        const m = Math.floor(ev.seconds / 60);
        const s = ev.seconds % 60;
        setBubble(ev.agent, `아직 작업 중입니다…\n(${m ? m + "분 " : ""}${s}초 경과)`);
      }
      break;

    case "delegate": {
      const M = DEPTS[ev.dept]?.meta || {};
      const emp = M[ev.to];
      if (!emp) break;
      addChat(ev.dept, ev.session, chatFor(ev));
      if (ev.dept === active) setStaff(ev.to, "busy", "지시 접수");
      scene(ev, { char: ev.to, goto: "chiefFront", hold: 200 });
      scene(ev, { char: "chief", bubble: `지시 —\n"${cut(ev.text)}"`, hold: 1500 });
      scene(ev, { char: ev.to, bubble: "알겠습니다!", hold: 700 });
      scene(ev, { char: ev.to, goto: emp.home, hold: 200 });
      break;
    }

    case "tool": {
      const M = DEPTS[ev.dept]?.meta || {};
      const who = M[ev.agent] ? ev.agent : "chief";
      const home = M[who]?.home || "chiefDesk";
      const [bub, , station] = (TOOL_LABELS[ev.name] || (() => [`${ev.name} 작업 중…`, `🛠 ${ev.name}`]))(ev.input || {});
      addChat(ev.dept, ev.session, chatFor(ev));
      if (ev.dept === active) setStaff(who, "busy", bub.replace(/\s*\n\s*/g, " "));
      if (station === "cabinet") {
        scene(ev, { char: who, goto: "cabinet", bubble: bub, hold: 1400 });
        scene(ev, { char: who, goto: home, hold: 150 });
      } else {
        scene(ev, { char: who, goto: home, bubble: bub, hold: 1400 });
      }
      break;
    }

    case "confirm_request": {
      confirmMeta.set(ev.id, { dept: ev.dept, session: ev.session, agent: ev.agent });
      addConfirmCard(ev);
      // 누를 수 있는 사람에게만 울린다 — 병합 결재는 이사·본부장에게도 간다
      if (state.level >= (ev.minRank || 3)) notify(ev, "결재 요청 (5분 내 승인 필요)", ev.description);
      const M = DEPTS[ev.dept]?.meta || {};
      if (ev.dept === active) setStaff(ev.agent, "wait", ev.description);
      if (M[ev.agent]) {
        scene(ev, {
          char: ev.agent, goto: "chiefFront",
          bubble: `결재 부탁드립니다!\n${cut(ev.description)}`,
          keepBubble: true, hold: 600,
        });
      }
      break;
    }

    case "confirm_result": {
      resolveConfirmCard(ev);
      const meta = confirmMeta.get(ev.id);
      confirmMeta.delete(ev.id);
      if (meta && meta.dept === active) {
        setStaff(meta.agent, "busy", ev.approve ? "결재 승인됨 — 실행 중" : "반려됨 — 취소");
      }
      if (meta && DEPTS[meta.dept]?.meta[meta.agent]) {
        const fakeEv = { dept: meta.dept, session: meta.session };
        scene(fakeEv, {
          char: meta.agent,
          bubble: ev.approve ? "결재 감사합니다!" : "알겠습니다,\n취소하겠습니다…",
          hold: 900,
        });
        scene(fakeEv, { char: meta.agent, goto: DEPTS[meta.dept].meta[meta.agent].home, hold: 150 });
      }
      break;
    }

    case "report": {
      const M = DEPTS[ev.dept]?.meta || {};
      const emp = M[ev.from];
      if (!emp) break;
      addChat(ev.dept, ev.session, chatFor(ev));
      if (ev.dept === active) setStaff(ev.from, "idle", "보고 완료");
      scene(ev, { char: ev.from, goto: "chiefFront", hold: 200 });
      scene(ev, { char: ev.from, bubble: `보고 —\n"${cut(ev.text)}"`, hold: 1800 });
      scene(ev, { char: ev.from, goto: emp.home, hold: 200 });
      break;
    }

    case "assistant":
      addChat(ev.dept, ev.session, chatFor(ev));
      notify(ev, `${DEPTS[ev.dept]?.name || ""} 보고 도착`, ev.text);
      if (ev.dept === active) setStaff("chief", "busy", "사장님께 보고 중");
      scene(ev, { char: "chief", goto: "chiefDesk", bubble: "보고드립니다!", hold: 1000 });
      break;

    case "notes":
      noteCountEl.textContent = ev.count;
      loadNotes(); // 직원이 메모를 쓰거나 지우면 목록도 따라 바뀐다
      break;

    case "error":
      addChat(ev.dept, ev.session, chatFor(ev));
      notify(ev, `${DEPTS[ev.dept]?.name || ""} 업무 실패`, ev.text);
      scene(ev, { char: "chief", goto: "chiefDesk", bubble: "죄송합니다,\n문제가 생겼습니다…", hold: 1500 });
      break;

    case "done":
      if (DEPTS[ev.dept]) DEPTS[ev.dept].busy = false;
      if (ev.dept === active) restStaff();
      scene(ev, { char: "chief", goto: "chiefDesk", bubble: "", hold: 200 });
      refreshTabs();
      if (ev.dept === active) refreshBusyUI();
      break;
  }
}

// EventSource는 GET 전용인데 cloudflared 빠른 터널이 GET 스트림을 통째로 버퍼링해서
// (cloudflared #1449), POST + fetch 스트림으로 받는다. 끊기면 2초 뒤 자동 재접속.
async function listenEvents() {
  while (true) {
    try {
      const res = await fetch("/events", { method: "POST" });
      const reader = res.body.getReader();
      const dec = new TextDecoder();
      let buf = "";
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let i;
        while ((i = buf.indexOf("\n\n")) !== -1) {
          const chunk = buf.slice(0, i);
          buf = buf.slice(i + 2);
          for (const line of chunk.split("\n")) {
            if (line.startsWith("data: ")) {
              try { handleEvent(JSON.parse(line.slice(6))); } catch {}
            }
          }
        }
      }
    } catch {}
    await new Promise((r) => setTimeout(r, 2000));
  }
}
listenEvents();

// ── 사원증 확인 ──────────────────────────────────────────────
// 이름은 명부에서 서버가 정한다. 프론트가 보내는 name은 표시용일 뿐 서버가 덮어쓴다.
const loginGate = document.getElementById("loginGate");
const loginForm = document.getElementById("loginForm");
const loginNameSel = document.getElementById("loginName");
const loginCodeEl = document.getElementById("loginCode");
const loginBtn = document.getElementById("loginBtn");
const loginErrEl = document.getElementById("loginErr");
const meCardEl = document.getElementById("meCard");
const meRankEl = document.getElementById("meRank");
const meNameEl = document.getElementById("meName");

function myName() {
  return state.me?.name || "";
}

// 로그인 상태에 따라 사원증 카드 / 확인 화면을 전환한다
function showMe() {
  if (state.me) {
    loginGate.hidden = true;
    meCardEl.hidden = false;
    meRankEl.textContent = state.me.rank;
    meRankEl.className = "meRank " + state.me.rank;
    meNameEl.textContent = state.me.name;
    loadNotes();
    loadOps(false); // 관제실을 안 열어도 탭 뱃지로 이상을 알린다
    return;
  }
  meCardEl.hidden = true;
  noteBoxEl.hidden = true;
  opsTab.hidden = true;
  loginGate.hidden = false;
  if (!loginNameSel.options.length) loadMemberNames();
}

async function loadMemberNames() {
  try {
    const r = await fetch("/members");
    const { members } = await r.json();
    loginNameSel.textContent = "";
    for (const m of members || []) {
      const o = document.createElement("option");
      o.value = m.name;
      o.textContent = `${m.name} (${m.rank})`;
      loginNameSel.appendChild(o);
    }
  } catch {}
}

loginForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  loginErrEl.hidden = true;
  loginBtn.disabled = true;
  const r = await fetch("/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: loginNameSel.value, code: loginCodeEl.value }),
  }).catch(() => null);
  loginBtn.disabled = false;
  if (!r) {
    // 서버까지 못 갔다 — 코드 문제가 아니라 주소·연결 문제 (주로 옛 터널 주소)
    loginErrEl.textContent = "서버에 연결할 수 없습니다. 접속 주소가 최신인지 확인하세요.";
    loginErrEl.hidden = false;
    return;
  }
  if (!r.ok) {
    // 서버는 응답했는데 거절 — 이름/코드가 안 맞음
    loginErrEl.textContent = "이름 또는 접속 코드가 맞지 않습니다.";
    loginErrEl.hidden = false;
    loginCodeEl.value = "";
    loginCodeEl.focus();
    return;
  }
  const { token } = await r.json();
  localStorage.setItem(TOKEN_KEY, token);
  location.reload(); // 직급에 따라 보이는 부서가 달라져서 통째로 다시 받는다
});

document.getElementById("logoutBtn").addEventListener("click", () => {
  localStorage.removeItem(TOKEN_KEY);
  location.reload();
});

// ── 입력 ─────────────────────────────────────────────────────

// ── 파일 첨부: 골라두면 다음 전달 때 지시와 함께 올라간다 ─────────
const attachBtn = document.getElementById("attachBtn");
const fileInput = document.getElementById("fileInput");
const attachBar = document.getElementById("attachBar");
const MAX_FILES = 10;
let pendingFiles = []; // 보내기 전 대기 중인 파일들

function clearAttach() {
  pendingFiles = [];
  fileInput.value = "";
  renderAttachBar();
}
function renderAttachBar() {
  attachBar.innerHTML = "";
  if (!pendingFiles.length) { attachBar.hidden = true; return; }
  attachBar.hidden = false;
  pendingFiles.forEach((f, i) => {
    const chip = document.createElement("span");
    chip.className = "attachChip";
    const nm = document.createElement("span");
    nm.className = "attachChipName";
    nm.textContent = `📎 ${f.name} (${fmtSize(f.size)})`;
    chip.appendChild(nm);
    const x = document.createElement("button");
    x.type = "button";
    x.title = "이 파일 빼기";
    x.textContent = "✕";
    x.addEventListener("click", () => { pendingFiles.splice(i, 1); renderAttachBar(); });
    chip.appendChild(x);
    attachBar.appendChild(chip);
  });
}
attachBtn.addEventListener("click", () => fileInput.click());
fileInput.addEventListener("change", () => {
  const sessionId = DEPTS[active]?.activeSession;
  for (const f of fileInput.files) {
    if (f.size > 10 * 1024 * 1024) {
      addChat(active, sessionId, { text: `⚠ ${f.name} — 개당 10MB 이하만 올릴 수 있습니다.`, cls: "err" });
      continue;
    }
    if (pendingFiles.length >= MAX_FILES) {
      addChat(active, sessionId, { text: `⚠ 한 번에 최대 ${MAX_FILES}개까지 보낼 수 있습니다.`, cls: "err" });
      break;
    }
    // 같은 파일을 두 번 고르면 한 번만 (이름·크기로 판단)
    if (pendingFiles.some((p) => p.name === f.name && p.size === f.size)) continue;
    pendingFiles.push(f);
  }
  fileInput.value = ""; // 같은 파일을 다시 고를 수 있도록 비운다
  renderAttachBar();
});

formEl.addEventListener("submit", async (e) => {
  e.preventDefault();
  enableAlerts(); // 답장 알림 준비 (권한은 크롬이 처음 한 번만 물어본다)
  // 업무 중이면 엔터를 눌러도 보내지 않는다 — 작성 중인 글은 그대로 둔다
  if (DEPTS[active]?.busy) return;
  const text = inputEl.value.trim();
  if ((!text && !pendingFiles.length) || !active) return;
  const name = myName();
  const deptId = active;
  const sessionId = DEPTS[deptId].activeSession;

  // 첨부가 있으면 하나씩 서버에 올리고, 서버가 준 저장 정보들을 지시와 함께 보낸다
  let fileInfos = [];
  if (pendingFiles.length) {
    sendBtn.disabled = true;
    const results = await Promise.all(
      pendingFiles.map((f) =>
        fetch(`/upload?dept=${encodeURIComponent(deptId)}&name=${encodeURIComponent(f.name)}`,
          { method: "POST", body: f })
          .then((up) => (up.ok ? up.json() : null))
          .catch(() => null)
      )
    );
    sendBtn.disabled = false;
    const failed = pendingFiles.filter((_, i) => !results[i]);
    if (failed.length) {
      addChat(deptId, sessionId, {
        text: `⚠ 파일 업로드 실패 (${failed.map((f) => f.name).join(", ")}) — 개당 10MB 이하만 올릴 수 있습니다.`,
        cls: "err",
      });
      return; // 하나라도 실패하면 보내지 않는다 (일부만 붙어 나가면 혼란스럽다)
    }
    fileInfos = results.map((r) => r.file);
    clearAttach();
  }

  inputEl.value = "";
  DEPTS[deptId].busy = true;
  refreshTabs();
  refreshBusyUI();
  const res = await fetch("/say", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ dept: deptId, session: sessionId, text, name, files: fileInfos }),
  }).catch(() => null);
  if (!res || !res.ok) {
    addChat(deptId, sessionId, {
      text: "⚠ 전달 실패 — 서버가 응답하지 않거나 부서가 이미 일하는 중입니다.",
      cls: "err",
    });
    DEPTS[deptId].busy = false;
    refreshTabs();
    refreshBusyUI();
  }
});

// ── 대기 중 소일거리: 활성 부서에서 아무나 커피 한 잔 ─────────────
setInterval(() => {
  if (REDUCED || acting || !active || DEPTS[active].busy || document.hidden) return;
  const ids = Object.keys(CHARS);
  const id = ids[Math.floor(Math.random() * ids.length)];
  push({ char: id, goto: "coffee", bubble: "☕", hold: 2200 });
  push({ char: id, goto: CHARS[id].home, hold: 200 });
}, 45000);

// ── 자리 비우기: 부서가 한가할 때 가끔 담배(흡연부스)나 커피(탕비실) ──
const idleBreakState = { char: null, kind: null };
async function idleBreak(kind) {
  const d = DEPTS[active];
  if (REDUCED || !d || d.busy || acting || idleBreakState.char || document.hidden) return;
  const ids = Object.keys(world.chars);
  if (!ids.length || Math.random() < 0.4) return; // 매번은 아니고 가끔
  const id = ids[Math.floor(Math.random() * ids.length)];
  const me = world.chars[id];
  idleBreakState.char = id;
  idleBreakState.kind = kind;
  try {
    await Promise.race([walkTo(id, kind), sleep(9000)]); // 부서 전환 등으로 못 걸으면 포기
    if (world.chars[id] !== me) return;
    const until = performance.now() + 6000 + Math.random() * 6000;
    while (performance.now() < until && world.chars[id] === me && !DEPTS[active]?.busy && !acting) {
      await sleep(300); // 일이 들어오면 바로 복귀
    }
  } finally {
    idleBreakState.char = null;
    idleBreakState.kind = null;
  }
  if (world.chars[id] === me && !me.path) await walkTo(id, CHARS[id]?.home);
}
setInterval(() => idleBreak(Math.random() < 0.5 ? "smoke" : "coffee").catch(() => {}), 40000);

function positionBubble() {
  if (bubbleEl.hidden) return;
  const c = world.chars[state.bubbleChar];
  if (!c || !stage) { bubbleEl.hidden = true; return; }
  const p = stage.project(c.x, c.y);
  bubbleEl.style.left = p.left + "%";
  bubbleEl.style.top = `calc(${p.headTop}% - 26px)`;
}

// ── 이동 루프: 사진 위 마커를 목적지로 걸어가게 한다 ──────────
let lastT = performance.now();
function frame(t) {
  const dt = Math.min((t - lastT) / 1000, 0.1);
  lastT = t;

  for (const [id, c] of Object.entries(world.chars)) {
    if (c.path && c.path.length) {
      const tg = c.path[0];
      const dx = tg.x - c.x;
      const dy = tg.y - c.y;
      const dist = Math.hypot(dx, dy);
      if (dist < 0.12) {
        c.x = tg.x;
        c.y = tg.y;
        c.path.shift();
        if (!c.path.length) {
          c.walking = false;
          c.path = null;
          c.sit = !!c.sitOnArrive;
          c.resolve?.();
          c.resolve = null;
        }
      } else {
        c.walking = true;
        c.x += (dx / dist) * WALK_SPEED * dt;
        c.y += (dy / dist) * WALK_SPEED * dt;
      }
    }
    if (stage && figures[id]) stage.place(figures[id], c.x, c.y, c.walking, c.sit);

    const el = markers[id];
    if (!el || !stage) continue;
    const p = stage.project(c.x, c.y);
    el.style.left = p.left + "%";
    el.style.top = p.headTop + "%";
    el.classList.toggle("busy", busyChars.has(id));
    // 앞쪽(아래) 사람의 이름표가 위로 겹쳐 보이도록
    el.style.zIndex = String(Math.round(c.x + c.y));
  }
  positionBubble();

  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);
