import { h, icon, tc, isoDate, addDays, diffDays, relDay, PERSONISH } from './dom.js';
import { state, edit, select, pathTo } from './state.js';

// "What needs attention": overdue and upcoming follow-ups, people going quiet, skills getting rusty.

const STALE_DAYS = 30;

function row(n, { right, actions }) {
  return h('div', { class: 'ag-row' },
    h('button', { class: 'ag-main', type: 'button', onclick: () => select(n.id, { view: 'note' }) },
      h('span', { class: 'tdot', style: tc(n.type) }),
      h('span', { class: 'ag-title' }, n.title),
      h('span', { class: 'ag-path' }, pathTo(n.id).slice(0, -1).map((x) => x.title).join(' / ') || n.type)),
    right ? h('span', { class: 'ag-when' }, right) : null,
    h('div', { class: 'ag-actions' }, actions));
}

export function render() {
  const host = document.getElementById('agenda');
  host.replaceChildren();
  const today = isoDate();
  const all = [...state.nodes.values()];
  const redraw = () => render();

  const done = (n) => h('button', { class: 'btn sm', type: 'button', onclick: () => { edit(n, { followUp: null, lastTouched: today }); redraw(); } }, icon('check', 12), 'Done');
  const snooze = (n) => h('button', { class: 'btn sm', type: 'button', onclick: () => { edit(n, { followUp: addDays(today, 7) }); redraw(); } }, 'Snooze a week');
  const touched = (n) => h('button', { class: 'btn sm', type: 'button', onclick: () => { edit(n, { lastTouched: today }); redraw(); } }, icon('check', 12), 'Touched today');

  const due = all.filter((n) => n.followUp).sort((a, b) => a.followUp.localeCompare(b.followUp));
  const overdue = due.filter((n) => n.followUp < today);
  const week = due.filter((n) => n.followUp >= today && diffDays(n.followUp, today) <= 7);
  const later = due.filter((n) => diffDays(n.followUp, today) > 7);
  const quiet = all.filter((n) => PERSONISH.has(n.type) && n.lastTouched && diffDays(today, n.lastTouched) >= STALE_DAYS && !(n.followUp && n.followUp >= today))
    .sort((a, b) => a.lastTouched.localeCompare(b.lastTouched));
  const rusty = all.filter((n) => n.type === 'skill' && n.lastTouched && diffDays(today, n.lastTouched) >= STALE_DAYS)
    .sort((a, b) => a.lastTouched.localeCompare(b.lastTouched));

  const group = (title, items, build, tone) => (items.length ? h('section', { class: `ag-group ${tone || ''}` },
    h('h3', {}, title, h('span', { class: 'ag-n' }, String(items.length))),
    h('div', {}, items.map(build))) : null);

  const groups = [
    group('Overdue', overdue, (n) => row(n, { right: relDay(n.followUp), actions: [done(n), snooze(n)] }), 'warn'),
    group('Next 7 days', week, (n) => row(n, { right: relDay(n.followUp), actions: [done(n), snooze(n)] })),
    group('Later', later, (n) => row(n, { right: relDay(n.followUp), actions: [done(n)] })),
    group('People you have not touched in a while', quiet, (n) => row(n, { right: `${diffDays(today, n.lastTouched)} days quiet`, actions: [touched(n)] })),
    group('Skills to practise', rusty, (n) => row(n, { right: `${diffDays(today, n.lastTouched)} days ago`, actions: [touched(n)] })),
  ].filter(Boolean);

  host.append(h('div', { class: 'agenda-doc' },
    h('h2', { class: 'doc-title static' }, 'Needs attention'),
    h('p', { class: 'lede' }, `Follow-ups, people going quiet after ${STALE_DAYS} days, and skills you have not used in ${STALE_DAYS} days.`),
    groups.length ? groups : h('div', { class: 'ag-empty' },
      h('p', {}, 'Nothing needs attention right now.'),
      h('p', { class: 'hint' }, 'Set "Follow up on" or "Last touched" on a person, company or skill and it will show up here when it is due.'))));
}
