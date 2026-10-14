/**
 * data-source.js — live data loader for the Tableau Data App
 *
 * When running inside Tableau (window.tableau.extensions exists):
 *   - Initializes the Extensions API
 *   - Finds both published data sources by name
 *   - Runs VDS queries via datasource.queryAsync()
 *   - Returns window.DATA-compatible object
 *
 * When running in a plain browser (development):
 *   - Falls back to window.DATA from the static data.js file
 */

// Target server (informational — the extension runs inside Tableau's own session)
// Credentials are in .env and used only by publish_datasources.py, never in browser code.
const TABLEAU_SERVER_URL      = "https://genapps.demo.tableau.com";
const TABLEAU_SITE_CONTENT_URL = "DataArcade";

const DS_WEEKLY   = "WebMD Campaign - Tactic Weekly";
const DS_DELIVERY = "WebMD Campaign - Delivery";

// ── field caption maps (must match the Hyper column names exactly) ───────────
const TW_FIELDS = {
  tacticWeekId:           "Tactic Week ID",
  weekEndingDate:         "Week Ending Date",
  weekNum:                "Week Number",
  isLatestWeek:           "Is Latest Week",
  sfNumber:               "SF Number",
  programName:            "Program Name",
  brandIndication:        "Brand Indication",
  clientName:             "Client Name",
  brandName:              "Brand Name",
  genericName:            "Generic Name",
  agencyName:             "Agency Name",
  indicationName:         "Indication Name",
  indicationAbbrev:       "Indication Abbrev",
  therapyArea:            "Therapy Area",
  conditionCenter:        "Condition Center",
  marketingTactic:        "Marketing Tactic",
  biManaged:              "BI Managed",
  brandSeekerStrategy:    "BrandSeeker Strategy",
  programStatus:          "Program Status",
  programFlightStart:     "Program Flight Start",
  programFlightEnd:       "Program Flight End",
  programContractImps:    "Program Contract Impressions",
  programContractBudget:  "Program Contract Budget USD",
  tacticKey:              "Tactic Key",
  mediaGroupCode:         "Media Group Code",
  mediaGroupName:         "Media Group Name",
  tacticCode:             "Tactic Code",
  destination:            "Destination Condition Target",
  tacticType:             "Tactic Type",
  bookedCpm:              "Booked CPM USD",
  tacticStart:            "Tactic Start Date",
  tacticEnd:              "Tactic End Date",
  tacticContractImps:     "Tactic Contract Impressions",
  impressionsWeek:        "Impressions Week",
  clicksWeek:             "Clicks Week",
  revenueWeek:            "Gross Revenue Week USD",
  uniquesWeek:            "Uniques Exposed Week",
  freqWeek:               "Frequency Week",
  impressionsPtd:         "Impressions PTD",
  clicksPtd:              "Clicks PTD",
  uniquesPtd:             "Uniques Exposed PTD",
  freqPtd:                "Frequency PTD",
  claimsMatchedPtd:       "Claims Matched Uniques PTD",
  dxUniquesPtd:           "Dx Uniques PTD",
  projectedDxPtd:         "Projected Total Dx Uniques PTD",
  dxRatePtd:              "Dx Rate PTD",
  dxBenchmark:            "Dx Benchmark",
  nationalDxAvg:          "National Dx Avg",
  targetingMultiplePtd:   "Targeting Multiple PTD",
  tmBenchmark:            "TM Benchmark",
  dxVsBenchmarkPct:       "Dx vs Benchmark Pct",
  matchRate:              "Match Rate",
  confidenceLevel:        "Confidence Level",
  performanceFlag:        "Performance Flag",
};

