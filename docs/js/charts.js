/* One hand-rolled SVG chart. A charting library would outweigh the single
 * grouped column chart this page draws.
 *
 * Mark specs follow the house data-viz rules: bars capped at 24px with a 4px
 * rounded cap and a square foot on the baseline, a 2px surface gap between
 * adjacent bars, and hairline gridlines. The aqua and yellow slots sit below
 * 3:1 on the light surface, so the relief rule applies — met here by the
 * table view toggle and the full results table, not by a label on every bar.
 */

const NS = 'http://www.w3.org/2000/svg';
const BAR_MAX = 22;
const GAP = 2;
const CAP = 4;

const el = (name, attrs = {}) => {
  const node = document.createElementNS(NS, name);
  for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, value);
  return node;
};

/* A bar with a rounded top and square bottom: rounding both ends makes short
 * bars read as pills detached from the baseline. */
function barPath(x, y, width, height) {
  const r = Math.min(CAP, width / 2, Math.max(height, 0));
  if (height <= 0.5) return `M${x} ${y}h${width}`;
  return `M${x} ${y + height}V${y + r}a${r} ${r} 0 0 1 ${r} ${-r}` +
         `h${width - 2 * r}a${r} ${r} 0 0 1 ${r} ${r}V${y + height}Z`;
}

function tooltip() {
  let node = document.querySelector('.viz-tip');
  if (!node) {
    node = document.createElement('div');
    node.className = 'viz-tip';
    node.setAttribute('role', 'status');
    document.body.appendChild(node);
  }
  return {
    show(html, event) {
      node.innerHTML = html;
      node.style.opacity = '1';
      const box = node.getBoundingClientRect();
      const left = Math.min(
        Math.max(8, event.clientX - box.width / 2),
        window.innerWidth - box.width - 8,
      );
      const top = event.clientY - box.height - 14;
      node.style.left = `${left}px`;
      node.style.top = `${top < 8 ? event.clientY + 18 : top}px`;
    },
    hide() { node.style.opacity = '0'; },
  };
}

/**
 * Grouped column chart.
 *
 * @param {object} spec
 * @param {string[]} spec.groups   category per group (the x axis)
 * @param {{key,label,color}[]} spec.series  fixed-order series
 * @param {(seriesKey, groupIndex) => number} spec.value
 * @param {(seriesKey, groupIndex) => string} [spec.tip]
 */
