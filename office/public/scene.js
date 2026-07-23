// 사무실 전경 — 아이소메트릭 SVG 일러스트.
// 사진 대신 직접 그려서, 그 안의 사람들이 실제로 걷고·타이핑하고·숨쉬게 만든다.
// 좌표계는 바닥 타일(x, y). x는 오른쪽아래, y는 왼쪽아래로 간다. z는 높이.
const Scene = (() => {
  const NS = "http://www.w3.org/2000/svg";
  const TILE = 33, OX = 596, OY = 62, K = 0.866;
  // 바닥 마름모에 딱 맞춘 화면 창 (여백이 남지 않도록)
  const VB = { x: 78, y: 26, w: 1036, h: 576 };

  // x·y·z 모두 타일 단위. z(높이)도 반드시 TILE을 곱해야 한다.
  const iso = (x, y, z = 0) => [OX + (x - y) * TILE * K, OY + (x + y) * TILE * 0.5 - z * TILE];

  function el(name, attrs) {
    const n = document.createElementNS(NS, name);
    for (const k in attrs) n.setAttribute(k, attrs[k]);
    return n;
  }
  const poly = (pts, fill, attrs) =>
    el("polygon", Object.assign({ points: pts.map((p) => p[0].toFixed(1) + "," + p[1].toFixed(1)).join(" "), fill }, attrs));

  // #rrggbb 밝기 조절
  function shade(hex, k) {
    const m = /^#?([0-9a-f]{6})$/i.exec(String(hex || ""));
    if (!m) return hex || "#888";
    const n = parseInt(m[1], 16);
    const f = (v) => Math.max(0, Math.min(255, Math.round(v * k)));
    return `rgb(${f((n >> 16) & 255)},${f((n >> 8) & 255)},${f(n & 255)})`;
  }

  // 가구 밑 그림자 — 바닥에서 살짝 띄워 보이게 한다
  function shadow(g, x, y, w, d) {
    g.appendChild(poly(
      [iso(x + 0.08, y + 0.12), iso(x + w + 0.14, y + 0.12), iso(x + w + 0.14, y + d + 0.16), iso(x + 0.08, y + d + 0.16)],
      "rgba(44,60,84,0.13)"
    ));
  }

  // 등축 직육면체 — 윗면 + 오른쪽면 + 왼쪽면. 모든 가구가 이걸로 만들어져 형태가 일관된다.
  function box(g, x, y, z, w, d, h, top, opacity) {
    const t = [iso(x, y, z + h), iso(x + w, y, z + h), iso(x + w, y + d, z + h), iso(x, y + d, z + h)];
    const r = [iso(x + w, y, z + h), iso(x + w, y + d, z + h), iso(x + w, y + d, z), iso(x + w, y, z)];
    const l = [iso(x, y + d, z + h), iso(x + w, y + d, z + h), iso(x + w, y + d, z), iso(x, y + d, z)];
    const o = opacity === undefined ? {} : { opacity };
    if (h > 0) {
      g.appendChild(poly(r, shade(top, 0.86), o));
      g.appendChild(poly(l, shade(top, 0.94), o));
    }
    g.appendChild(poly(t, top, o));
  }

  const PALETTES = {
    office: {
      floor: "#dbe1e9", floorLine: "#cfd6e0", pool: "#eef2f7",
      desk: "#ffffff", leg: "#a8b2c0", chair: "#5c6879",
      screenBody: "#e7ebf1", screen: "#33475c", screenLit: "#6ba7cc",
      glass: "#9dc2d8", frame: "#b3c0cd",
      pot: "#c9d1db", leaf: ["#6b9868", "#82ae75", "#528354"],
      seat: "#d98a5a", counter: "#f0f3f7",
      npc: "#8d97a6",
      partition: "#d2d9e3",
    },
    lab: {
      floor: "#d6e0e6", floorLine: "#c9d5dd", pool: "#ecf2f5",
      desk: "#fdfefe", leg: "#a3b0b9", chair: "#556672",
      screenBody: "#e3ebef", screen: "#2a4658", screenLit: "#4fb6d2",
      glass: "#93bdd0", frame: "#adbdc7",
      pot: "#c4d1d8", leaf: ["#5c918d", "#72a599", "#487a7a"],
      seat: "#4aa8c8", counter: "#eef4f7",
      npc: "#8999a4",
      partition: "#ccd8de",
    },
  };

  // ── 사람 ────────────────────────────────────────────────────
  // 발 위치가 원점. 팔·다리는 각각 부모 g로 관절 위치를 잡고, 자식 g만 CSS로 회전시킨다.
  function limb(px, py, cls, rect) {
    const pivot = el("g", { transform: `translate(${px},${py})` });
    const swing = el("g", { class: cls });
    swing.appendChild(el("rect", rect));
    pivot.appendChild(swing);
    return pivot;
  }

  function makePerson(color, hair) {
    const g = el("g", { class: "person" });
    const skin = "#eabf9b";
    const pants = shade(color, 0.42);
    const sleeve = shade(color, 0.88);

    g.appendChild(el("ellipse", { cx: 0, cy: 0, rx: 11, ry: 4.4, fill: "rgba(38,50,68,0.15)" }));

    const legs = el("g", { class: "legs" });
    legs.appendChild(limb(-3.7, -20, "leg legA", { x: -2.7, y: 0, width: 5.4, height: 20, rx: 2.7, fill: pants }));
    legs.appendChild(limb(3.7, -20, "leg legB", { x: -2.7, y: 0, width: 5.4, height: 20, rx: 2.7, fill: shade(color, 0.36) }));
    g.appendChild(legs);

    const body = el("g", { class: "body" });
    body.appendChild(limb(-9.4, -35, "arm armA", { x: -2.1, y: 0, width: 4.2, height: 16, rx: 2.1, fill: sleeve }));
    body.appendChild(limb(9.4, -35, "arm armB", { x: -2.1, y: 0, width: 4.2, height: 16, rx: 2.1, fill: sleeve }));
    body.appendChild(el("rect", { x: -8.6, y: -38, width: 17.2, height: 21, rx: 6.2, fill: color }));
    // 셔츠 카라
    body.appendChild(el("path", { d: "M -3.4 -38 L 3.4 -38 L 0 -31.5 Z", fill: "rgba(255,255,255,0.82)" }));
    body.appendChild(el("rect", { x: -2.2, y: -40.5, width: 4.4, height: 4, rx: 1.6, fill: shade(skin, 0.92) }));
    body.appendChild(el("circle", { cx: 0, cy: -47, r: 7.2, fill: skin }));
    // 머리카락 — 정수리를 덮는 반원
    body.appendChild(el("path", { d: "M -7.2 -47.6 A 7.2 7.2 0 0 1 7.2 -47.6 Q 4 -50.6 0 -50.4 Q -4 -50.6 -7.2 -47.6 Z", fill: hair }));
    g.appendChild(body);
    return g;
  }

  // ── 가구 ────────────────────────────────────────────────────
  function desk(g, x, y, P, lit) {
    shadow(g, x, y, 2.1, 1.15);
    // 상판을 두툼하게 + 아래 가림판을 둬서 덩어리감을 준다
    box(g, x + 0.14, y + 0.14, 0, 1.82, 0.87, 0.62, shade(P.leg, 1.06));
    box(g, x, y, 0.62, 2.1, 1.15, 0.13, P.desk);
    // 모니터 — 받침 + 서 있는 화면
    box(g, x + 0.82, y + 0.52, 0.75, 0.3, 0.42, 0.05, P.leg);
    box(g, x + 0.94, y + 0.42, 0.8, 0.08, 0.62, 0.86, P.screenBody);
    const sx = x + 0.94;
    const s = [iso(sx, y + 0.47, 1.62), iso(sx, y + 0.99, 1.62), iso(sx, y + 0.99, 0.86), iso(sx, y + 0.47, 0.86)];
    g.appendChild(poly(s, lit ? P.screenLit : P.screen));
    if (lit) {
      const hl = [iso(sx - 0.01, y + 0.54, 1.5), iso(sx - 0.01, y + 0.92, 1.5), iso(sx - 0.01, y + 0.92, 1.34), iso(sx - 0.01, y + 0.54, 1.34)];
      g.appendChild(poly(hl, "rgba(255,255,255,0.32)"));
    }
    // 키보드 · 서류 · 머그
    box(g, x + 0.6, y + 0.26, 0.75, 0.52, 0.26, 0.04, shade(P.leg, 1.14));
    box(g, x + 0.14, y + 0.62, 0.75, 0.46, 0.38, 0.07, "#ffffff");
    box(g, x + 1.64, y + 0.24, 0.75, 0.2, 0.2, 0.19, P.seat);
  }

  function chair(g, x, y, P) {
    shadow(g, x - 0.28, y - 0.28, 0.56, 0.56);
    box(g, x - 0.07, y - 0.07, 0, 0.14, 0.14, 0.3, shade(P.chair, 0.78)); // 기둥
    box(g, x - 0.3, y - 0.3, 0.3, 0.6, 0.6, 0.08, P.chair);               // 좌판
    box(g, x - 0.31, y + 0.2, 0.38, 0.62, 0.1, 0.36, shade(P.chair, 0.92)); // 등받이
  }

  function plant(g, x, y, P, big) {
    const s = big ? 1 : 0.72;
    box(g, x, y, 0, 0.7 * s, 0.7 * s, 0.42 * s, P.pot);
    const [cx, cy] = iso(x + 0.35 * s, y + 0.35 * s, 0.42 * s);
    for (let i = 0; i < 5; i++) {
      const a = (i / 5) * Math.PI * 2 + 0.4;
      const r = (14 + (i % 2) * 7) * s;
      g.appendChild(el("ellipse", {
        cx: (cx + Math.cos(a) * r * 0.5).toFixed(1),
        cy: (cy - 10 * s - Math.sin(a) * r * 0.26).toFixed(1),
        rx: (11 * s).toFixed(1), ry: (7.5 * s).toFixed(1),
        fill: P.leaf[i % 3],
        transform: `rotate(${(a * 57).toFixed(0)} ${(cx + Math.cos(a) * r * 0.5).toFixed(1)} ${(cy - 10 * s - Math.sin(a) * r * 0.26).toFixed(1)})`,
      }));
    }
  }

  function glassPod(g, x, y, w, d, P) {
    box(g, x, y, 0, w, d, 0.04, shade(P.floor, 0.99));
    // 유리벽 두 면
    const wallR = [iso(x + w, y, 2.4), iso(x + w, y + d, 2.4), iso(x + w, y + d, 0), iso(x + w, y, 0)];
    const wallL = [iso(x, y + d, 2.4), iso(x + w, y + d, 2.4), iso(x + w, y + d, 0), iso(x, y + d, 0)];
    g.appendChild(poly(wallR, P.glass, { opacity: 0.34 }));
    g.appendChild(poly(wallL, P.glass, { opacity: 0.26 }));
    for (const p of [wallR, wallL]) {
      g.appendChild(el("polyline", {
        points: p.map((q) => q[0].toFixed(1) + "," + q[1].toFixed(1)).join(" "),
        fill: "none", stroke: P.frame, "stroke-width": 2.2, "stroke-linejoin": "round",
      }));
    }
    // 회의 테이블
    box(g, x + w / 2 - 0.6, y + d / 2 - 0.45, 0, 1.2, 0.9, 0.66, P.desk);
  }

  // ── 전체 조립 ────────────────────────────────────────────────
  const FLOOR = 16;

  function build(host, opts) {
    const P = PALETTES[opts && opts.lab ? "lab" : "office"];
    host.textContent = "";
    host.setAttribute("viewBox", `${VB.x} ${VB.y} ${VB.w} ${VB.h}`);

    const bg = el("g");
    // 바닥
    bg.appendChild(poly([iso(0, 0), iso(FLOOR, 0), iso(FLOOR, FLOOR), iso(0, FLOOR)], P.floor));
    for (let i = 1; i < FLOOR; i++) {
      for (const seg of [[iso(i, 0), iso(i, FLOOR)], [iso(0, i), iso(FLOOR, i)]]) {
        bg.appendChild(el("line", {
          x1: seg[0][0].toFixed(1), y1: seg[0][1].toFixed(1),
          x2: seg[1][0].toFixed(1), y2: seg[1][1].toFixed(1),
          stroke: P.floorLine, "stroke-width": 1,
        }));
      }
    }
    // 천창에서 떨어지는 빛 웅덩이
    for (const [lx, ly, lw, ld] of [[2, 5.5, 4.5, 3], [8.5, 1.5, 4, 2.6], [6, 11, 5, 3]]) {
      bg.appendChild(poly(
        [iso(lx, ly), iso(lx + lw, ly), iso(lx + lw, ly + ld), iso(lx, ly + ld)],
        P.pool, { opacity: 0.55 }
      ));
    }
    host.appendChild(bg);

    // 깊이(x+y) 밴드 — 뒤에 있는 것부터 그려야 겹침이 자연스럽다
    const bands = [];
    for (let i = 0; i <= FLOOR * 2 + 2; i++) {
      const b = el("g", { class: "band", "data-band": i });
      bands.push(b);
      host.appendChild(b);
    }
    const at = (x, y) => bands[Math.max(0, Math.min(bands.length - 1, Math.round(x + y)))];

    // 라운지 (또는 연구실 서버랙) — 카펫 + 안락의자 두 개 + 낮은 테이블
    function lounge(ox, oy) {
      const g0 = at(ox + 1.4, oy + 1.4);
      g0.appendChild(poly(
        [iso(ox - 0.4, oy - 0.4), iso(ox + 3.1, oy - 0.4), iso(ox + 3.1, oy + 3.1), iso(ox - 0.4, oy + 3.1)],
        P.pool, { opacity: 0.85 }
      ));
      for (const [cx, cy] of [[ox, oy + 0.3], [ox + 1.9, oy + 0.3]]) {
        const gg = at(cx + 0.4, cy + 0.4);
        shadow(gg, cx, cy, 0.9, 0.9);
        box(gg, cx, cy, 0, 0.9, 0.9, 0.36, P.seat);                          // 좌석
        box(gg, cx, cy + 0.72, 0.36, 0.9, 0.18, 0.42, shade(P.seat, 0.86));  // 등받이
        box(gg, cx + 0.76, cy, 0.36, 0.14, 0.72, 0.2, shade(P.seat, 0.93));  // 팔걸이
      }
      const gt = at(ox + 1.25, oy + 2.1);
      shadow(gt, ox + 1.0, oy + 1.85, 0.8, 0.8);
      box(gt, ox + 1.0, oy + 1.85, 0, 0.8, 0.8, 0.34, P.counter);
      box(gt, ox + 1.2, oy + 2.05, 0.34, 0.4, 0.4, 0.06, "#ffffff");
    }

    if (opts && opts.lab) {
      for (let i = 0; i < 3; i++) {
        const rx = 1.2 + i * 1.0;
        shadow(at(rx + 0.35, 2.3), rx, 1.6, 0.7, 1.4);
        box(at(rx + 0.35, 2.3), rx, 1.6, 0, 0.7, 1.4, 2.1, P.partition);
        box(at(rx + 0.35, 2.3), rx + 0.06, 1.7, 1.2, 0.02, 1.2, 0.5, P.screenLit);
      }
      lounge(1.4, 10.4);
    } else {
      lounge(1.2, 1.6);
      lounge(1.4, 10.4);
    }

    // 책상 두 줄
    const DESKS = [];
    [3, 5.4, 7.8, 10.2].forEach((x) => DESKS.push([x, 5]));
    [4, 6.4, 8.8, 11.2].forEach((x) => DESKS.push([x, 10]));
    DESKS.forEach(([x, y], i) => {
      desk(at(x + 1, y + 0.6), x, y, P, i % 3 !== 2);
      chair(at(x + 1, y - 0.9), x + 1.05, y - 0.75, P);
    });

    // 파티션
    box(at(3, 6.35), 3, 6.35, 0, 9.4, 0.14, 0.95, P.partition);

    // 유리 회의실 · 탕비실 카운터 · 자료실
    glassPod(at(12.6, 1.4), 12.6, 1.4, 3, 3, P);
    box(at(1, 12.2), 1, 12.2, 0, 2.6, 0.9, 0.9, P.counter);
    box(at(1.3, 12.4), 1.3, 12.4, 0.9, 0.5, 0.5, 0.42, P.screenBody);
    box(at(13.6, 10.4), 13.6, 10.4, 0, 1.1, 2.4, 1.7, P.partition);

    // 화분
    plant(at(6.6, 2.2), 6.6, 2.2, P, true);
    plant(at(12.4, 7.4), 12.4, 7.4, P, true);
    plant(at(0.8, 8.6), 0.8, 8.6, P, false);
    plant(at(9.4, 13.4), 9.4, 13.4, P, true);
    plant(at(14.6, 5.2), 14.6, 5.2, P, false);

    // 배경 인물 — 사무실이 비어 보이지 않게, 명단 직원과 구별되도록 회색조
    const npcs = [];
    const NPC = [
      [4.05, 4.25, "sit"], [6.45, 4.25, "sit"], [11.25, 4.25, "sit"],
      [5.05, 9.25, "sit"], [9.85, 9.25, "sit"],
      [13.9, 2.6, "idle"], [14.2, 3.4, "idle"], [2.3, 7.6, "idle"],
    ];
    for (const [x, y, mode] of NPC) {
      const g = makePerson(P.npc, "#4a5260");
      g.classList.add(mode === "sit" ? "sit" : "idle");
      const [sx, sy] = iso(x, y);
      g.setAttribute("transform", `translate(${sx.toFixed(1)},${sy.toFixed(1)})`);
      g.style.animationDelay = (Math.random() * -3).toFixed(2) + "s";
      at(x, y).appendChild(g);
      npcs.push(g);
    }

    return {
      bands,
      palette: P,
      // 직원 한 명을 무대에 올린다
      addPerson(color) {
        const g = makePerson(color || "#6b7f9e", "#3a3129");
        bands[0].appendChild(g);
        return g;
      },
      // 매 프레임 위치·상태 갱신 (밴드가 바뀔 때만 DOM을 옮긴다)
      place(g, x, y, walking, sitting) {
        const [sx, sy] = iso(x, y);
        g.setAttribute("transform", `translate(${sx.toFixed(1)},${sy.toFixed(1)})`);
        g.classList.toggle("walk", !!walking);
        g.classList.toggle("sit", !!sitting && !walking);
        const b = Math.max(0, Math.min(bands.length - 1, Math.round(x + y)));
        if (g.__band !== b) {
          g.__band = b;
          bands[b].appendChild(g);
        }
      },
      project: (x, y) => {
        const [sx, sy] = iso(x, y);
        return {
          left: ((sx - VB.x) / VB.w) * 100,
          top: ((sy - VB.y) / VB.h) * 100,
          headTop: ((sy - 56 - VB.y) / VB.h) * 100, // 이름표가 붙을 머리 위
        };
      },
    };
  }

  return { build, FLOOR };
})();
