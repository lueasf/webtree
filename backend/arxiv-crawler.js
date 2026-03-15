import axios from "axios";

const S2_API = "https://api.semanticscholar.org/graph/v1/paper";
const FIELDS = "title,year,externalIds,references.title,references.year,references.externalIds";
const REQUEST_TIMEOUT_MS = 10000;

function delay(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function extractArxivId(input) {
  const m = input.match(/arxiv\.org\/(?:abs|pdf|html)\/(\d{4}\.\d{4,5}(?:v\d+)?)/i);
  if (m) return m[1].replace(/v\d+$/, "");
  const old = input.match(/arxiv\.org\/(?:abs|pdf|html)\/([\w-]+\/\d{7}(?:v\d+)?)/i);
  if (old) return old[1].replace(/v\d+$/, "");
  const idMatch = input.match(/^(\d{4}\.\d{4,5})(?:v\d+)?$/);
  if (idMatch) return idMatch[1];
  const oldId = input.match(/^([\w-]+\/\d{7})(?:v\d+)?$/);
  if (oldId) return oldId[1];
  return null;
}

async function fetchPaper(paperId) {
  const res = await axios.get(`${S2_API}/${paperId}`, {
    params: { fields: FIELDS },
    timeout: REQUEST_TIMEOUT_MS,
    validateStatus: () => true,
  });
  if (res.status === 200) return res.data;
  if (res.status === 429) throw new Error("rate limited");
  return null;
}

function paperLabel(paper) {
  if (!paper) return "unknown";
  const year = paper.year ? ` (${paper.year})` : "";
  return (paper.title || "untitled") + year;
}

function paperUrl(paper) {
  const arxivId = paper.externalIds?.ArXiv;
  if (arxivId) return `https://arxiv.org/abs/${arxivId}`;
  if (paper.paperId) return `https://www.semanticscholar.org/paper/${paper.paperId}`;
  return null;
}

export async function crawlArxiv(inputUrl, depth, maxRefs, emit, signal) {
  const arxivId = extractArxivId(inputUrl);
  if (!arxivId) {
    emit({ type: "error", message: "Could not extract arXiv ID from URL" });
    return;
  }

  const visited = new Set();
  let root;
  try {
    root = await fetchPaper(`arXiv:${arxivId}`);
  } catch {
    root = null;
  }
  if (!root) {
    emit({ type: "error", message: `Paper arXiv:${arxivId} not found on Semantic Scholar` });
    return;
  }

  const rootUrl = paperUrl(root) || inputUrl;
  emit({ type: "start", url: rootUrl });
  emit({ type: "title", url: rootUrl, title: paperLabel(root) });
  visited.add(root.paperId);

  // BFS queue
  const queue = [{ paper: root, url: rootUrl, currentDepth: 0 }];
  let paperCount = 0;

  while (queue.length > 0) {
    if (signal?.aborted) break;

    const { paper, url: parentUrl, currentDepth } = queue.shift();
    if (currentDepth >= depth) continue;

    const refs = (paper.references || []).filter(
      (r) => r.title && r.paperId && !visited.has(r.paperId)
    );
    const selected = refs.slice(0, maxRefs);

    for (const ref of selected) {
      if (signal?.aborted) break;
      if (visited.has(ref.paperId)) continue;
      visited.add(ref.paperId);

      const refUrl = paperUrl(ref) || `s2:${ref.paperId}`;
      paperCount++;

      emit({ type: "visit", from: parentUrl, to: refUrl, depth: currentDepth + 1 });
      emit({ type: "title", url: refUrl, title: paperLabel(ref) });

      // Go deeper: fetch full paper (1s between each request)
      if (currentDepth + 1 < depth) {
        await delay(1000);
        try {
          const fullRef = await fetchPaper(ref.paperId);
          if (fullRef) {
            queue.push({ paper: fullRef, url: refUrl, currentDepth: currentDepth + 1 });
          }
        } catch {
          // rate limited or error, skip this branch
        }
      } else {
        // Even at max depth, small delay so graph builds progressively
        await delay(150);
      }
    }
  }

  emit({ type: "done", depth: paperCount });
}
