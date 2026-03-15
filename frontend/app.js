const BACKEND = "";

// Wait for d3 to be available
if (typeof d3 === 'undefined') {
  const checkD3 = setInterval(() => {
    if (typeof d3 !== 'undefined') {
      clearInterval(checkD3);
      initApp();
    }
  }, 50);
} else {
  initApp();
}

function initApp() {
// ── State ──────────────────────────────────────────────────────────────────
const nodes = [];
const links = [];
const nodeIndex = new Map();
const domainVisits = new Map();
const nodeHop = new Map(); // url → hop number

let simulation, linkGroup, nodeGroup, currentSSE;
let dragMoved = false;
let hopCounter = 0;
let currentNodeUrl = null;
let showTitles = false;
let crawlStopped = false;
let isArxivMode = false;
let svgZoom, svgG;

// ── Domain colors ──────────────────────────────────────────────────────────
const domainColorScale = d3.scaleOrdinal(d3.schemeTableau10);

function domainOf(url) {
  try { return new URL(url).hostname.replace(/^www\./, ""); }
  catch { return url; }
}

function domainColor(url) {
  return domainColorScale(domainOf(url));
}

// ── DOM refs ───────────────────────────────────────────────────────────────
const landing        = document.getElementById("landing");
const graphView      = document.getElementById("graph-view");
const form           = document.getElementById("search-form");
const urlInput       = document.getElementById("url-input");
const hopsInput      = document.getElementById("hops-input");
const domainCapInput = document.getElementById("domain-cap-input");
const titlesToggle   = document.getElementById("titles-toggle");
const randomBtn      = document.getElementById("random-btn");
const topUrl         = document.getElementById("top-url");
const topStatus      = document.getElementById("top-status");
const resetBtn       = document.getElementById("reset-btn");
const stopBtn        = document.getElementById("stop-btn");
const fitBtn         = document.getElementById("fit-btn");
const exportBtn      = document.getElementById("export-btn");
const graphSvg       = document.getElementById("graph");
const urlListInner   = document.getElementById("url-list-inner");
const statsPanel     = document.getElementById("stats-panel");
const detailPanel    = document.getElementById("detail-panel");
const detailTitleEl  = document.getElementById("detail-title-text");
const detailUrlEl    = document.getElementById("detail-url-text");
const detailMetaEl   = document.getElementById("detail-meta");
const detailOpenLink = document.getElementById("detail-open-link");
const detailCloseBtn = document.getElementById("detail-close-btn");
const arxivForm       = document.getElementById("arxiv-form");
const arxivInput      = document.getElementById("arxiv-input");
const depthInput      = document.getElementById("depth-input");
const refsInput       = document.getElementById("refs-input");

// ── Helpers ────────────────────────────────────────────────────────────────
function urlLabel(url) {
  try {
    const u = new URL(url);
    const host = u.hostname.replace(/^www\./, "");
    const path = u.pathname === "/" ? "" : u.pathname;
    return host + path;
  } catch {
    return url.slice(0, 60);
  }
}

function truncate(str, max) {
  return str.length > max ? str.slice(0, max) + "…" : str;
}

function nodeLabel(node) {
  if (isArxivMode && node.title) return truncate(node.title, 50);
  return (showTitles && node.title) ? node.title : urlLabel(node.id);
}

function listLabel(node) {
  if (isArxivMode && node.title) return node.title;
  return urlLabel(node.id);
}

function getOrCreateNode(url, isStart = false) {
  if (nodeIndex.has(url)) return nodeIndex.get(url);
  const node = { id: url, title: null, isStart };
  nodes.push(node);
  nodeIndex.set(url, node);
  return node;
}

function trackDomain(url) {
  try {
    const host = new URL(url).hostname.replace(/^www\./, "");
    domainVisits.set(host, (domainVisits.get(host) || 0) + 1);
  } catch {}
}

// ── Detail panel ───────────────────────────────────────────────────────────
function showDetail(node) {
  detailTitleEl.textContent = node.title || urlLabel(node.id);
  const urlText = node.id.length > 70 ? node.id.slice(0, 70) + "…" : node.id;
  detailUrlEl.textContent = urlText;
  const hop = nodeHop.get(node.id);
  const domain = domainOf(node.id);
  const hopLabel = isArxivMode ? "depth" : "hop";
  detailMetaEl.textContent = `${domain}${hop != null ? ` · ${hopLabel} ${hop}` : ""}`;
  detailOpenLink.href = node.id;
  detailPanel.classList.remove("hidden");
}

function hideDetail() {
  detailPanel.classList.add("hidden");
}

detailCloseBtn.addEventListener("click", hideDetail);

// ── URL list ───────────────────────────────────────────────────────────────
const listEntries = new Map(); // url → { entry, anchor }

function addListEntry(url, index, isBacktrack) {
  const entry = document.createElement("div");
  entry.className = "url-entry" + (isBacktrack ? " backtrack" : "");

  const idx = document.createElement("span");
  idx.className = "idx";
  idx.textContent = String(index).padStart(3, "0");

  const node = nodeIndex.get(url);
  const a = document.createElement("a");
  a.href = url;
  a.target = "_blank";
  a.rel = "noopener";
  a.textContent = node ? listLabel(node) : urlLabel(url);

  // Cross-highlight: hover list → highlight graph node
  entry.addEventListener("mouseenter", () => {
    nodeGroup?.selectAll(".node").classed("highlighted", (d) => d.id === url);
  });
  entry.addEventListener("mouseleave", () => {
    nodeGroup?.selectAll(".node").classed("highlighted", false);
  });

  entry.appendChild(idx);
  entry.appendChild(a);
  urlListInner.appendChild(entry);
  entry.scrollIntoView({ block: "nearest" });

  listEntries.set(url, { entry, anchor: a });
}

function updateListEntry(url) {
  const le = listEntries.get(url);
  const node = nodeIndex.get(url);
  if (le && node) {
    le.anchor.textContent = listLabel(node);
  }
}

// ── D3 graph ───────────────────────────────────────────────────────────────
function initGraph() {
  const width  = graphSvg.clientWidth;
  const height = graphSvg.clientHeight;

  const svgEl = d3.select(graphSvg).attr("width", width).attr("height", height);
  svgEl.selectAll("*").remove();

  // Arrow marker for forward links
  svgEl.append("defs").append("marker")
    .attr("id", "arrow")
    .attr("viewBox", "0 -4 8 8")
    .attr("refX", 8)
    .attr("refY", 0)
    .attr("markerWidth", 5)
    .attr("markerHeight", 5)
    .attr("orient", "auto")
    .append("path")
    .attr("d", "M0,-4L8,0L0,4Z")
    .attr("fill", "var(--node)")
    .attr("opacity", "0.55");

  const g = svgEl.append("g");
  svgG = g;

  svgZoom = d3.zoom()
    .scaleExtent([0.02, 10])
    .on("zoom", (e) => g.attr("transform", e.transform));

  svgEl.call(svgZoom);

  linkGroup = g.append("g").attr("class", "links");
  nodeGroup = g.append("g").attr("class", "nodes");

  const linkDist   = isArxivMode ? 400 : 220;
  const charge     = isArxivMode ? -1500 : -500;
  const collideR   = isArxivMode ? 160 : 80;

  simulation = d3.forceSimulation(nodes)
    .force("link",      d3.forceLink(links).id((d) => d.id).distance(linkDist).strength(0.35))
    .force("charge",    d3.forceManyBody().strength(charge))
    .force("center",    d3.forceCenter(width / 2, height / 2))
    .force("collision", d3.forceCollide(collideR))
    .on("tick", ticked);
}

function ticked() {
  linkGroup.selectAll(".link").each(function(d) {
    const dx = d.target.x - d.source.x;
    const dy = d.target.y - d.source.y;
    const dist = Math.sqrt(dx * dx + dy * dy) || 1;
    const srcR = 9;
    const tgtR = d.backtrack ? 9 : 13; // extra room for arrowhead
    d3.select(this)
      .attr("x1", d.source.x + (dx / dist) * srcR)
      .attr("y1", d.source.y + (dy / dist) * srcR)
      .attr("x2", d.target.x - (dx / dist) * tgtR)
      .attr("y2", d.target.y - (dy / dist) * tgtR);
  });

  nodeGroup.selectAll(".node")
    .attr("transform", (d) => `translate(${d.x},${d.y})`);
}

function setCurrentNode(url) {
  currentNodeUrl = url;
  nodeGroup?.selectAll(".node circle")
    .classed("current", (d) => d.id === url);
}

function updateNodeLabel(url) {
  const node = nodeIndex.get(url);
  if (!node) return;
  nodeGroup?.selectAll(".node")
    .filter((d) => d.id === url)
    .select("text")
    .text(nodeLabel(node));
}

function addEdge(fromUrl, toUrl, backtrack = false) {
  const source = getOrCreateNode(fromUrl);
  const target = getOrCreateNode(toUrl);

  links.push({ source, target, backtrack });

  linkGroup.selectAll(".link")
    .data(links)
    .join("line")
    .attr("class", (d) => `link${d.backtrack ? " backtrack" : ""}`)
    .attr("marker-end", (d) => d.backtrack ? null : "url(#arrow)");

  nodeGroup.selectAll(".node")
    .data(nodes, (d) => d.id)
    .join((enter) => {
      const g = enter.append("g").attr("class", "node");
      g.append("circle")
        .attr("class", (d) => d.isStart ? "start" : "")
        .style("stroke", (d) => d.isStart ? null : domainColor(d.id));
      g.append("text").attr("x", 10).text((d) => nodeLabel(d));
      g.append("title").text((d) => d.id);

      g.on("click", (_, d) => {
        if (dragMoved) return;
        showDetail(d);
      });

      g.on("mouseenter", (_, d) => {
        const le = listEntries.get(d.id);
        if (le) le.entry.classList.add("highlighted");
      });
      g.on("mouseleave", (_, d) => {
        const le = listEntries.get(d.id);
        if (le) le.entry.classList.remove("highlighted");
      });

      g.call(
        d3.drag()
          .on("start", (e, d) => {
            dragMoved = false;
            if (!e.active) simulation.alphaTarget(0.3).restart();
            d.fx = d.x; d.fy = d.y;
          })
          .on("drag", (e, d) => { dragMoved = true; d.fx = e.x; d.fy = e.y; })
          .on("end",  (e, d) => {
            if (!e.active) simulation.alphaTarget(0);
            d.fx = null; d.fy = null;
          })
      );
      return g;
    });

  nodeGroup.selectAll(".node circle").classed("current", (d) => d.id === currentNodeUrl);

  simulation.nodes(nodes);
  simulation.force("link").links(links);
  simulation.alpha(0.3).restart();
}

// ── Fit to view ───────────────────────────────────────────────────────────
function fitToView() {
  if (!nodes.length || !svgZoom || !svgG) return;
  const width  = graphSvg.clientWidth;
  const height = graphSvg.clientHeight;
  const padding = 60;

  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const n of nodes) {
    if (n.x == null || n.y == null) continue;
    if (n.x < x0) x0 = n.x;
    if (n.y < y0) y0 = n.y;
    if (n.x > x1) x1 = n.x;
    if (n.y > y1) y1 = n.y;
  }

  if (!isFinite(x0)) return;

  const bw = (x1 - x0) || 1;
  const bh = (y1 - y0) || 1;
  const scale = Math.min((width - padding * 2) / bw, (height - padding * 2) / bh, 2);
  const cx = (x0 + x1) / 2;
  const cy = (y0 + y1) / 2;

  const transform = d3.zoomIdentity
    .translate(width / 2, height / 2)
    .scale(scale)
    .translate(-cx, -cy);

  d3.select(graphSvg)
    .transition()
    .duration(500)
    .call(svgZoom.transform, transform);
}

