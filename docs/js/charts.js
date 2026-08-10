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
export function groupedColumns({
  groups, series, value, tip,
  height = 320, format = (v) => v.toFixed(3), yMax = null, yLabel = '',
}) {
  const width = 860;
  const pad = { top: 24, right: 16, bottom: 46, left: 52 };
  const plotWidth = width - pad.left - pad.right;
  const plotHeight = height - pad.top - pad.bottom;

  const values = groups.flatMap((_, gi) => series.map((s) => value(s.key, gi)));
  const scale = niceScale(Math.max(...values, 0.001));
  const max = yMax ?? scale.max;
  const ticks = yMax ? 5 : scale.ticks;

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
  if (yLabel) {
    const label = el('text', {
      x: 0, y: 0, 'font-size': 11, 'text-anchor': 'middle',
      transform: `translate(14, ${pad.top + plotHeight / 2}) rotate(-90)`,
    });
    label.textContent = yLabel;
    svg.appendChild(label);
  }

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