export function groupedColumns({ groups, series, value, tip, ceiling = null }) {
  const width = 860;
  const height = 320;
  const format = (v) => v.toFixed(3);
  const pad = { top: 24, right: 16, bottom: 46, left: 52 };
  const plotWidth = width - pad.left - pad.right;
  const plotHeight = height - pad.top - pad.bottom;

  const values = groups.flatMap((_, gi) => series.map((s) => value(s.key, gi)));
  const { max, ticks } = niceScale(Math.max(...values, ...(ceiling ?? []), 0.001));

  // Label the leader in each group only. A number on every bar collides once
  // two methods score within a few thousandths -- the tooltip and the table
  // view carry the exact figures for the rest.
  const leaders = groups.map((_, gi) =>
    series.reduce((best, s) => (value(s.key, gi) > value(best.key, gi) ? s : best), series[0]).key);

  const svg = el('svg', {
    class: 'chart', viewBox: `0 0 ${width} ${height}`,
    role: 'img', preserveAspectRatio: 'xMidYMid meet',
  });
  const y = (v) => pad.top + plotHeight - (v / max) * plotHeight;

  // gridlines + y ticks
  for (let i = 0; i <= ticks; i++) {
    const v = (max / ticks) * i;
    svg.appendChild(el('line', {
      class: 'grid', x1: pad.left, x2: width - pad.right, y1: y(v), y2: y(v),
    }));
    const label = el('text', {
      x: pad.left - 10, y: y(v) + 4, 'text-anchor': 'end', 'font-size': 11.5,
    });
    label.textContent = v.toFixed(2);
    svg.appendChild(label);
  }
  const axisLabel = el('text', {
    x: 0, y: 0, 'font-size': 11, 'text-anchor': 'middle',
    transform: `translate(14, ${pad.top + plotHeight / 2}) rotate(-90)`,
  });
  axisLabel.textContent = 'F-measure';
  svg.appendChild(axisLabel);

  svg.appendChild(el('line', {
    class: 'axis', x1: pad.left, x2: width - pad.right,
    y1: y(0), y2: y(0),
  }));

  const bandWidth = plotWidth / groups.length;
  const barWidth = Math.min(BAR_MAX, (bandWidth * 0.62 - GAP * (series.length - 1)) / series.length);
  const groupWidth = barWidth * series.length + GAP * (series.length - 1);
  const tip$ = tooltip();

  groups.forEach((group, gi) => {
    const bandStart = pad.left + bandWidth * gi + (bandWidth - groupWidth) / 2;

    series.forEach((s, si) => {
      const v = value(s.key, gi);
      const x = bandStart + si * (barWidth + GAP);
      const top = y(v);

      const path = el('path', {
        d: barPath(x, top, barWidth, y(0) - top),
        fill: s.color,
        tabindex: '0',
        role: 'graphics-symbol',
        'aria-label': `${s.label}, ${group}: ${format(v)}`,
      });
      const html = tip ? tip(s.key, gi)
        : `<b>${s.label}</b><br>${group}: ${format(v)}`;
      const show = (event) => tip$.show(html, event.touches?.[0] ?? event);
      path.addEventListener('pointerenter', show);
      path.addEventListener('pointermove', show);
      path.addEventListener('pointerleave', tip$.hide);
      path.addEventListener('blur', tip$.hide);
      path.addEventListener('focus', (event) => {
        const box = path.getBoundingClientRect();
        tip$.show(html, { clientX: box.left + box.width / 2, clientY: box.top });
      });
      svg.appendChild(path);

      if (leaders[gi] === s.key) {
        const caption = el('text', {
          x: x + barWidth / 2, y: top - 8, 'text-anchor': 'middle',
          'font-size': 11.5, class: 'val lead',
        });
        caption.textContent = format(v);
        svg.appendChild(caption);
      }
    });

    // Human ceiling: the article lead trimmed to the same word budget the
    // methods get. Drawn as a rule rather than a fifth bar -- it is the
    // yardstick, not a competitor, and a bar invites reading it as the winner.
    if (ceiling && Number.isFinite(ceiling[gi])) {
      const cy = y(ceiling[gi]);
      svg.appendChild(el('line', {
        x1: bandStart - 10, x2: bandStart + groupWidth + 10, y1: cy, y2: cy,
        stroke: 'var(--ink)', 'stroke-width': 1.5, 'stroke-dasharray': '5 3',
      }));
      const ct = el('text', {
        x: bandStart + groupWidth + 14, y: cy + 3.5, 'font-size': 10,
        class: 'val lead',
      });
      ct.textContent = ceiling[gi].toFixed(3);
      svg.appendChild(ct);
    }

    const label = el('text', {
      x: pad.left + bandWidth * gi + bandWidth / 2, y: height - 18,
      'text-anchor': 'middle', 'font-size': 12.5, class: 'grouplabel',
    });
    label.textContent = group;
    svg.appendChild(label);
  });

  return svg;
}

/* Pick a round tick step, then the smallest multiple of it that clears the
 * data. Rounding the *step* rather than the *max* keeps the bars filling the
 * plot instead of stranding them in the bottom half of an over-tall axis. */
function niceScale(dataMax, target = 5) {
  const raw = dataMax / target;
  const magnitude = 10 ** Math.floor(Math.log10(raw));
  const scaled = raw / magnitude;
  const step = (scaled <= 1 ? 1 : scaled <= 2 ? 2 : scaled <= 2.5 ? 2.5 : scaled <= 5 ? 5 : 10) * magnitude;
  const ticks = Math.ceil(dataMax / step);
  return { max: step * ticks, ticks };
}

/* ==========================================================================
 * Per-article visuals. Every one recomputes from whatever article is loaded.
 * ========================================================================== */


/**
 * Overlap matrix: Jaccard similarity between the sentence sets each pair of
 * methods chose. Reveals which methods are near-duplicates and which is
 * genuinely contributing a different view of the article.
 */
