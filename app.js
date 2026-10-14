(async () => {
  const D = await loadData();
  const NW = D.weeks.length;
  const MG_COLOR = { 1: "var(--mg-1)", 2: "var(--mg-2)", 3: "var(--mg-3)", 4: "var(--mg-4)", 5: "var(--mg-5)" };
  const WEAR_OUT = 8;          // frequency where TM starts to erode (matches generator)
  const REACH_HEADROOM = 0.6;  // what-if: max +60% incremental reach from a cap
  const PAGE = 25;

  // ---------- lookups ----------
  const byKey = (rows) => Object.fromEntries(rows.map((r) => [r[0], r]));
  const clients = byKey(D.clients), brands = byKey(D.brands), agencies = byKey(D.agencies);
  const inds = byKey(D.indications), mgs = byKey(D.mediaGroups);
  const dimNames = Object.fromEntries(Object.entries(D.dims).map(([k, rows]) => [k, Object.fromEntries(rows)]));
  const weekDate = (i) => { const s = D.weeks[i]; return new Date(+s.slice(0, 4), +s.slice(4, 6) - 1, +s.slice(6, 8)); };
  const fmtDate = (d) => d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
  const fmtShort = (d) => d.toLocaleDateString("en-US", { month: "short", year: "2-digit" });
  const parse = (s) => new Date(s + "T00:00:00");

  const fmtInt = (n) => Math.round(n).toLocaleString("en-US");
  const fmtCompact = (n) => n >= 1e9 ? (n / 1e9).toFixed(2) + "B" : n >= 1e6 ? (n / 1e6).toFixed(1) + "M" : n >= 1e4 ? (n / 1e3).toFixed(0) + "K" : fmtInt(n);
  const pct = (x, d = 0) => (x * 100).toFixed(d) + "%";
  const signPct = (x) => (x >= 0 ? "+" : "−") + Math.abs(x * 100).toFixed(0) + "%";
  const usd = (n) => "$" + fmtCompact(n);

  function el(tag, attrs = {}, ...kids) {
    const e = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
      if (v == null || v === false) continue;
      if (k === "class") e.className = v;
      else if (k === "style") e.style.cssText = v;
      else if (k.startsWith("on")) e.addEventListener(k.slice(2), v);
      else e.setAttribute(k, v);
    }
    for (const c of kids.flat()) if (c != null) e.append(c instanceof Node ? c : document.createTextNode(String(c)));
    return e;
  }
  const svgEl = (tag, attrs = {}) => {
    const e = document.createElementNS("http://www.w3.org/2000/svg", tag);
    for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
    return e;
  };

  // ---------- tactic & program state at a given week ----------
  const tacticsByProg = {};
  for (const t of D.tactics) (tacticsByProg[t.p] ||= []).push(t);
  for (const p of D.programs) p.tactics = (tacticsByProg[p.k] || []).sort((a, b) => a.mg - b.mg || b.contract - a.contract);

  function idxAt(t, W) {        // last weekly row at or before W
    const a = t.w.i; let lo = 0, hi = a.length - 1, ans = -1;
    while (lo <= hi) { const m = (lo + hi) >> 1; if (a[m] <= W) { ans = m; lo = m + 1; } else hi = m - 1; }
    return ans;
  }
  function tState(t, j) {
    const w = t.w;
    const claims = w.claims[j], dx = w.dx[j];
    const rate = claims ? dx / claims : 0;
    const vs = rate / t.dxb - 1;
    const conf = w.conf[j];
    return {
      j, imps: w.imps[j], uniq: w.uniq[j], freq: w.freq[j], claims, dx, proj: w.proj[j], clk: w.clk[j],
      rate, tm: rate / t.nat, vs, conf, flag: conf === "L" ? "low" : vs >= 0 ? "above" : "below",
    };
  }
  const wearPenalty = (f) => 1 / (1 + 0.045 * Math.max(0, f - WEAR_OUT));

  function whatIf(t, s, cap) {
    if (cap >= s.freq) return { ...s, freedImps: 0, freedUsd: 0 };
    const match = s.claims / s.uniq;
    const uniq2 = Math.min(s.imps / cap, s.uniq * (1 + REACH_HEADROOM));
    const imps2 = uniq2 * cap;
    const claims2 = uniq2 * match;
    const tm2 = s.tm * wearPenalty(cap) / wearPenalty(s.freq);
    const rate2 = t.nat * tm2;
    const dx2 = claims2 * rate2;
    const freed = s.imps - imps2;
    return { imps: imps2, uniq: uniq2, freq: cap, claims: claims2, dx: dx2, rate: rate2, tm: tm2, vs: rate2 / t.dxb - 1,
             freedImps: freed, freedUsd: freed / 1000 * t.cpm };
  }

  function pState(p, W) {
    let imps = 0, uniq = 0, claims = 0, dx = 0, bexp = 0, nexp = 0, opp = 0;
    const ts = [];
    for (const t of p.tactics) {
      const j = idxAt(t, W);
      if (j < 0) continue;
      const s = tState(t, j);
      ts.push({ t, s });
      imps += s.imps; uniq += s.uniq; claims += s.claims; dx += s.dx;
      bexp += s.claims * t.dxb; nexp += s.claims * t.nat;
      if (s.flag === "below") opp += s.claims * t.dxb - s.dx;
    }
    if (!ts.length) return null;
    const rate = claims ? dx / claims : 0;
    return { ts, imps, uniq, claims, dx, freq: imps / uniq, vs: bexp ? dx / bexp - 1 : 0, tm: nexp ? dx / nexp : 0, opp, rate };
  }

  // program vs-benchmark trend across all weeks (carry PTD values forward after a tactic ends)
  for (const p of D.programs) {
    const dx = new Float64Array(NW), bexp = new Float64Array(NW);
    for (const t of p.tactics) {
      let j = 0;
      for (let W = t.w.i[0]; W < NW; W++) {
        while (j + 1 < t.w.i.length && t.w.i[j + 1] <= W) j++;
        dx[W] += t.w.dx[j]; bexp[W] += t.w.claims[j] * t.dxb;
      }
    }
    p.trend = Array.from(dx, (v, W) => (bexp[W] ? v / bexp[W] - 1 : null));
    p.firstW = Math.min(...p.tactics.map((t) => t.w.i[0]));
  }

  // ---------- UI state ----------
  const $ = (id) => document.getElementById(id);
  const state = { W: NW - 1, shown: PAGE, open: new Set(), openT: new Set(), playing: null };

  // filters
  for (const c of D.clients.slice().sort((a, b) => a[1].localeCompare(b[1]))) $("fClient").append(el("option", { value: c[0] }, c[1]));
  for (const ta of [...new Set(D.indications.map((i) => i[3]))].sort()) $("fTA").append(el("option", { value: ta }, ta));
  for (const m of D.mediaGroups) $("fMG").append(el("option", { value: m[0] }, `${m[1]} · ${m[2]}`));
  $("week").max = NW - 1; $("week").value = NW - 1;
  $("updated").textContent = "Updated: " + fmtDate(parse(D.updated));

  // ---------- tooltip ----------
  const tip = $("tip");
  function showTip(evt, head, rows) {
    tip.replaceChildren(el("div", { class: "t-h" }, head),
      ...rows.map((r) => el("div", { class: "t-r" },
        r.color ? el("i", { class: "key", style: `background:${r.color}` }) : null, el("b", {}, r.value), el("span", {}, r.label))));
    tip.hidden = false;
    const x = Math.min(evt.clientX + 14, window.innerWidth - tip.offsetWidth - 8);
    const y = evt.clientY + 14 + tip.offsetHeight > window.innerHeight ? evt.clientY - tip.offsetHeight - 10 : evt.clientY + 14;
    tip.style.left = x + "px"; tip.style.top = y + "px";
  }
  const hideTip = () => { tip.hidden = true; };

  // ---------- small components ----------
  const FLAG_TXT = { above: ["▲", "Above benchmark"], below: ["▼", "Below benchmark"], low: ["?", "Low confidence"] };
  const flagPill = (f) => el("span", { class: `flag ${f}` }, el("i", {}, FLAG_TXT[f][0]), FLAG_TXT[f][1]);
  const mgChip = (k) => el("span", { class: "mg", style: `--c:${MG_COLOR[k]}`, title: mgs[k][2] }, mgs[k][1]);

  function divBar(v, max = 1) {
    const w = Math.min(Math.abs(v) / max, 1) * 50;
    return el("div", { class: "div" },
      el("div", { class: "div-track" }, el("div", { class: "axis" }), el("div", { class: `bar ${v >= 0 ? "pos" : "neg"}`, style: `width:${w}%` })),
      el("span", { class: "div-val", style: `color:${v >= 0 ? "var(--ink)" : "var(--bad-ink)"}` }, signPct(v)));
  }

  function sparkline(p, W) {
    const vals = p.trend.slice(p.firstW, W + 1);
    const wpx = 120, h = 30;
    const s = svgEl("svg", { viewBox: `0 0 ${wpx} ${h}`, width: wpx, height: h, role: "img", "aria-label": "Dx vs benchmark trend" });
    const finite = vals.filter((v) => v != null);
    if (finite.length < 2) return s;
    const lim = Math.max(0.3, ...finite.map(Math.abs));
    const y = (v) => h / 2 - (v / lim) * (h / 2 - 3);
    const x = (i) => (i / (vals.length - 1)) * (wpx - 4) + 2;
    s.append(svgEl("line", { x1: 0, x2: wpx, y1: h / 2, y2: h / 2, stroke: "#c3cbd6", "stroke-dasharray": "2 2" }));
    const d = vals.map((v, i) => (v == null ? "" : `${i ? "L" : "M"}${x(i).toFixed(1)},${y(v).toFixed(1)}`)).join("");
    const last = finite[finite.length - 1];
    s.append(svgEl("path", { d, fill: "none", stroke: last >= 0 ? "var(--pos)" : "var(--neg)", "stroke-width": 2, "stroke-linejoin": "round" }));
    s.append(svgEl("circle", { cx: x(vals.length - 1), cy: y(last), r: 3, fill: last >= 0 ? "var(--pos)" : "var(--neg)" }));
    return s;
  }

  // ---------- line / bar chart with crosshair ----------
  function lineChart(host, { xs, values, color, fmt, refs = [], kind = "line", band }) {
    const W = host.clientWidth || 360, H = 150, m = { l: 44, r: 10, t: 10, b: 22 };
    const iw = W - m.l - m.r, ih = H - m.t - m.b;
    const svg = svgEl("svg", { viewBox: `0 0 ${W} ${H}`, height: H });
    const all = values.concat(refs.map((r) => r.y)).filter((v) => v != null && isFinite(v));
    let lo = kind === "bar" ? 0 : Math.min(...all), hi = Math.max(...all);
    if (kind !== "bar") { const pad = (hi - lo) * 0.12 || hi * 0.1 || 1; lo = Math.max(0, lo - pad); hi += pad; }
    else hi *= 1.08;
    const x = (i) => m.l + (xs.length === 1 ? iw / 2 : (i / (xs.length - 1)) * iw);
    const y = (v) => m.t + ih - ((v - lo) / (hi - lo || 1)) * ih;

    if (band) svg.append(svgEl("rect", { x: m.l, width: iw, y: y(Math.min(hi, band.to)), height: Math.max(0, y(Math.max(lo, band.from)) - y(Math.min(hi, band.to))), fill: "#fdf2e0" }));
    for (let k = 0; k <= 3; k++) {
      const v = lo + ((hi - lo) * k) / 3;
      svg.append(svgEl("line", { x1: m.l, x2: m.l + iw, y1: y(v), y2: y(v), stroke: k ? "var(--grid)" : "#c3cbd6" }));
      const t = svgEl("text", { x: m.l - 6, y: y(v) + 3, "text-anchor": "end" }); t.textContent = fmt(v); svg.append(t);
    }
    const ticks = Math.min(4, xs.length);
    for (let k = 0; k < ticks; k++) {
      const i = Math.round((k * (xs.length - 1)) / Math.max(1, ticks - 1));
      const t = svgEl("text", { x: x(i), y: H - 6, "text-anchor": k === 0 ? "start" : k === ticks - 1 ? "end" : "middle" });
      t.textContent = fmtShort(weekDate(xs[i])); svg.append(t);
    }
    if (kind === "bar") {
      const bw = Math.max(2, iw / xs.length - 2);
      values.forEach((v, i) => {
        const yy = y(v), hh = m.t + ih - yy;
        svg.append(svgEl("path", { d: `M${x(i) - bw / 2},${m.t + ih}V${yy + Math.min(2, hh)}q0,-2 2,-2h${bw - 4}q2,0 2,2V${m.t + ih}Z`, fill: color }));
      });
    } else {
      const d = values.map((v, i) => `${i ? "L" : "M"}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join("");
      svg.append(svgEl("path", { d, fill: "none", stroke: color, "stroke-width": 2, "stroke-linejoin": "round", "stroke-linecap": "round" }));
    }
    for (const r of refs) {
      svg.append(svgEl("line", { x1: m.l, x2: m.l + iw, y1: y(r.y), y2: y(r.y), stroke: "var(--ink-2)", "stroke-dasharray": "4 3", "stroke-width": 1.2 }));
      const t = svgEl("text", { x: m.l + iw, y: y(r.y) - 4, "text-anchor": "end", class: "ref-lbl" }); t.textContent = r.label; svg.append(t);
    }
    // crosshair layer
    const cross = svgEl("line", { y1: m.t, y2: m.t + ih, stroke: "var(--ink-2)", "stroke-width": 1, visibility: "hidden" });
    const dot = svgEl("circle", { r: 4, fill: color, stroke: "#fff", "stroke-width": 2, visibility: "hidden" });
    const hit = svgEl("rect", { x: m.l, y: m.t, width: iw, height: ih, fill: "transparent" });
    svg.append(cross, dot, hit);
    hit.addEventListener("pointermove", (e) => {
      const r = svg.getBoundingClientRect();
      const px = ((e.clientX - r.left) / r.width) * W;
      const i = Math.max(0, Math.min(xs.length - 1, Math.round(((px - m.l) / iw) * (xs.length - 1))));
      cross.setAttribute("x1", x(i)); cross.setAttribute("x2", x(i)); cross.setAttribute("visibility", "visible");
      if (kind !== "bar") { dot.setAttribute("cx", x(i)); dot.setAttribute("cy", y(values[i])); dot.setAttribute("visibility", "visible"); }
      showTip(e, "Week ending " + fmtDate(weekDate(xs[i])),
        [{ value: fmt(values[i], true), label: host.dataset.series, color }, ...refs.map((rf) => ({ value: fmt(rf.y, true), label: rf.label, color: "var(--ink-2)" }))]);
    });
    hit.addEventListener("pointerleave", () => { cross.setAttribute("visibility", "hidden"); dot.setAttribute("visibility", "hidden"); hideTip(); });
    host.append(svg);
  }

  // ---------- recommendation ----------
  function recommend(p, t, s, ps) {
    if (s.flag === "low") {
      const w = t.w, j = s.j, k = Math.max(0, j - 4);
      const pace = (w.claims[j] - w.claims[k]) / Math.max(1, j - k);
      const need = Math.max(0, 15000 - s.claims);
      const wks = pace > 0 ? Math.ceil(need / pace) : null;
      return { cls: "low", title: "Hold: not enough data to call this yet",
        body: `Only ${fmtInt(s.claims)} claims-matched visitors and ${fmtInt(s.dx)} Dx uniques so far. The read becomes reliable at about 15K matched visitors${wks ? `, which is about ${wks} more week${wks > 1 ? "s" : ""} at the current pace` : ""}.`,
        bullets: ["Keep delivery steady so you don't skew the early read", "Recheck once confidence moves to Medium"] };
    }
    if (s.flag === "below" && s.freq > 10) {
      return { cls: "bad", title: `Frequency wear-out: cap at ${WEAR_OUT}`,
        body: `This tactic averages ${s.freq.toFixed(1)} impressions per visitor, well past the ~${WEAR_OUT}× point where the targeting multiple starts to erode. Repeated impressions go to the same people instead of reaching new, likely-to-be-diagnosed users.`,
        bullets: [`Ask ad ops to set a frequency cap near ${WEAR_OUT}`, "Send the freed impressions to new users in the same condition audience", "Use the simulator to size the Dx impact"], whatif: true };
    }
    if (s.flag === "below") {
      const peers = ps.ts.filter((x) => x.t !== t && x.s.flag === "above").sort((a, b) => b.s.vs - a.s.vs);
      const seg = t.br.seg || [];
      const tot = seg.reduce((a, r) => a + r[1], 0) || 1;
      const weak = seg.filter((r) => r[0] >= 6).reduce((a, r) => a + r[1], 0) / tot;
      const bullets = [];
      if (peers.length) bullets.push(`Move budget to ${peers[0].t.code} | ${peers[0].t.dest} (${signPct(peers[0].s.vs)} vs. benchmark)`);
      if (weak > 0.25) bullets.push(`${pct(weak)} of impressions go to Caregiver / General Health audiences, which have lower Dx rates. Shift weight to Brand Seekers and Symptom Seekers`);
      if (mgs[t.mg][1] === "AP") bullets.push("Tighten the Advanced Programmatic deal to WebMD's condition audiences only");
      bullets.push("Check the ad size and site section mix below, and drop units with low engagement");
      return { cls: "bad", title: "Underperforming: reallocate or tighten targeting",
        body: `The Dx rate is ${pct(s.rate, 2)} against a ${pct(t.dxb, 2)} benchmark (${signPct(s.vs)}), and frequency is within range, so the gap is about the audience mix, not repetition.`,
        bullets, whatif: s.freq > WEAR_OUT };
    }
    if (s.freq < 6) {
      return { cls: "good", title: "Scale: strong performance with room to grow",
        body: `${signPct(s.vs)} vs. benchmark at a frequency of only ${s.freq.toFixed(1)}. There's room to add impressions before wear-out.`,
        bullets: ["Move budget here from tactics on this program that are below benchmark", "Expand to adjacent condition-center content"] };
    }
    return { cls: "good", title: "Maintain: performing above benchmark",
      body: `${signPct(s.vs)} vs. benchmark with frequency at ${s.freq.toFixed(1)}. Keep it running and watch frequency as the flight continues.`,
      bullets: [s.freq > WEAR_OUT ? `Frequency is above ${WEAR_OUT}. Consider a soft cap before performance starts to erode` : "No change needed"], whatif: s.freq > WEAR_OUT };
  }

  function whatIfPanel(t, s) {
    const lo = 3, hi = Math.max(4, Math.ceil(s.freq));
    const input = el("input", { type: "range", min: lo, max: hi, step: 0.5, value: Math.min(hi, Math.max(lo, WEAR_OUT)), "aria-label": "Frequency cap" });
    const capVal = el("span", { class: "cap-val" });
    const grid = el("div", { class: "wi-grid" });
    const tile = (l, v, d, cls) => el("div", { class: "wi" }, el("div", { class: "l" }, l), el("div", { class: "v" }, v), el("div", { class: `d ${cls}` }, d));
    const delta = (a, b, f = fmtInt) => { const dd = a - b; return [(dd >= 0 ? "+" : "−") + f(Math.abs(dd)), Math.abs(dd) < 1e-9 ? "flat" : dd > 0 ? "up" : "down"]; };
    function upd() {
      const cap = +input.value; capVal.textContent = cap.toFixed(1) + "×";
      const r = whatIf(t, s, cap);
      const [dDx, cDx] = delta(r.dx, s.dx);
      const [dU, cU] = delta(r.uniq, s.uniq, fmtCompact);
      const dvs = r.vs - s.vs;
      grid.replaceChildren(
        tile("Dx uniques", fmtInt(r.dx), dDx + " vs. today", cDx),
        tile("Uniques reached", fmtCompact(r.uniq), dU + " vs. today", cU),
        tile("Dx vs. benchmark", signPct(r.vs), (dvs >= 0 ? "+" : "−") + Math.abs(dvs * 100).toFixed(0) + " pts", dvs > 0.001 ? "up" : dvs < -0.001 ? "down" : "flat"),
      );
      note.textContent = r.freedImps > 1 ? `${fmtCompact(r.freedImps)} impressions (~${usd(r.freedUsd)}) freed to reallocate. Assumes at most +${REACH_HEADROOM * 100}% new reach in this audience.`
        : `At this cap all impressions go to new users. Assumes at most +${REACH_HEADROOM * 100}% new reach in this audience.`;
    }
    const note = el("div", { class: "wi-note" });
    input.addEventListener("input", upd);
    const panel = el("div", { class: "whatif" }, el("h5", {}, "What-if: frequency cap"),
      el("div", { class: "cap-row" }, el("span", {}, "Cap"), input, capVal), grid, note);
    upd();
    return panel;
  }

  // ---------- tactic detail ----------
  function tacticDetail(p, t, s, ps) {
    const rec = recommend(p, t, s, ps);
    const recoBox = el("div", { class: `reco ${rec.cls}` },
      el("div", {}, el("h4", {}, rec.title), el("p", {}, rec.body), el("ul", {}, rec.bullets.map((b) => el("li", {}, b)))),
      rec.whatif ? whatIfPanel(t, s) : el("div", { class: "whatif" }, el("h5", {}, "Snapshot"),
        el("div", { class: "wi-grid" },
          ...[["Clicks", fmtInt(s.clk)], ["CTR", pct(s.clk / s.imps, 2)], ["Revenue to date", usd(t.rev)],
              ["Booked CPM", "$" + t.cpm.toFixed(2)], ["Flight", `${fmtShort(parse(t.start))} – ${fmtShort(parse(t.end))}`], ["Pacing", pct(s.imps / t.contract)]]
            .map(([l, v]) => el("div", { class: "wi" }, el("div", { class: "l" }, l), el("div", { class: "v", style: "font-size:15px" }, v))))));

    const j = s.j, xs = t.w.i.slice(0, j + 1);
    const rates = xs.map((_, k) => (t.w.claims[k] ? t.w.dx[k] / t.w.claims[k] : 0));
    const c1 = el("div", { class: "chart-host", "data-series": "Dx rate (PTD)" });
    const c2 = el("div", { class: "chart-host", "data-series": "Frequency (PTD)" });
    const c3 = el("div", { class: "chart-host", "data-series": "Impressions" });
    const charts = el("div", { class: "charts" },
      el("div", { class: "chart" }, el("h5", {}, "Dx rate vs. benchmark"), el("div", { class: "c-sub" }, "Program-to-date Dx uniques ÷ claims-matched uniques"), c1),
      el("div", { class: "chart" }, el("h5", {}, "Frequency (imps per visitor)"), el("div", { class: "c-sub" }, `Shaded = wear-out zone above ${WEAR_OUT}×`), c2),
      el("div", { class: "chart" }, el("h5", {}, "Weekly impressions delivered"), el("div", { class: "c-sub" }, `Contract: ${fmtCompact(t.contract)} over the flight`), c3));

    const bd = el("div", { class: "breakdowns" },
      [["size", "Ad size"], ["dev", "Device"], ["ts", "Traffic source"], ["seg", "Audience"], ["sec", "Site section"]].map(([k, title]) => {
        const rows = (t.br[k] || []).slice().sort((a, b) => b[1] - a[1]);
        const tot = rows.reduce((a, r) => a + r[1], 0) || 1;
        const max = rows.length ? rows[0][1] : 1;
        return el("div", { class: "bd" }, el("h5", {}, title, el("span", {}, "share · CTR")),
          rows.slice(0, 7).map((r) => {
            const row = el("div", { class: "bd-row", tabindex: 0 },
              el("div", {}, el("div", { class: "nm" }, `${dimNames[k][r[0]]} · ${pct(r[1] / tot)}`),
                el("div", { class: "bar-wrap" }, el("div", { class: "bar-fill", style: `width:${(r[1] / max) * 100}%` }))),
              el("div", { class: "ctr" }, pct(r[2] / r[1], 2)));
            const tipFn = (e) => showTip(e, dimNames[k][r[0]], [
              { value: fmtInt(r[1]), label: `impressions (${pct(r[1] / tot, 1)})` },
              { value: fmtInt(r[2]), label: "clicks" }, { value: pct(r[2] / r[1], 2), label: "CTR" },
              { value: pct(r[3] / r[1], 1), label: "viewability" }]);
            row.addEventListener("pointermove", tipFn); row.addEventListener("pointerleave", hideTip);
            row.addEventListener("focus", (e) => { const b = row.getBoundingClientRect(); tipFn({ clientX: b.right, clientY: b.top }); });
            row.addEventListener("blur", hideTip);
            return row;
          }));
      }));

    const box = el("div", { class: "tdetail" }, recoBox, charts, bd);
    requestAnimationFrame(() => {
      lineChart(c1, { xs, values: rates, color: "var(--webmd-blue)", fmt: (v) => pct(v, 2), refs: [{ y: t.dxb, label: `Benchmark ${pct(t.dxb, 2)}` }] });
      lineChart(c2, { xs, values: t.w.freq.slice(0, j + 1), color: "var(--webmd-blue)", fmt: (v, full) => v.toFixed(full ? 2 : 1), band: { from: WEAR_OUT, to: 1e9 } });
      lineChart(c3, { xs, values: t.w.iw.slice(0, j + 1), color: "var(--webmd-blue)", fmt: (v, full) => (full ? fmtInt(v) : fmtCompact(v)), kind: "bar" });
    });
    return box;
  }

  // ---------- program detail ----------
  function programDetail(p, ps) {
    const W = state.W;
    const delivered = ps.imps, paceTarget = Math.min(1, Math.max(0, (weekDate(W) - parse(p.start)) / (parse(p.end) - parse(p.start))));
    const fact = (l, v, extra) => el("div", { class: "fact" }, el("div", { class: "f-l" }, l), el("div", { class: "f-v" }, v), extra);
    const facts = el("div", { class: "facts" },
      fact("Agency", agencies[p.agency][1]),
      fact("Marketing tactic", p.mt),
      fact("BI managed · Strategy", `${p.bi} · ${p.bs}`),
      fact("Contract budget", usd(p.budget)),
      fact("Pacing vs. contract", `${pct(delivered / p.contract)} delivered`,
        el("div", { class: "pace", title: `Expected by now: ${pct(paceTarget)}` },
          el("div", { class: "fill", style: `width:${Math.min(100, (delivered / p.contract) * 100)}%` }),
          el("div", { class: "tick", style: `left:${paceTarget * 100}%` }))),
      fact("Targeting multiple", `${ps.tm.toFixed(1)}× national avg`));

    const head = el("div", { class: "cols tac-cols" }, ...["", "Group", "Tactic · Destination / Condition / Target", "Dx/TM vs. benchmark",
      "Dx rate", "TM", "Imps", "Freq", "Uniques", "Dx uniques", "Status"].map((h, i) => el("span", { class: i >= 4 && i <= 9 ? "r" : "" }, h)));
    const list = el("div", { class: "tlist" }, ps.ts.map(({ t, s }) => tacticCard(p, t, s, ps)));
    return el("div", { class: "pdetail" }, facts,
      el("div", { class: "tbl-title" }, "Topline by Tactic", el("span", {}, `Program to date · Benchmark type: Internal-TM · ${ps.ts.length} tactics`)),
      head, list);
  }

  function tacticCard(p, t, s, ps) {
    const id = t.k;
    const card = el("div", { class: "tcard" + (state.openT.has(id) ? " open" : "") });
    const inner = el("div", { class: "inner" });
    const row = el("div", { class: "trow", role: "button", tabindex: 0, "aria-expanded": state.openT.has(id) },
      el("span", { class: "chev" }, "▶"),
      mgChip(t.mg),
      el("div", {}, el("div", { class: "t-label" }, `${t.code} | ${t.dest}`), el("div", { class: "t-sub" }, `${t.type} · CPM $${t.cpm.toFixed(2)}`)),
      divBar(s.vs),
      el("div", { class: "t-num" }, pct(s.rate, 2), el("small", {}, "bench " + pct(t.dxb, 2))),
      el("div", { class: "t-num" }, s.tm.toFixed(1), el("small", {}, "bench " + t.tmb.toFixed(1))),
      el("div", { class: "t-num" }, fmtCompact(s.imps)),
      el("div", { class: "t-num", style: s.freq > 10 ? "color:var(--warn);font-weight:700" : "" }, s.freq.toFixed(1) + (s.freq > 10 ? " ⚠" : "")),
      el("div", { class: "t-num" }, fmtCompact(s.uniq)),
      el("div", { class: "t-num" }, fmtInt(s.dx), el("small", {}, "proj " + fmtInt(s.proj))),
      el("div", {}, flagPill(s.flag)));
    const toggle = () => {
      const open = !state.openT.has(id);
      open ? state.openT.add(id) : state.openT.delete(id);
      card.classList.toggle("open", open); row.setAttribute("aria-expanded", open);
      if (open && !inner.firstChild) inner.append(tacticDetail(p, t, s, ps));
    };
    row.addEventListener("click", toggle);
    row.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); toggle(); } });
    if (state.openT.has(id)) inner.append(tacticDetail(p, t, s, ps));
    card.append(row, el("div", { class: "expand" }, inner));
    return card;
  }

  function programCard(p, ps) {
    const W = state.W, id = p.k;
    const asOf = weekDate(W), s = parse(p.start), e = parse(p.end);
    const prog = Math.max(0, Math.min(1, (asOf - s) / (e - s)));
    const live = asOf <= e;
    const ind = inds[p.ind];
    const card = el("div", { class: "pcard" + (state.open.has(id) ? " open" : "") });
    const inner = el("div", { class: "inner" });
    const dots = el("div", { class: "dots" }, ps.ts.map(({ t, s: ts }) => {
      const d = el("i", { class: `dot ${ts.flag}` }, FLAG_TXT[ts.flag][0]);
      d.addEventListener("pointermove", (ev) => showTip(ev, `${t.code} | ${t.dest}`, [{ value: signPct(ts.vs), label: "vs. benchmark" }, { value: ts.freq.toFixed(1), label: "frequency" }]));
      d.addEventListener("pointerleave", hideTip);
      return d;
    }));
    const row = el("div", { class: "prow", role: "button", tabindex: 0, "aria-expanded": state.open.has(id) },
      el("span", { class: "chev" }, "▶"),
      el("div", {}, el("div", { class: "p-title" }, el("span", { class: "sf" }, p.sf), "  ", p.label,
        el("span", { class: `status ${live ? "live" : "done"}` }, live ? "Live" : "Completed")),
        el("div", { class: "p-sub" }, `${clients[p.client][1]} · ${p.name}`)),
      el("div", { class: "cond" }, ind[1], el("small", {}, `${ind[3]} · ${ind[4]}`)),
      el("div", {}, el("div", { class: "flight" }, el("div", { class: "done", style: `width:${prog * 100}%` })),
        el("div", { class: "flight-lbl" }, `${fmtShort(s)} – ${fmtShort(e)}`)),
      el("div", { class: "num" }, fmtCompact(ps.imps)),
      el("div", { class: "num" + (ps.freq > 10 ? " warn" : "") }, ps.freq.toFixed(1)),
      el("div", { class: "num" }, fmtInt(ps.dx)),
      divBar(ps.vs),
      sparkline(p, W),
      dots);
    const toggle = () => {
      const open = !state.open.has(id);
      open ? state.open.add(id) : state.open.delete(id);
      card.classList.toggle("open", open); row.setAttribute("aria-expanded", open);
      if (open && !inner.firstChild) inner.append(programDetail(p, ps));
    };
    row.addEventListener("click", toggle);
    row.addEventListener("keydown", (ev) => { if (ev.key === "Enter" || ev.key === " ") { ev.preventDefault(); toggle(); } });
    if (state.open.has(id)) inner.append(programDetail(p, ps));
    card.append(row, el("div", { class: "expand" }, inner));
    return card;
  }

  // ---------- render ----------
  function render() {
    const W = state.W, asOf = weekDate(W);
    $("weekLabel").textContent = fmtDate(asOf);
    const q = $("q").value.trim().toLowerCase();
    const fc = $("fClient").value, fta = $("fTA").value, fmg = $("fMG").value, fs = $("fStatus").value, ff = $("fFlag").value;

    let rows = [];
    for (const p of D.programs) {
      if (fc && p.client !== +fc) continue;
      if (fta && inds[p.ind][3] !== fta) continue;
      if (fmg && !p.tactics.some((t) => t.mg === +fmg)) continue;
      const live = asOf <= parse(p.end);
      if (fs === "live" && !live) continue;
      if (fs === "done" && live) continue;
      if (q) {
        const hay = `${p.sf} ${p.label} ${p.name} ${clients[p.client][1]} ${inds[p.ind][1]} ${agencies[p.agency][1]}`.toLowerCase();
        if (!hay.includes(q)) continue;
      }
      const ps = pState(p, W);
      if (!ps) continue;
      if (ff === "red" && !ps.ts.some((x) => x.s.flag === "below")) continue;
      if (ff === "allblack" && !ps.ts.every((x) => x.s.flag === "above")) continue;
      rows.push({ p, ps });
    }
    const sorters = {
      opp: (a, b) => b.ps.opp - a.ps.opp, worst: (a, b) => a.ps.vs - b.ps.vs, best: (a, b) => b.ps.vs - a.ps.vs,
      imps: (a, b) => b.ps.imps - a.ps.imps, freq: (a, b) => b.ps.freq - a.ps.freq,
    };
    rows.sort(sorters[$("sort").value]);

    // KPIs (scoped to filtered set)
    let imps = 0, uniq = 0, dx = 0, below = 0, conf = 0, upside = 0, nT = 0;
    for (const { ps } of rows) {
      imps += ps.imps; uniq += ps.uniq; dx += ps.dx;
      for (const { t, s } of ps.ts) {
        nT++;
        if (s.flag !== "low") conf++;
        if (s.flag === "below") below++;
        if (s.flag !== "low" && s.freq > 10) upside += whatIf(t, s, WEAR_OUT).dx - s.dx;
      }
    }
    const kpi = (l, v, sub, accent) => el("div", { class: "kpi" + (accent ? " accent" : "") }, el("div", { class: "k-label" }, l), el("div", { class: "k-val" }, v), el("div", { class: "k-sub" }, sub));
    $("kpis").replaceChildren(
      kpi("Programs", fmtInt(rows.length), `${nT} tactics in view`),
      kpi("Impressions delivered", fmtCompact(imps), "program to date (DFP)"),
      kpi("Avg frequency", uniq ? (imps / uniq).toFixed(1) : "–", "imps per unique visitor"),
      kpi("Dx uniques", fmtCompact(dx), "claims-matched diagnoses"),
      kpi("Below benchmark", conf ? pct(below / conf) : "–", `${below} of ${conf} tactics with a reliable read`),
      kpi("Dx upside from freq caps", "+" + fmtCompact(upside), `if tactics above 10× were capped at ${WEAR_OUT}×`, true));

    $("count").textContent = `${rows.length} program${rows.length === 1 ? "" : "s"} · as of ${fmtDate(asOf)}`;
    const list = $("list");
    const shown = rows.slice(0, state.shown);
    list.replaceChildren(...(shown.length ? shown.map(({ p, ps }) => programCard(p, ps)) : [el("div", { class: "empty" }, "No programs match these filters.")]));
    $("more").hidden = rows.length <= state.shown;
    $("more").textContent = `Show more programs (${rows.length - state.shown} more)`;
  }

  // ---------- events ----------
  let raf = 0;
  const schedule = () => { cancelAnimationFrame(raf); raf = requestAnimationFrame(render); };
  ["q", "fClient", "fTA", "fMG", "fStatus", "fFlag", "sort"].forEach((id) =>
    $(id).addEventListener(id === "q" ? "input" : "change", () => { state.shown = PAGE; schedule(); }));
  $("week").addEventListener("input", (e) => { state.W = +e.target.value; schedule(); });
  $("more").addEventListener("click", () => { state.shown += PAGE; render(); });
  $("play").addEventListener("click", () => {
    if (state.playing) { clearInterval(state.playing); state.playing = null; $("play").textContent = "▶"; return; }
    if (state.W >= NW - 1) state.W = 0;
    $("play").textContent = "❚❚";
    state.playing = setInterval(() => {
      state.W = Math.min(NW - 1, state.W + 1); $("week").value = state.W; render();
      if (state.W >= NW - 1) { clearInterval(state.playing); state.playing = null; $("play").textContent = "▶"; }
    }, 350);
  });

  render();
})().catch((err) => console.error("[app.js] Fatal:", err));