const DL_FIELDS = {
  deliveryId:             "Delivery ID",
  deliveryDate:           "Delivery Date",
  sfNumber:               "SF Number",
  brandIndication:        "Brand Indication",
  clientName:             "Client Name",
  indicationName:         "Indication Name",
  therapyArea:            "Therapy Area",
  mediaGroupCode:         "Media Group Code",
  mediaGroupName:         "Media Group Name",
  tacticCode:             "Tactic Code",
  destination:            "Destination Condition Target",
  adSizeName:             "Ad Size Name",
  deviceName:             "Device Name",
  trafficSourceName:      "Traffic Source Name",
  audienceSegmentName:    "Audience Segment Name",
  siteSectionName:        "Site Section Name",
  impressions:            "Impressions Delivered",
  viewableImpressions:    "Viewable Impressions",
  clicks:                 "Clicks",
  videoStarts:            "Video Starts",
  videoCompletes:         "Video Completes",
  engagements:            "Sponsored Content Engagements",
  revenueUsd:             "Gross Revenue USD",
};

// ── helpers ──────────────────────────────────────────────────────────────────

function showStatus(msg, isError = false) {
  let el = document.getElementById("_ds_status");
  if (!el) {
    el = document.createElement("div");
    el.id = "_ds_status";
    el.style.cssText = [
      "position:fixed", "top:0", "left:0", "right:0", "z-index:9999",
      "padding:16px 24px", "font:600 14px/1.4 system-ui,sans-serif",
      "text-align:center",
    ].join(";");
    document.body.prepend(el);
  }
  el.style.background = isError ? "#c0392b" : "#0b2d5b";
  el.style.color = "#fff";
  el.textContent = msg;
  el.hidden = false;
}

function hideStatus() {
  const el = document.getElementById("_ds_status");
  if (el) el.hidden = true;
}

// Build a caption→fieldId lookup from readMetadataAsync result
function buildCaptionMap(fields) {
  const m = {};
  for (const f of fields) {
    if (f.fieldCaption) m[f.fieldCaption] = f.id || f.fieldCaption;
  }
  return m;
}

function requireFields(captionMap, captions, dsName) {
  const missing = captions.filter((c) => !(c in captionMap));
  if (missing.length) {
    throw new Error(
      `Data source "${dsName}" is missing expected fields:\n  ${missing.join("\n  ")}\n\nCheck that the published data source matches the expected schema.`
    );
  }
}

// Convert an ISO date string or Date-like to yyyymmdd integer key
function toWeekKey(val) {
  if (!val) return null;
  const s = String(val).slice(0, 10).replace(/-/g, "");
  return parseInt(s, 10);
}

// ── main loader ──────────────────────────────────────────────────────────────