export function overlapMatrix({ methods, cell = 58 }) {
  const labelW = 104;
  const topH = 58;
  const width = 520;
  const height = topH + methods.length * cell + 6;

  const svg = el('svg', {
    class: 'chart', viewBox: `0 0 ${width} ${height}`,
    role: 'img', preserveAspectRatio: 'xMinYMin meet',
    'aria-label': 'Pairwise overlap between the sentences each method selected',
  });
  const tip$ = tooltip();

  const jaccard = (a, b) => {
    const A = new Set(a); const B = new Set(b);
    const inter = [...A].filter((x) => B.has(x)).length;
    const union = A.size + B.size - inter;
    return union ? inter / union : 0;
  };

  methods.forEach((m, c) => {
    const t = el('text', {
      x: 0, y: 0, 'font-size': 10, 'text-anchor': 'start',
      transform: `translate(${labelW + c * cell + cell / 2 - 6}, ${topH - 12}) rotate(-38)`,
    });
    t.textContent = m.label;
    svg.appendChild(t);
  });

  methods.forEach((rowM, r) => {
    const t = el('text', {
      x: labelW - 12, y: topH + r * cell + cell / 2 + 4,
      'text-anchor': 'end', 'font-size': 10.5, class: 'grouplabel',
    });
    t.textContent = rowM.label;
    svg.appendChild(t);

    methods.forEach((colM, c) => {
      const x = labelW + c * cell;
      const y = topH + r * cell;
      const same = r === c;
      const v = same ? 1 : jaccard(rowM.indices, colM.indices);

      // One-hue sequential ramp. The diagonal is inert grey so it reads as a
      // rule rather than as the strongest signal in the grid.
      const fill = same
        ? 'var(--rule)'
        : `color-mix(in srgb, var(--accent) ${Math.round(v * 100)}%, var(--bg-2))`;

      const rect = el('rect', {
        x: x + 1, y: y + 1, width: cell - 2, height: cell - 2, rx: 2, fill,
        tabindex: same ? '-1' : '0', role: 'graphics-symbol',
        'aria-label': same ? `${rowM.label} against itself`
          : `${rowM.label} and ${colM.label} share ${Math.round(v * 100)} percent of their sentences`,
      });
      if (!same) {
        const shared = [...new Set(rowM.indices)].filter((i) => new Set(colM.indices).has(i)).length;
        const html = `<b>${rowM.label} · ${colM.label}</b><br>${(v * 100).toFixed(0)}% overlap` +
                     `<br>${shared} shared sentence${shared === 1 ? '' : 's'}`;
        const show = (e) => tip$.show(html, e.touches?.[0] ?? e);
        rect.addEventListener('pointerenter', show);
        rect.addEventListener('pointermove', show);
        rect.addEventListener('pointerleave', tip$.hide);
        rect.addEventListener('blur', tip$.hide);
      }
      svg.appendChild(rect);

      if (!same) {
        const label = el('text', {
          x: x + cell / 2, y: y + cell / 2 + 4, 'text-anchor': 'middle',
          'font-size': 11, class: 'val',
          fill: v > 0.55 ? 'var(--bg)' : 'var(--ink-2)',
        });
        label.textContent = v.toFixed(2);
        svg.appendChild(label);
      }
    });
  });

  return svg;
}


/**
 * Slopegraph over *rank*, not raw score.
 *
 * The correct answer to "compare N methods on M metrics": a radar chart makes
 * area meaningless and depends on axis order, while crossing lines show
 * directly whether a method's lead holds or flips between metrics.
 *
 * Plotting rank rather than value is deliberate. Scores cluster tightly --
 * three methods routinely land within a thousandth on ROUGE-1 -- so a value
 * axis collapses them onto one pixel and their labels collide. Rank spaces them
 * evenly and answers the actual question, which is about ordering. Exact values
 * stay in the table and the tooltip.
 */
