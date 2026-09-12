/**
 * Honest Chart — client-side only.
 * Never invents numbers: charts render exclusively from parsed CSV cells.
 */
(function () {
  "use strict";

  const $ = (id) => document.getElementById(id);

  const els = {
    csvInput: $("csvInput"),
    fileInput: $("fileInput"),
    loadSample: $("loadSample"),
    chartType: $("chartType"),
    labelCol: $("labelCol"),
    valueCol: $("valueCol"),
    chartTitle: $("chartTitle"),
    renderBtn: $("renderBtn"),
    exportPng: $("exportPng"),
    shareBtn: $("shareBtn"),
    copyShare: $("copyShare"),
    shareUrl: $("shareUrl"),
    shareBox: $("shareBox"),
    sha256: $("sha256"),
    rowCount: $("rowCount"),
    colCount: $("colCount"),
    status: $("status"),
    emptyState: $("emptyState"),
    chartCanvas: $("chartCanvas"),
  };

  let parsed = { headers: [], rows: [] };
  let lastCsvText = "";
  let chart = null;

  function setStatus(msg, kind) {
    els.status.textContent = msg || "";
    els.status.className = "status" + (kind ? " " + kind : "");
  }

  /** Minimal RFC4180-ish CSV parse. Does not invent cells. */
  function parseCsv(text) {
    const raw = String(text || "").replace(/^\uFEFF/, "");
    if (!raw.trim()) {
      return { headers: [], rows: [] };
    }

    const rows = [];
    let row = [];
    let cell = "";
    let i = 0;
    let inQuotes = false;

    while (i < raw.length) {
      const ch = raw[i];
      if (inQuotes) {
        if (ch === '"') {
          if (raw[i + 1] === '"') {
            cell += '"';
            i += 2;
            continue;
          }
          inQuotes = false;
          i += 1;
          continue;
        }
        cell += ch;
        i += 1;
        continue;
      }

      if (ch === '"') {
        inQuotes = true;
        i += 1;
        continue;
      }
      if (ch === ",") {
        row.push(cell);
        cell = "";
        i += 1;
        continue;
      }
      if (ch === "\r") {
        i += 1;
        continue;
      }
      if (ch === "\n") {
        row.push(cell);
        rows.push(row);
        row = [];
        cell = "";
        i += 1;
        continue;
      }
      cell += ch;
      i += 1;
    }

    row.push(cell);
    if (row.length > 1 || (row.length === 1 && row[0] !== "")) {
      rows.push(row);
    }

    if (!rows.length) return { headers: [], rows: [] };

    const headers = rows[0].map((h, idx) => {
      const name = String(h).trim();
      return name || `Column ${idx + 1}`;
    });

    const dataRows = rows.slice(1).filter((r) =>
      r.some((c) => String(c).trim() !== "")
    );

    return { headers, rows: dataRows };
  }

  async function sha256Hex(text) {
    const data = new TextEncoder().encode(text);
    const digest = await crypto.subtle.digest("SHA-256", data);
    return Array.from(new Uint8Array(digest))
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
  }

  function fillColumnSelects() {
    const opts = parsed.headers
      .map((h, i) => `<option value="${i}">${escapeHtml(h)}</option>`)
      .join("");
    els.labelCol.innerHTML = opts;
    els.valueCol.innerHTML = opts;

    if (parsed.headers.length >= 2) {
      els.labelCol.value = "0";
      // Prefer first numeric-looking column for values
      let valueIdx = 1;
      for (let c = 1; c < parsed.headers.length; c++) {
        if (columnLooksNumeric(c)) {
          valueIdx = c;
          break;
        }
      }
      els.valueCol.value = String(valueIdx);
    }
  }

  function columnLooksNumeric(colIdx) {
    let hits = 0;
    let seen = 0;
    for (const r of parsed.rows) {
      const v = r[colIdx];
      if (v == null || String(v).trim() === "") continue;
      seen += 1;
      if (Number.isFinite(toNumber(v))) hits += 1;
      if (seen >= 8) break;
    }
    return seen > 0 && hits / seen >= 0.7;
  }

  function toNumber(raw) {
    if (raw == null) return NaN;
    let s = String(raw).trim();
    if (!s) return NaN;
    // Strip common thousands separators / currency / percent for parsing only
    s = s.replace(/[$€£,\s]/g, "").replace(/%$/, "");
    if (!s || s === "-" || s === ".") return NaN;
    const n = Number(s);
    return n;
  }

  function escapeHtml(s) {
    return String(s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  async function updateFingerprint(text) {
    lastCsvText = text;
    const { headers, rows } = parseCsv(text);
    parsed = { headers, rows };

    const hash = text.trim()
      ? await sha256Hex(text)
      : "—";

    els.sha256.textContent = hash;
    els.rowCount.textContent = String(rows.length);
    els.colCount.textContent = String(headers.length);

    fillColumnSelects();
    const ready = rows.length > 0 && headers.length >= 2;
    els.renderBtn.disabled = !ready;
    els.exportPng.disabled = true;
    els.shareBtn.disabled = !ready;

    if (!text.trim()) {
      setStatus("Paste or upload a CSV to begin.");
    } else if (!ready) {
      setStatus("Need a header row plus at least one data row and two columns.", "error");
    } else {
      setStatus(`Parsed ${rows.length} data row(s), ${headers.length} column(s). Ready to chart.`, "ok");
    }
  }

  function buildSeries() {
    const labelIdx = Number(els.labelCol.value);
    const valueIdx = Number(els.valueCol.value);
    if (
      !Number.isInteger(labelIdx) ||
      !Number.isInteger(valueIdx) ||
      labelIdx < 0 ||
      valueIdx < 0
    ) {
      throw new Error("Pick label and value columns from the CSV headers.");
    }

    const labels = [];
    const values = [];
    const skipped = [];

    parsed.rows.forEach((row, i) => {
      const label = row[labelIdx] != null ? String(row[labelIdx]) : "";
      const num = toNumber(row[valueIdx]);
      if (!Number.isFinite(num)) {
        skipped.push(i + 2); // +2 = 1-indexed data row accounting for header
        return;
      }
      labels.push(label);
      values.push(num);
    });

    if (!values.length) {
      throw new Error(
        "No numeric values in the selected value column. Honest Chart will not invent numbers."
      );
    }

    return {
      labels,
      values,
      skipped,
      labelHeader: parsed.headers[labelIdx],
      valueHeader: parsed.headers[valueIdx],
    };
  }

  function destroyChart() {
    if (chart) {
      chart.destroy();
      chart = null;
    }
  }

  function renderChart() {
    try {
      const series = buildSeries();
      const type = els.chartType.value;
      const title =
        els.chartTitle.value.trim() ||
        `${series.valueHeader} by ${series.labelHeader}`;

      destroyChart();
      els.emptyState.classList.add("hidden");

      const palette = [
        "#3d9cf0",
        "#7c5cff",
        "#3ecf8e",
        "#f0b429",
        "#ff7b72",
        "#56d4dd",
        "#f472b6",
        "#a3e635",
      ];

      const dataset =
        type === "pie"
          ? {
              label: series.valueHeader,
              data: series.values,
              backgroundColor: series.values.map((_, i) => palette[i % palette.length]),
              borderColor: "#0f1419",
              borderWidth: 2,
            }
          : {
              label: series.valueHeader,
              data: series.values,
              backgroundColor: type === "bar" ? "rgba(61, 156, 240, 0.75)" : "rgba(61, 156, 240, 0.15)",
              borderColor: "#3d9cf0",
              borderWidth: 2,
              fill: type === "line",
              tension: 0.25,
              pointRadius: type === "line" ? 3 : 0,
            };

      chart = new Chart(els.chartCanvas.getContext("2d"), {
        type,
        data: {
          labels: series.labels,
          datasets: [dataset],
        },
        options: {
          responsive: true,
          maintainAspectRatio: true,
          plugins: {
            legend: {
              display: type === "pie",
              labels: { color: "#8b9aab" },
            },
            title: {
              display: true,
              text: title,
              color: "#e8eef4",
              font: { size: 15, weight: "600" },
            },
            tooltip: {
              callbacks: {
                label(ctx) {
                  const v = ctx.parsed.y != null ? ctx.parsed.y : ctx.parsed;
                  return `${ctx.dataset.label}: ${v}`;
                },
              },
            },
          },
          scales:
            type === "pie"
              ? {}
              : {
                  x: {
                    ticks: { color: "#8b9aab" },
                    grid: { color: "rgba(46, 58, 72, 0.7)" },
                  },
                  y: {
                    ticks: { color: "#8b9aab" },
                    grid: { color: "rgba(46, 58, 72, 0.7)" },
                  },
                },
        },
      });

      els.exportPng.disabled = false;
      els.shareBtn.disabled = false;

      let msg = `Charted ${series.values.length} point(s) from your CSV.`;
      if (series.skipped.length) {
        msg += ` Skipped ${series.skipped.length} non-numeric row(s) (CSV lines ${series.skipped.slice(0, 8).join(", ")}${series.skipped.length > 8 ? "…" : ""}).`;
      }
      setStatus(msg, "ok");
      return series;
    } catch (err) {
      setStatus(err.message || String(err), "error");
      throw err;
    }
  }

  function exportPng() {
    if (!chart) {
      setStatus("Render a chart first.", "error");
      return;
    }
    const url = chart.toBase64Image("image/png", 1);
    const a = document.createElement("a");
    a.href = url;
    a.download = "honest-chart.png";
    document.body.appendChild(a);
    a.click();
    a.remove();
    setStatus("PNG downloaded.", "ok");
  }

  function encodeShareSpec() {
    const spec = {
      v: 1,
      type: els.chartType.value,
      title: els.chartTitle.value.trim(),
      labelCol: Number(els.labelCol.value),
      valueCol: Number(els.valueCol.value),
      csv: lastCsvText,
      sha256: els.sha256.textContent,
    };
    const json = JSON.stringify(spec);
    // Prefer URL-safe base64 for hash sharing
    const b64 = btoa(unescape(encodeURIComponent(json)))
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "");
    return b64;
  }

  function decodeShareSpec(b64) {
    const padded = b64.replace(/-/g, "+").replace(/_/g, "/");
    const pad = padded.length % 4 === 0 ? "" : "=".repeat(4 - (padded.length % 4));
    const json = decodeURIComponent(escape(atob(padded + pad)));
    return JSON.parse(json);
  }

  function shareChart() {
    if (!lastCsvText.trim()) {
      setStatus("Nothing to share yet.", "error");
      return;
    }
    try {
      renderChart();
    } catch (_) {
      return;
    }
    const b64 = encodeShareSpec();
    const url = `${location.origin}${location.pathname}${location.search}#hc=${b64}`;
    // Also stash in localStorage for demo restore
    try {
      localStorage.setItem("honest-chart:last", JSON.stringify({
        at: Date.now(),
        sha256: els.sha256.textContent,
        type: els.chartType.value,
        title: els.chartTitle.value.trim(),
      }));
    } catch (_) { /* ignore quota */ }

    els.shareUrl.value = url;
    els.shareBox.classList.add("visible");
    history.replaceState(null, "", `#hc=${b64}`);
    setStatus("Share link updated in the URL hash (spec + CSV encoded). Add UTM when you post.", "ok");
  }

  async function copyShare() {
    const url = els.shareUrl.value;
    if (!url) return;
    try {
      await navigator.clipboard.writeText(url);
      setStatus("Share URL copied.", "ok");
    } catch (_) {
      els.shareUrl.select();
      setStatus("Select the URL and copy manually.", "error");
    }
  }

  async function loadSample() {
    try {
      const res = await fetch("sample.csv", { cache: "no-store" });
      if (!res.ok) throw new Error("Could not load sample.csv");
      const text = await res.text();
      els.csvInput.value = text;
      await updateFingerprint(text);
      els.chartTitle.value = "Monthly revenue";
      els.chartType.value = "bar";
      renderChart();
    } catch (err) {
      setStatus(err.message || String(err), "error");
    }
  }

  async function tryRestoreFromHash() {
    const hash = location.hash || "";
    const m = hash.match(/[#&]hc=([^&]+)/);
    if (!m) return false;
    try {
      const spec = decodeShareSpec(m[1]);
      if (!spec || typeof spec.csv !== "string") {
        throw new Error("Invalid share payload");
      }
      els.csvInput.value = spec.csv;
      await updateFingerprint(spec.csv);
      if (spec.type) els.chartType.value = spec.type;
      if (spec.title != null) els.chartTitle.value = spec.title;
      if (spec.labelCol != null) els.labelCol.value = String(spec.labelCol);
      if (spec.valueCol != null) els.valueCol.value = String(spec.valueCol);
      // Verify fingerprint if present
      if (spec.sha256 && spec.sha256 !== els.sha256.textContent) {
        setStatus("Share loaded, but SHA-256 in link does not match recomputed hash.", "error");
      }
      renderChart();
      els.shareUrl.value = location.href;
      els.shareBox.classList.add("visible");
      return true;
    } catch (err) {
      setStatus("Could not restore share from URL hash.", "error");
      return false;
    }
  }

  // Events
  let debounceTimer = null;
  els.csvInput.addEventListener("input", () => {
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => updateFingerprint(els.csvInput.value), 200);
  });

  els.fileInput.addEventListener("change", async () => {
    const file = els.fileInput.files && els.fileInput.files[0];
    if (!file) return;
    const text = await file.text();
    els.csvInput.value = text;
    await updateFingerprint(text);
  });

  els.loadSample.addEventListener("click", () => loadSample());
  els.renderBtn.addEventListener("click", () => {
    try { renderChart(); } catch (_) { /* status set */ }
  });
  els.exportPng.addEventListener("click", () => exportPng());
  els.shareBtn.addEventListener("click", () => shareChart());
  els.copyShare.addEventListener("click", () => copyShare());

  ["chartType", "labelCol", "valueCol"].forEach((id) => {
    $(id).addEventListener("change", () => {
      if (chart) {
        try { renderChart(); } catch (_) { /* status set */ }
      }
    });
  });

  // Boot
  (async function init() {
    const restored = await tryRestoreFromHash();
    if (!restored) {
      await updateFingerprint("");
      setStatus("Paste a CSV, upload a file, or load the sample.");
    }
  })();
})();