// ── Stats ──────────────────────────────────────────────────────────────────
function showStats(totalHops) {
  const top5 = [...domainVisits.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5);

  statsPanel.innerHTML = "";

  const header = document.createElement("div");
  header.className = "stats-header";
  header.textContent = `${totalHops} hops · top domains`;
  statsPanel.appendChild(header);

  for (const [domain, count] of top5) {
    const row = document.createElement("div");
    row.className = "stats-row";
    const c = document.createElement("span");
    c.className = "stats-count";
    c.textContent = `${count}×`;
    const d = document.createElement("span");
    d.className = "stats-domain";
    d.textContent = domain;
    row.appendChild(c);
    row.appendChild(d);
    statsPanel.appendChild(row);
  }

  statsPanel.classList.remove("hidden");
}

// ── Export CSV ─────────────────────────────────────────────────────────────
function exportCSV() {
  const rows = ["index,url,title,domain,hop"];
  let i = 1;
  for (const [url, node] of nodeIndex) {
    const title = (node.title || "").replace(/"/g, '""');
    const domain = domainOf(url);
    const hop = nodeHop.get(url) ?? "";
    rows.push(`${i++},"${url}","${title}","${domain}",${hop}`);
  }
  const blob = new Blob([rows.join("\n")], { type: "text/csv" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = "webtree.csv";
  a.click();
  URL.revokeObjectURL(a.href);
}

// ── Crawl ──────────────────────────────────────────────────────────────────
function stopCrawl() {
  if (currentSSE) { currentSSE.close(); currentSSE = null; }
  crawlStopped = true;
  topStatus.textContent = topStatus.textContent.replace("crawling…", "stopped");
  stopBtn.disabled = true;
}

function startCrawl(url, hops, domainCap) {
  nodes.length = 0;
  links.length = 0;
  nodeIndex.clear();
  domainVisits.clear();
  nodeHop.clear();
  listEntries.clear();
  urlListInner.innerHTML = "";
  hopCounter = 0;
  currentNodeUrl = null;
  crawlStopped = false;
  isArxivMode = false;
  showTitles = titlesToggle.checked;

  hideDetail();
  stopBtn.disabled = false;

  landing.classList.add("fade-out");
  graphView.classList.remove("hidden");
  statsPanel.classList.add("hidden");
  initGraph();
  setTimeout(() => {
    landing.style.display = "none";
  }, 400);

  topUrl.textContent = url;
  topStatus.textContent = "crawling…";

  getOrCreateNode(url, true);
  nodeHop.set(url, 0);

  if (currentSSE) currentSSE.close();

  const endpoint = `${BACKEND}/crawl?url=${encodeURIComponent(url)}&hops=${hops}&maxPerDomain=${domainCap}`;
  const sse = new EventSource(endpoint);
  currentSSE = sse;

  let hopCount = 0;

  sse.onmessage = (e) => {
    const event = JSON.parse(e.data);

    switch (event.type) {
      case "visit":
        hopCount++;
        hopCounter++;
        topStatus.textContent = `hop ${hopCount} / ${hops}`;
        addEdge(event.from, event.to, false);
        addListEntry(event.to, hopCounter, false);
        trackDomain(event.to);
        if (!nodeHop.has(event.to)) nodeHop.set(event.to, hopCount);
        setCurrentNode(event.to);
        break;

      case "backtrack":
        hopCounter++;
        topStatus.textContent = `↩ backtrack — hop ${hopCount} / ${hops}`;
        addEdge(event.from, event.to, true);
        addListEntry(event.to, hopCounter, true);
        setCurrentNode(event.to);
        break;

      case "title": {
        const tnode = nodeIndex.get(event.url);
        if (tnode) {
          tnode.title = event.title;
          updateNodeLabel(event.url);
          updateListEntry(event.url);
        }
        break;
      }

      case "done":
        topStatus.textContent = `done — ${hopCount} hops`;
        setCurrentNode(null);
        showStats(hopCount);
        stopBtn.disabled = true;
        sse.close();
        setTimeout(fitToView, 600);
        break;

      case "error":
        topStatus.textContent = `error: ${event.message}`;
        stopBtn.disabled = true;
        sse.close();
        break;
    }
  };

  sse.onerror = () => {
    if (!crawlStopped) topStatus.textContent = "connection lost";
    sse.close();
  };
}

// ── arXiv crawl ───────────────────────────────────────────────────────────
function startArxivCrawl(url, depth, maxRefs) {
  nodes.length = 0;
  links.length = 0;
  nodeIndex.clear();
  domainVisits.clear();
  nodeHop.clear();
  listEntries.clear();
  urlListInner.innerHTML = "";
  hopCounter = 0;
  currentNodeUrl = null;
  crawlStopped = false;
  isArxivMode = true;
  showTitles = true;

  hideDetail();
  stopBtn.disabled = false;

  landing.classList.add("fade-out");
  graphView.classList.remove("hidden");
  statsPanel.classList.add("hidden");
  initGraph();
  setTimeout(() => {
    landing.style.display = "none";
  }, 400);

  topUrl.textContent = url;
  topStatus.textContent = "fetching papers…";

  if (currentSSE) currentSSE.close();

  const endpoint = `${BACKEND}/crawl-arxiv?url=${encodeURIComponent(url)}&depth=${depth}&maxRefs=${maxRefs}`;
  const sse = new EventSource(endpoint);
  currentSSE = sse;

  let paperCount = 0;

  sse.onmessage = (e) => {
    const event = JSON.parse(e.data);

    switch (event.type) {
      case "start":
        getOrCreateNode(event.url, true);
        nodeHop.set(event.url, 0);
        break;

      case "visit":
        paperCount++;
        hopCounter++;
        topStatus.textContent = `${paperCount} papers found`;
        addEdge(event.from, event.to, false);
        addListEntry(event.to, hopCounter, false);
        if (!nodeHop.has(event.to)) nodeHop.set(event.to, event.depth);
        setCurrentNode(event.to);
        break;

      case "title": {
        const tnode = nodeIndex.get(event.url);
        if (tnode) {
          tnode.title = event.title;
          updateNodeLabel(event.url);
          updateListEntry(event.url);
        }
        break;
      }

      case "done":
        topStatus.textContent = `done — ${paperCount} papers`;
        setCurrentNode(null);
        showStats(paperCount);
        stopBtn.disabled = true;
        sse.close();
        setTimeout(fitToView, 600);
        break;

      case "status":
        topStatus.textContent = event.message;
        break;

      case "error":
        topStatus.textContent = `error: ${event.message}`;
        stopBtn.disabled = true;
        sse.close();
        break;
    }
  };

  sse.onerror = () => {
    if (!crawlStopped) topStatus.textContent = "connection lost";
    sse.close();
  };
}

// ── Events ─────────────────────────────────────────────────────────────────
form.addEventListener("submit", (e) => {
  e.preventDefault();
  const url       = urlInput.value.trim();
  const hops      = Math.min(Math.max(parseInt(hopsInput.value) || 10, 1), 100);
  const domainCap = Math.min(Math.max(parseInt(domainCapInput.value) || 3, 1), 50);
  if (!url) return;
  startCrawl(url, hops, domainCap);
});

arxivForm.addEventListener("submit", (e) => {
  e.preventDefault();
  const url   = arxivInput.value.trim();
  const depth = Math.max(parseInt(depthInput.value) || 2, 1);
  const refs  = Math.max(parseInt(refsInput.value) || 5, 1);
  if (!url) return;
  startArxivCrawl(url, depth, refs);
});

randomBtn.addEventListener("click", async (e) => {
  e.preventDefault();
  const orig = randomBtn.textContent;
  randomBtn.textContent = "…";
  randomBtn.disabled = true;
  try {
    const res  = await fetch("https://en.wikipedia.org/api/rest_v1/page/random/summary");
    const data = await res.json();
    urlInput.value = data.content_urls.desktop.page;
  } catch {
    urlInput.placeholder = "fetch failed, try again";
  } finally {
    randomBtn.textContent = orig;
    randomBtn.disabled = false;
  }
});

stopBtn.addEventListener("click", stopCrawl);
fitBtn.addEventListener("click", fitToView);
exportBtn.addEventListener("click", exportCSV);

resetBtn.addEventListener("click", () => {
  if (currentSSE) currentSSE.close();
  graphView.classList.add("hidden");
  statsPanel.classList.add("hidden");
  hideDetail();
  landing.style.display = "";
  landing.classList.remove("fade-out");
  isArxivMode = false;
  urlInput.value = "";
  arxivInput.value = "";
  urlInput.focus();
});

window.addEventListener("resize", () => {
  if (!simulation) return;
  const w = graphSvg.clientWidth;
  const h = graphSvg.clientHeight;
  d3.select(graphSvg).attr("width", w).attr("height", h);
  simulation.force("center", d3.forceCenter(w / 2, h / 2)).alpha(0.1).restart();
});
} // End of initApp()