export function slopegraph({ metrics, methods, height = 280 }) {
  const width = 520;
  const pad = { top: 46, right: 92, bottom: 40, left: 92 };
  const plotH = height - pad.top - pad.bottom;
  const cols = metrics.length;
  const colX = (i) => pad.left + (i * (width - pad.left - pad.right)) / (cols - 1);
  const rowY = (rank) => pad.top + ((rank - 1) * plotH) / Math.max(methods.length - 1, 1);

  // Rank per metric: 1 is best.
  const rankOf = metrics.map((_, i) => {
    const order = [...methods].sort((a, b) => b.values[i] - a.values[i]);
    return new Map(order.map((m, idx) => [m.key, idx + 1]));
  });

  const svg = el('svg', {
    class: 'chart', viewBox: `0 0 ${width} ${height}`,
    role: 'img', preserveAspectRatio: 'xMidYMid meet',
    'aria-label': 'Each method’s rank across the three ROUGE variants',
  });
  const tip$ = tooltip();

  for (let r = 1; r <= methods.length; r++) {
    svg.appendChild(el('line', {
      class: 'grid', x1: colX(0) - 18, x2: colX(cols - 1) + 18, y1: rowY(r), y2: rowY(r),
    }));
    const t = el('text', {
      x: colX(0) - 30, y: rowY(r) + 4, 'text-anchor': 'end', 'font-size': 10.5,
    });
    t.textContent = `Rank ${r}`;
    svg.appendChild(t);
  }

  metrics.forEach((label, i) => {
    const t = el('text', {
      x: colX(i), y: pad.top - 22, 'text-anchor': 'middle',
      'font-size': 10.5, class: 'grouplabel',
    });
    t.textContent = label;
    svg.appendChild(t);
  });

  for (const m of methods) {
    const points = m.values.map((_, i) => [colX(i), rowY(rankOf[i].get(m.key))]);

    svg.appendChild(el('polyline', {
      points: points.map(([px, py]) => `${px},${py}`).join(' '),
      fill: 'none', stroke: m.color, 'stroke-width': 2.6,
      'stroke-linejoin': 'round', 'stroke-linecap': 'round',
    }));

    points.forEach(([px, py], i) => {
      const dot = el('circle', {
        cx: px, cy: py, r: 5, fill: m.color, stroke: 'var(--bg)', 'stroke-width': 2,
        tabindex: '0', role: 'graphics-symbol',
        'aria-label': `${m.label}, ${metrics[i]}: rank ${rankOf[i].get(m.key)}, score ${m.values[i].toFixed(3)}`,
      });
      const html = `<b>${m.label}</b><br>${metrics[i]}: ${m.values[i].toFixed(3)}` +
                   `<br>rank ${rankOf[i].get(m.key)} of ${methods.length}`;
      const show = (e) => tip$.show(html, e.touches?.[0] ?? e);
      dot.addEventListener('pointerenter', show);
      dot.addEventListener('pointermove', show);
      dot.addEventListener('pointerleave', tip$.hide);
      dot.addEventListener('blur', tip$.hide);
      svg.appendChild(dot);
    });
  }

  // Legend along the bottom, as one row of swatch + label pairs.
  let lx = colX(0) - 18;
  for (const m of methods) {
    svg.appendChild(el('rect', {
      x: lx, y: height - 22, width: 9, height: 9, rx: 2, fill: m.color,
    }));
    const t = el('text', { x: lx + 13, y: height - 14, 'font-size': 9.5 });
    t.textContent = m.label;
    svg.appendChild(t);
    lx += 22 + m.label.length * 5.4;
  }

  const hint = el('text', {
    x: width - pad.right + 60, y: height - 14, 'text-anchor': 'end', 'font-size': 9,
  });
  hint.textContent = 'rank 1 = best';
  svg.appendChild(hint);

  return svg;
}

/**
 * Coverage against redundancy.
 *
 * X: share of the article's top content terms the summary contains.
 * Y: internal repetition -- mean pairwise similarity between the summary's own
 *    sentences, so a summary that says the same thing four times scores high.
 *
 * This is the chart that justifies MMR existing: the other three score each
 * sentence independently and can happily pick four near-duplicates, while MMR
 * subtracts a redundancy penalty at every step. It should sit low and right.
 * Low-Y/high-X is the good corner, and it is shaded to say so.
 */