async function loadData() {
  // Local fallback: plain browser without Tableau Extensions
  if (!window.tableau || !window.tableau.extensions) {
    if (window.DATA) return window.DATA;
    throw new Error("No Tableau Extensions API and no window.DATA fallback found.");
  }

  showStatus("Loading live data from Tableau…");

  try {
    await tableau.extensions.initializeAsync();

    // Find both data sources
    const allDs = await tableau.extensions.workbook.getAllDataSourcesAsync();
    const dsMap = {};
    for (const ds of allDs) dsMap[ds.name] = ds;

    const missingDs = [DS_WEEKLY, DS_DELIVERY].filter((n) => !(n in dsMap));
    if (missingDs.length) {
      throw new Error(
        `Required data source(s) not found in this workbook:\n  ${missingDs.join("\n  ")}\n\nMake sure both are connected in the workbook.`
      );
    }

    const twDs = dsMap[DS_WEEKLY];
    const dlDs = dsMap[DS_DELIVERY];

    // ── read metadata ────────────────────────────────────────────────────────
    showStatus("Reading schema…");
    const [twMeta, dlMeta] = await Promise.all([
      twDs.readMetadataAsync(),
      dlDs.readMetadataAsync(),
    ]);

    const twCap = buildCaptionMap(twMeta.fields);
    const dlCap = buildCaptionMap(dlMeta.fields);

    requireFields(twCap, Object.values(TW_FIELDS), DS_WEEKLY);
    requireFields(dlCap, Object.values(DL_FIELDS), DS_DELIVERY);

    // ── query Tactic Weekly ──────────────────────────────────────────────────
    showStatus("Querying tactic weekly data…");

    const twRows = await twDs.queryAsync({
      columns: Object.values(TW_FIELDS).map((caption) => ({ fieldCaption: caption })),
    });

    // ── query Delivery breakdowns (aggregated by tactic × dim) ──────────────
    showStatus("Querying delivery breakdowns…");

    const BR_DIMS = [
      { key: "size", caption: DL_FIELDS.adSizeName,          nameCaption: DL_FIELDS.adSizeName },
      { key: "dev",  caption: DL_FIELDS.deviceName,          nameCaption: DL_FIELDS.deviceName },
      { key: "ts",   caption: DL_FIELDS.trafficSourceName,   nameCaption: DL_FIELDS.trafficSourceName },
      { key: "seg",  caption: DL_FIELDS.audienceSegmentName, nameCaption: DL_FIELDS.audienceSegmentName },
      { key: "sec",  caption: DL_FIELDS.siteSectionName,     nameCaption: DL_FIELDS.siteSectionName },
    ];

    // Also grab gross revenue per tactic for the "rev" field
    const revQuery = dlDs.queryAsync({
      columns: [
        { fieldCaption: DL_FIELDS.tacticCode },
        { fieldCaption: DL_FIELDS.sfNumber },
        { fieldCaption: DL_FIELDS.impressions,       function: "SUM", fieldAlias: "imps" },
        { fieldCaption: DL_FIELDS.clicks,            function: "SUM", fieldAlias: "clk" },
        { fieldCaption: DL_FIELDS.revenueUsd,        function: "SUM", fieldAlias: "rev" },
        { fieldCaption: DL_FIELDS.viewableImpressions, function: "SUM", fieldAlias: "vimp" },
      ],
    });

    const brQueries = BR_DIMS.map(({ caption }) =>
      dlDs.queryAsync({
        columns: [
          { fieldCaption: DL_FIELDS.tacticCode },
          { fieldCaption: DL_FIELDS.sfNumber },
          { fieldCaption: caption },
          { fieldCaption: DL_FIELDS.impressions,        function: "SUM", fieldAlias: "imps" },
          { fieldCaption: DL_FIELDS.clicks,             function: "SUM", fieldAlias: "clk" },
          { fieldCaption: DL_FIELDS.viewableImpressions,function: "SUM", fieldAlias: "vimp" },
        ],
      })
    );

    const [revResult, ...brResults] = await Promise.all([revQuery, ...brQueries]);

    // ── reshape tactic weekly rows ───────────────────────────────────────────
    showStatus("Reshaping data…");

    // Index field positions by caption
    function colIdx(headers, caption) {
      const i = headers.findIndex((h) => h.fieldCaption === caption || h.fieldAlias === caption);
      if (i < 0) throw new Error(`Column not found in query result: ${caption}`);
      return i;
    }

    // Helper: get value from a row by header name
    function val(row, headers, caption) {
      return row[colIdx(headers, caption)];
    }

    const twHeaders = twRows.columns;
    const rows = twRows.data;

    // Build week list: sorted unique week_ending_key (yyyymmdd integer)
    const weekSet = new Set();
    for (const r of rows) {
      const wk = toWeekKey(val(r, twHeaders, TW_FIELDS.weekEndingDate));
      if (wk) weekSet.add(wk);
    }
    const weeks = Array.from(weekSet).sort((a, b) => a - b);
    const widx = new Map(weeks.map((w, i) => [w, i]));

    // Group tactic weekly rows by tacticCode+sfNumber composite (matches prep_app_data.py key = tactic_key)
    // We'll build a synthetic tactic_key from (sfNumber, tacticCode) since VDS returns strings.
    // We also need integer keys for programs and tactics that match app.js expectations.
    // Strategy: assign stable integer keys in sorted order.
    const tacticRowsMap = new Map(); // "SF|code" → array of tactic-week rows
    for (const r of rows) {
      const sf   = String(val(r, twHeaders, TW_FIELDS.sfNumber) ?? "");
      const code = String(val(r, twHeaders, TW_FIELDS.tacticCode) ?? "");
      const key  = sf + "|" + code;
      if (!tacticRowsMap.has(key)) tacticRowsMap.set(key, []);
      tacticRowsMap.get(key).push(r);
    }

    // Build program map: sf_number → program data
    const progMap = new Map(); // sf → { first tactic-week row for program fields }
    for (const r of rows) {
      const sf = String(val(r, twHeaders, TW_FIELDS.sfNumber) ?? "");
      if (!progMap.has(sf)) progMap.set(sf, r);
    }

    // Assign stable integer keys
    const sfList    = Array.from(progMap.keys()).sort();
    const tacKeyList = Array.from(tacticRowsMap.keys()).sort();
    const sfToKey   = new Map(sfList.map((sf, i) => [sf, i + 1]));
    const tacToKey  = new Map(tacKeyList.map((k, i) => [k, i + 1]));

    // Derive unique dimension values for lookup tables
    const clientSet = new Map(); // name → key
    const brandSet  = new Map();
    const agencySet = new Map();
    const indSet    = new Map(); // name → [key, name, abbrev, ta, cc]
    const mgSet     = new Map(); // code → [key, code, name]

    let clientSeq = 1, brandSeq = 1, agencySeq = 1, indSeq = 1, mgSeq = 1;

    for (const r of rows) {
      const cname = String(val(r, twHeaders, TW_FIELDS.clientName) ?? "");
      if (cname && !clientSet.has(cname)) clientSet.set(cname, clientSeq++);

      const bname = String(val(r, twHeaders, TW_FIELDS.brandName) ?? "");
      if (bname && !brandSet.has(bname))  brandSet.set(bname, brandSeq++);

      const aname = String(val(r, twHeaders, TW_FIELDS.agencyName) ?? "");
      if (aname && !agencySet.has(aname)) agencySet.set(aname, agencySeq++);

      const iname = String(val(r, twHeaders, TW_FIELDS.indicationName) ?? "");
      if (iname && !indSet.has(iname)) {
        indSet.set(iname, [
          indSeq++,
          iname,
          String(val(r, twHeaders, TW_FIELDS.indicationAbbrev) ?? ""),
          String(val(r, twHeaders, TW_FIELDS.therapyArea) ?? ""),
          String(val(r, twHeaders, TW_FIELDS.conditionCenter) ?? ""),
        ]);
      }

      const mgCode = String(val(r, twHeaders, TW_FIELDS.mediaGroupCode) ?? "");
      if (mgCode && !mgSet.has(mgCode)) {
        mgSet.set(mgCode, [
          mgSeq++,
          mgCode,
          String(val(r, twHeaders, TW_FIELDS.mediaGroupName) ?? ""),
        ]);
      }
    }

    // Lookup helpers
    const indByName = (n) => indSet.get(n) || [0, n, "", "", ""];
    const mgByCode  = (c) => mgSet.get(c)  || [0, c, ""];

    // Build programs array
    const programs = [];
    for (const sf of sfList) {
      const r = progMap.get(sf);
      const cname = String(val(r, twHeaders, TW_FIELDS.clientName) ?? "");
      const bname = String(val(r, twHeaders, TW_FIELDS.brandName) ?? "");
      const aname = String(val(r, twHeaders, TW_FIELDS.agencyName) ?? "");
      const iname = String(val(r, twHeaders, TW_FIELDS.indicationName) ?? "");
      const mgCode = String(val(r, twHeaders, TW_FIELDS.mediaGroupCode) ?? "");
      programs.push({
        k:        sfToKey.get(sf),
        sf:       sf,
        label:    String(val(r, twHeaders, TW_FIELDS.brandIndication) ?? ""),
        name:     String(val(r, twHeaders, TW_FIELDS.programName) ?? ""),
        client:   clientSet.get(cname) || 0,
        brand:    brandSet.get(bname)  || 0,
        ind:      indByName(iname)[0],
        agency:   agencySet.get(aname) || 0,
        mt:       String(val(r, twHeaders, TW_FIELDS.marketingTactic) ?? ""),
        bi:       String(val(r, twHeaders, TW_FIELDS.biManaged) ?? ""),
        bs:       String(val(r, twHeaders, TW_FIELDS.brandSeekerStrategy) ?? ""),
        status:   String(val(r, twHeaders, TW_FIELDS.programStatus) ?? ""),
        start:    String(val(r, twHeaders, TW_FIELDS.programFlightStart) ?? "").slice(0, 10),
        end:      String(val(r, twHeaders, TW_FIELDS.programFlightEnd) ?? "").slice(0, 10),
        contract: Number(val(r, twHeaders, TW_FIELDS.programContractImps) ?? 0),
        budget:   Number(val(r, twHeaders, TW_FIELDS.programContractBudget) ?? 0),
      });
    }

    // Build delivery revenue & breakdown maps keyed by "SF|tacticCode"
    const revHeaders = revResult.columns;
    const revMap = new Map(); // "SF|code" → rev
    for (const r of revResult.data) {
      const sf   = String(r[colIdx(revHeaders, DL_FIELDS.sfNumber)] ?? "");
      const code = String(r[colIdx(revHeaders, DL_FIELDS.tacticCode)] ?? "");
      const rev  = Number(r[colIdx(revHeaders, "rev")] ?? 0);
      revMap.set(sf + "|" + code, rev);
    }

    // Breakdown dim-value assignment: name → stable integer key per dim
    const dimMaps = BR_DIMS.map(() => new Map()); // index → name→key
    const dimSeqs = BR_DIMS.map(() => ({ seq: 1 }));

    const brMaps = new Map(); // "SF|code" → { size: [[dimKey,imps,clk,vimp],...], dev: …, … }
    for (let di = 0; di < BR_DIMS.length; di++) {
      const { key: brKey, caption } = BR_DIMS[di];
      const res     = brResults[di];
      const headers = res.columns;
      for (const r of res.data) {
        const sf     = String(r[colIdx(headers, DL_FIELDS.sfNumber)] ?? "");
        const code   = String(r[colIdx(headers, DL_FIELDS.tacticCode)] ?? "");
        const dname  = String(r[colIdx(headers, caption)] ?? "");
        const imps   = Number(r[colIdx(headers, "imps")] ?? 0);
        const clk    = Number(r[colIdx(headers, "clk")] ?? 0);
        const vimp   = Number(r[colIdx(headers, "vimp")] ?? 0);
        const mapKey = sf + "|" + code;

        if (!dimMaps[di].has(dname)) dimMaps[di].set(dname, dimSeqs[di].seq++);
        const dimKey = dimMaps[di].get(dname);

        if (!brMaps.has(mapKey)) brMaps.set(mapKey, {});
        const entry = brMaps.get(mapKey);
        if (!entry[brKey]) entry[brKey] = [];
        entry[brKey].push([dimKey, imps, clk, vimp]);
      }
    }

    // Build dims lookup (key→name pairs for each breakdown dim)
    const dims = {};
    for (let di = 0; di < BR_DIMS.length; di++) {
      const { key: brKey } = BR_DIMS[di];
      dims[brKey] = Array.from(dimMaps[di].entries()).map(([name, key]) => [key, name]);
    }

    // Build tactics array
    const tactics = [];
    for (const compositeKey of tacKeyList) {
      const tacRows = tacticRowsMap.get(compositeKey).slice().sort((a, b) => {
        const wa = toWeekKey(val(a, twHeaders, TW_FIELDS.weekEndingDate));
        const wb = toWeekKey(val(b, twHeaders, TW_FIELDS.weekEndingDate));
        return wa - wb;
      });

      const firstRow = tacRows[0];
      const lastRow  = tacRows[tacRows.length - 1];

      const sf      = String(val(firstRow, twHeaders, TW_FIELDS.sfNumber) ?? "");
      const code    = String(val(firstRow, twHeaders, TW_FIELDS.tacticCode) ?? "");
      const mgCode  = String(val(firstRow, twHeaders, TW_FIELDS.mediaGroupCode) ?? "");
      const mgEntry = mgByCode(mgCode);

      const wI     = [];
      const wIW    = [];
      const wImps  = [];
      const wUniq  = [];
      const wFreq  = [];
      const wClaims = [];
      const wDx    = [];
      const wProj  = [];
      const wClk   = [];
      const wConf  = [];

      for (const r of tacRows) {
        const wk = toWeekKey(val(r, twHeaders, TW_FIELDS.weekEndingDate));
        const wi = widx.get(wk);
        if (wi === undefined) continue;
        wI.push(wi);
        wIW.push(Number(val(r, twHeaders, TW_FIELDS.impressionsWeek) ?? 0));
        wImps.push(Number(val(r, twHeaders, TW_FIELDS.impressionsPtd) ?? 0));
        wUniq.push(Number(val(r, twHeaders, TW_FIELDS.uniquesPtd) ?? 0));
        wFreq.push(Math.round(Number(val(r, twHeaders, TW_FIELDS.freqPtd) ?? 0) * 100) / 100);
        wClaims.push(Number(val(r, twHeaders, TW_FIELDS.claimsMatchedPtd) ?? 0));
        wDx.push(Number(val(r, twHeaders, TW_FIELDS.dxUniquesPtd) ?? 0));
        wProj.push(Number(val(r, twHeaders, TW_FIELDS.projectedDxPtd) ?? 0));
        wClk.push(Number(val(r, twHeaders, TW_FIELDS.clicksPtd) ?? 0));
        const conf = String(val(r, twHeaders, TW_FIELDS.confidenceLevel) ?? "L");
        wConf.push(conf[0] || "L");
      }

      tactics.push({
        k:        tacToKey.get(compositeKey),
        p:        sfToKey.get(sf) || 0,
        mg:       mgEntry[0],
        code:     code,
        dest:     String(val(lastRow, twHeaders, TW_FIELDS.destination) ?? ""),
        type:     String(val(lastRow, twHeaders, TW_FIELDS.tacticType) ?? ""),
        cpm:      Number(val(lastRow, twHeaders, TW_FIELDS.bookedCpm) ?? 0),
        start:    String(val(firstRow, twHeaders, TW_FIELDS.tacticStart) ?? "").slice(0, 10),
        end:      String(val(lastRow,  twHeaders, TW_FIELDS.tacticEnd) ?? "").slice(0, 10),
        contract: Number(val(lastRow,  twHeaders, TW_FIELDS.tacticContractImps) ?? 0),
        rev:      Math.round((revMap.get(compositeKey) || 0) * 100) / 100,
        nat:      Number(val(lastRow, twHeaders, TW_FIELDS.nationalDxAvg) ?? 0),
        dxb:      Number(val(lastRow, twHeaders, TW_FIELDS.dxBenchmark) ?? 0),
        tmb:      Number(val(lastRow, twHeaders, TW_FIELDS.tmBenchmark) ?? 0),
        w: { i: wI, iw: wIW, imps: wImps, uniq: wUniq, freq: wFreq,
             claims: wClaims, dx: wDx, proj: wProj, clk: wClk, conf: wConf },
        br: brMaps.get(compositeKey) || {},
      });
    }

    // Find latest week date (updated string)
    const latestWeekKey = weeks[weeks.length - 1];
    const lw = String(latestWeekKey);
    const updated = `${lw.slice(0, 4)}-${lw.slice(4, 6)}-${lw.slice(6, 8)}`;

    hideStatus();

    return {
      updated,
      weeks: weeks.map(String),
      clients:    Array.from(clientSet.entries()).map(([name, key]) => [key, name]),
      brands:     Array.from(brandSet.entries()).map(([name, key]) => [key, name, ""]),
      agencies:   Array.from(agencySet.entries()).map(([name, key]) => [key, name]),
      indications: Array.from(indSet.values()),
      mediaGroups: Array.from(mgSet.values()),
      dims,
      programs,
      tactics,
    };

  } catch (err) {
    showStatus("Error loading data: " + err.message, true);
    console.error("[data-source.js]", err);
    throw err;
  }
}