export function quadrant({ points, height = 300 }) {
  const width = 520;
  const pad = { top: 20, right: 24, bottom: 48, left: 60 };
  const plotW = width - pad.left - pad.right;
  const plotH = height - pad.top - pad.bottom;

  const maxX = Math.max(0.1, ...points.map((p) => p.coverage)) * 1.15;
  const maxY = Math.max(0.05, ...points.map((p) => p.redundancy)) * 1.2;
  const x = (v) => pad.left + (v / maxX) * plotW;
  const y = (v) => pad.top + plotH - (v / maxY) * plotH;

  const svg = el('svg', {
    class: 'chart', viewBox: `0 0 ${width} ${height}`,
    role: 'img', preserveAspectRatio: 'xMinYMin meet',
    'aria-label': 'Content coverage against internal redundancy for each method',
  });
  const tip$ = tooltip();

  // Shade the desirable corner: broad coverage, little repetition.
  svg.appendChild(el('rect', {
    x: x(maxX / 2), y: y(maxY / 2), width: plotW / 2, height: plotH / 2,
    fill: 'var(--ink)', opacity: '.04',
  }));
  const hint = el('text', {
    x: x(maxX / 2) + 8, y: y(maxY / 2) + 14, 'font-size': 9.5,
  });
  hint.textContent = 'broad coverage, little repetition';
  svg.appendChild(hint);

  for (let i = 0; i <= 4; i++) {
    svg.appendChild(el('line', {
      class: 'grid', x1: pad.left, x2: pad.left + plotW,
      y1: pad.top + (plotH / 4) * i, y2: pad.top + (plotH / 4) * i,
    }));
    svg.appendChild(el('line', {
      class: 'grid', x1: pad.left + (plotW / 4) * i, x2: pad.left + (plotW / 4) * i,
      y1: pad.top, y2: pad.top + plotH,
    }));
    const ly = el('text', {
      x: pad.left - 9, y: pad.top + (plotH / 4) * i + 4, 'text-anchor': 'end', 'font-size': 10,
    });
    ly.textContent = (maxY - (maxY / 4) * i).toFixed(2);
    svg.appendChild(ly);
    const lx = el('text', {
      x: pad.left + (plotW / 4) * i, y: pad.top + plotH + 16,
      'text-anchor': 'middle', 'font-size': 10,
    });
    lx.textContent = `${Math.round(((maxX / 4) * i) * 100)}%`;
    svg.appendChild(lx);
  }

  const ax = el('text', {
    x: pad.left + plotW / 2, y: height - 10, 'text-anchor': 'middle',
    'font-size': 10.5, class: 'grouplabel',
  });
  ax.textContent = 'coverage of the article’s key terms →';
  svg.appendChild(ax);

  const ay = el('text', {
    x: 0, y: 0, 'font-size': 10.5, 'text-anchor': 'middle', class: 'grouplabel',
    transform: `translate(16, ${pad.top + plotH / 2}) rotate(-90)`,
  });
  ay.textContent = '↑ repeats itself more';
  svg.appendChild(ay);

  // Nudge labels apart when two methods land on nearly the same coordinates,
  // which happens whenever two of them agree closely (TextRank and TF-IDF
  // routinely do). Without this the two labels overprint.
  // Seed with every dot, so a label is nudged off a neighbouring marker too --
  // not just off another label.
  const placed = points.map((p) => ({ x: x(p.coverage), y: y(p.redundancy) }));
  for (const p of points) {
    const cx = x(p.coverage);
    const cy = y(p.redundancy);
    const dot = el('circle', {
      cx, cy, r: 6, fill: p.color, stroke: 'var(--bg)', 'stroke-width': 2,
      tabindex: '0', role: 'graphics-symbol',
      'aria-label': `${p.label}: covers ${Math.round(p.coverage * 100)} percent of key terms, redundancy ${p.redundancy.toFixed(2)}`,
    });
    const html = `<b>${p.label}</b><br>covers ${Math.round(p.coverage * 100)}% of key terms` +
                 `<br>internal repetition ${p.redundancy.toFixed(2)}`;
    const show = (e) => tip$.show(html, e.touches?.[0] ?? e);
    dot.addEventListener('pointerenter', show);
    dot.addEventListener('pointermove', show);
    dot.addEventListener('pointerleave', tip$.hide);
    dot.addEventListener('blur', tip$.hide);
    svg.appendChild(dot);

    let ly = cy + 4;
    let guard = 0;
    while (guard++ < 8 && placed.some(
      (q) => !(q.x === cx && Math.abs(q.y - (cy)) < 0.01)
             && Math.abs(q.x - cx) < 104 && Math.abs(q.y - ly) < 12)) {
      ly += 13;
    }
    placed.push({ x: cx, y: ly });

    const t = el('text', { x: cx + 11, y: ly, 'font-size': 10.5, class: 'val' });
    t.textContent = p.label;
    svg.appendChild(t);
  }

  return svg;
}


/** Grouped horizontal bars -- used for key-term coverage per method. */
export function termCoverage({ rows, totalTerms, height = null }) {
  const width = 520;
  const rowH = 34;
  const pad = { top: 10, right: 62, bottom: 26, left: 116 };
  const total = height ?? pad.top + pad.bottom + rows.length * rowH;
  const plotW = width - pad.left - pad.right;

  const svg = el('svg', {
    class: 'chart', viewBox: `0 0 ${width} ${total}`,
    role: 'img', preserveAspectRatio: 'xMinYMin meet',
    'aria-label': 'How many of the article’s key terms each summary contains',
  });
  const tip$ = tooltip();

  for (const [i, r] of rows.entries()) {
    const cy = pad.top + rowH * i + rowH / 2;
    const len = (r.hit / totalTerms) * plotW;

    const label = el('text', {
      x: pad.left - 12, y: cy + 4, 'text-anchor': 'end', 'font-size': 11, class: 'grouplabel',
    });
    label.textContent = r.label;
    svg.appendChild(label);

    // Track shows the terms the summary missed.
    svg.appendChild(el('rect', {
      x: pad.left, y: cy - 8, width: plotW, height: 16, rx: 2, fill: 'var(--bg-2)',
    }));

    const bar = el('rect', {
      x: pad.left, y: cy - 8, width: Math.max(2, len), height: 16, rx: 2, fill: r.color,
      tabindex: '0', role: 'graphics-symbol',
      'aria-label': `${r.label} contains ${r.hit} of ${totalTerms} key terms`,
    });
    const html = `<b>${r.label}</b><br>${r.hit} of ${totalTerms} key terms` +
                 (r.missed?.length ? `<br>missing: ${r.missed.slice(0, 5).join(', ')}` : '');
    const show = (e) => tip$.show(html, e.touches?.[0] ?? e);
    bar.addEventListener('pointerenter', show);
    bar.addEventListener('pointermove', show);
    bar.addEventListener('pointerleave', tip$.hide);
    bar.addEventListener('blur', tip$.hide);
    svg.appendChild(bar);

    const t = el('text', { x: pad.left + plotW + 9, y: cy + 4, 'font-size': 10.5, class: 'val' });
    t.textContent = `${r.hit}/${totalTerms}`;
    svg.appendChild(t);
  }

  const foot = el('text', { x: pad.left, y: total - 6, 'font-size': 9.5 });
  foot.textContent = `key terms = the article’s ${totalTerms} highest TF-IDF content words`;
  svg.appendChild(foot);

  return svg;
}

/**
 * Positional density of each method's selected sentences, as overlaid filled
 * curves.
 *
 * Answers "where in the article does this method look?" for all four at once.
 * A curve humped at the left is lead-biased -- effectively paraphrasing the
 * introduction; a flat or right-shifted curve means the method genuinely read
 * the body.
 *
 * Gaussian kernel density rather than a histogram: with only 3-6 selected
 * sentences per method, histogram bin edges dominate the shape and the picture
 * changes when the bin count does. A kernel smooths that away and the curves
 * stay comparable between methods.
 */
export function positionDensity({ methods, total, height = 300 }) {
  const width = 860;
  const pad = { top: 44, right: 24, bottom: 46, left: 58 };
  const plotW = width - pad.left - pad.right;
  const plotH = height - pad.top - pad.bottom;

  const STEPS = 90;
  // Bandwidth as a fraction of the document: wide enough that a handful of
  // picks reads as a distribution rather than as isolated spikes.
  const bw = 0.09;

  const curves = methods.map((m) => {
    const positions = m.indices.map((i) => i / Math.max(total - 1, 1));
    const ys = [];
    for (let k = 0; k <= STEPS; k++) {
      const x = k / STEPS;
      let sum = 0;
      for (const pos of positions) {
        const z = (x - pos) / bw;
        sum += Math.exp(-0.5 * z * z);
      }
      // Normalise by count so a method that picked more sentences does not
      // simply draw a taller curve -- shape is the comparison, not volume.
      ys.push(positions.length ? sum / positions.length : 0);
    }
    return { ...m, ys };
  });

  const peak = Math.max(1e-6, ...curves.flatMap((c) => c.ys));
  const x = (t) => pad.left + t * plotW;
  const y = (v) => pad.top + plotH - (v / peak) * plotH;

  const svg = el('svg', {
    class: 'chart', viewBox: `0 0 ${width} ${height}`,
    role: 'img', preserveAspectRatio: 'xMidYMid meet',
    'aria-label': 'Where in the article each method selected its sentences',
  });
  const tip$ = tooltip();

  svg.appendChild(el('line', {
    class: 'axis', x1: pad.left, x2: pad.left + plotW, y1: y(0), y2: y(0),
  }));

  for (const c of curves) {
    const pts = c.ys.map((v, k) => `${x(k / STEPS).toFixed(1)},${y(v).toFixed(1)}`);
    const d = `M${x(0)},${y(0)} L${pts.join(' L')} L${x(1)},${y(0)} Z`;

    svg.appendChild(el('path', {
      d, fill: c.color, opacity: '.18', stroke: 'none',
    }));
    const line = el('path', {
      d: `M${pts.join(' L')}`, fill: 'none', stroke: c.color, 'stroke-width': 2,
      'stroke-linejoin': 'round',
      tabindex: '0', role: 'graphics-symbol',
      'aria-label': `${c.label}: ${c.indices.length} sentences selected`,
    });

    // Mean position tells the lead-bias story numerically.
    const mean = c.indices.length
      ? c.indices.reduce((a, i) => a + i, 0) / c.indices.length / Math.max(total - 1, 1)
      : 0;
    const html = `<b>${c.label}</b><br>${c.indices.length} sentences` +
                 `<br>average position ${Math.round(mean * 100)}% through the article`;
    const show = (e) => tip$.show(html, e.touches?.[0] ?? e);
    line.addEventListener('pointerenter', show);
    line.addEventListener('pointermove', show);
    line.addEventListener('pointerleave', tip$.hide);
    line.addEventListener('blur', tip$.hide);
    svg.appendChild(line);

    // Ticks on the baseline mark the actual selected sentences.
    for (const i of c.indices) {
      svg.appendChild(el('line', {
        x1: x(i / Math.max(total - 1, 1)), x2: x(i / Math.max(total - 1, 1)),
        y1: y(0), y2: y(0) + 5, stroke: c.color, 'stroke-width': 1.5, opacity: '.8',
      }));
    }
  }

  for (const [t, label, anchor] of [[0, '0%', 'start'], [0.5, '50%', 'middle'], [1, '100%', 'end']]) {
    const tx = el('text', { x: x(t), y: y(0) + 20, 'text-anchor': anchor, 'font-size': 10 });
    tx.textContent = label;
    svg.appendChild(tx);
  }

  const ax = el('text', {
    x: pad.left + plotW / 2, y: height - 10, 'text-anchor': 'middle',
    'font-size': 10.5, class: 'grouplabel',
  });
  ax.textContent = 'sentence position in article';
  svg.appendChild(ax);

  const ay = el('text', {
    x: 0, y: 0, 'font-size': 10.5, 'text-anchor': 'middle', class: 'grouplabel',
    transform: `translate(16, ${pad.top + plotH / 2}) rotate(-90)`,
  });
  ay.textContent = 'density of picks';
  svg.appendChild(ay);

  // Legend across the top, matching the other cards.
  let lx = pad.left;
  for (const c of curves) {
    svg.appendChild(el('rect', { x: lx, y: 12, width: 9, height: 9, rx: 2, fill: c.color }));
    const t = el('text', { x: lx + 13, y: 20, 'font-size': 9.5 });
    t.textContent = c.label;
    svg.appendChild(t);
    lx += 24 + c.label.length * 5.6;
  }

  return svg;
}
