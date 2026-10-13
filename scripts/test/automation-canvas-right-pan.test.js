'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { reactFixture } = require('./helpers/react-dom-fixture.cjs');

const entry = `
import { useCanvasRightPan } from "./components/automation/use-canvas-right-pan";
export function Harness(props) {
  const pan = useCanvasRightPan(props);
  return <div id="canvas" data-panning={pan.panning} onMouseDownCapture={pan.onMouseDownCapture} onContextMenuCapture={pan.onContextMenuCapture}>
    <div className="react-flow">
      <div id="pane" className="react-flow__pane" />
      <div className="react-flow__node nopan" data-id="condition"><span id="node">condition</span><button id="summary" className="studio-flow-summary-edit">summary</button><button id="gear">settings</button>
        <input id="input" /><textarea id="textarea" /><select id="select"><option>value</option></select><div id="editable" contentEditable /></div>
      <div className="react-flow__nodesselection nopan"><div id="selection" /></div>
      <svg><g className="react-flow__edge" data-id="edge"><path id="edge" /></g></svg>
      <div className="react-flow__controls"><span id="controls">controls</span></div>
      <div className="react-flow__minimap"><span id="minimap">map</span></div>
      <div className="studio-context-menu"><span id="menu">menu</span></div>
      <div className="studio-block-picker"><span id="picker">picker</span></div>
      <div className="studio-canvas-dock"><span id="dock">dock</span></div>
    </div>
  </div>;
}`;

async function fixture(extra = {}) {
  const f = await reactFixture(entry);
  const state = { viewport: { x: 100, y: -50, zoom: 1.3 }, moves: [], starts: 0, ends: [], clicks: [] };
  const flow = {
    getViewport: () => ({ ...state.viewport }),
    setViewport: (viewport, options) => { state.viewport = { ...viewport }; state.moves.push({ viewport: { ...viewport }, options }); return Promise.resolve(true); },
  };
  await f.render(f.React.createElement(f.exports.Harness, {
    getFlow: () => flow,
    onStart: () => { state.starts++; },
    onEnd: (event, viewport) => state.ends.push({ event, viewport: { ...viewport } }),
    onClick: (event, target) => state.clicks.push({ event, target }),
    ...extra,
  }));
  return Object.assign(f, { state, byId: id => f.container.querySelector(`#${id}`) });
}

async function mouse(f, target, type, options = {}) {
  const event = new f.dom.window.MouseEvent(type, { bubbles: true, cancelable: true, button: 2, buttons: type === 'mouseup' ? 0 : 2, clientX: 200, clientY: 100, ...options });
  await f.act(async () => target.dispatchEvent(event));
  return event;
}

test('right drag pans from background, blocks, summary, selection and SVG edge without moving blocks', async () => {
  const f = await fixture();
  try {
    for (const id of ['pane', 'node', 'summary', 'selection', 'edge']) {
      const initial = { ...f.state.viewport }, beforeMoves = f.state.moves.length, beforeEnds = f.state.ends.length;
      const down = await mouse(f, f.byId(id), 'mousedown');
      assert.equal(down.defaultPrevented, true);
      await mouse(f, f.dom.window, 'mousemove', { clientX: 240, clientY: 80 });
      assert.equal(f.byId('canvas').dataset.panning, 'true');
      assert.deepEqual(f.state.viewport, { x: initial.x + 40, y: initial.y - 20, zoom: initial.zoom });
      assert.deepEqual(f.state.moves.at(-1).options, { duration: 0 });
      await mouse(f, f.dom.window, 'mouseup', { clientX: 240, clientY: 80 });
      assert.equal(f.byId('canvas').dataset.panning, 'false');
      assert.equal(f.state.moves.length, beforeMoves + 1);
      assert.equal(f.state.ends.length, beforeEnds + 1);
      assert.equal(f.state.clicks.length, 0);
      assert.equal(f.byId('node').parentElement.getAttribute('data-id'), 'condition');
    }
  } finally { await f.close(); }
});

test('stationary right click opens original target once despite down/up native contextmenu ordering', async () => {
  const f = await fixture();
  try {
    const target = f.byId('node');
    let bubbledMenus = 0; target.addEventListener('contextmenu', () => { bubbledMenus++; });
    await mouse(f, target, 'mousedown');
    assert.equal((await mouse(f, target, 'contextmenu')).defaultPrevented, true);
    await mouse(f, f.dom.window, 'mousemove', { clientX: 203, clientY: 104 });
    assert.equal(f.state.moves.length, 0, 'five-pixel click jitter does not pan');
    await mouse(f, f.dom.window, 'mouseup', { clientX: 203, clientY: 104 });
    assert.equal(f.state.clicks.length, 1);
    assert.equal(f.state.clicks[0].target, target);
    assert.equal(f.state.ends.length, 0);
    assert.equal((await mouse(f, target, 'contextmenu')).defaultPrevented, true);
    assert.equal(bubbledMenus, 0, 'native contextmenu does not duplicate the callback menu');
  } finally { await f.close(); }
});

test('text fields and canvas control surfaces retain native right-click behavior', async () => {
  const f = await fixture();
  try {
    for (const id of ['input', 'textarea', 'select', 'editable', 'gear', 'controls', 'minimap', 'menu', 'picker', 'dock']) {
      assert.equal((await mouse(f, f.byId(id), 'mousedown')).defaultPrevented, false, id);
      assert.equal((await mouse(f, f.byId(id), 'contextmenu')).defaultPrevented, false, id);
      await mouse(f, f.dom.window, 'mouseup');
    }
    assert.equal(f.state.starts, 0); assert.equal(f.state.moves.length, 0); assert.equal(f.state.clicks.length, 0);
  } finally { await f.close(); }
});

test('new right press in an input clears delayed menu suppression from the preceding canvas click', async () => {
  const f = await fixture();
  try {
    await mouse(f, f.byId('pane'), 'mousedown'); await mouse(f, f.dom.window, 'mouseup');
    await mouse(f, f.byId('input'), 'mousedown');
    assert.equal((await mouse(f, f.byId('input'), 'contextmenu')).defaultPrevented, false);
    assert.equal(f.state.clicks.length, 1);
  } finally { await f.close(); }
});

test('left/middle presses, disabled hook and unavailable flow do not intercept existing canvas behavior', async () => {
  const f = await fixture();
  try {
    for (const button of [0, 1]) assert.equal((await mouse(f, f.byId('pane'), 'mousedown', { button, buttons: 1 << button })).defaultPrevented, false);
    assert.equal(f.state.starts, 0);
  } finally { await f.close(); }
  for (const extra of [{ enabled: false }, { getFlow: () => null }]) {
    const disabled = await fixture(extra);
    try { assert.equal((await mouse(disabled, disabled.byId('pane'), 'mousedown')).defaultPrevented, false); }
    finally { await disabled.close(); }
  }
});

test('blur, pointer cancellation and lost right button terminate dragging without opening a menu', async () => {
  const f = await fixture();
  try {
    for (const ending of ['blur', 'pointercancel', 'lost-button']) {
      await mouse(f, f.byId('node'), 'mousedown');
      await mouse(f, f.dom.window, 'mousemove', { clientX: 260, clientY: 100 });
      const before = f.state.moves.length, beforeEnds = f.state.ends.length;
      if (ending === 'lost-button') await mouse(f, f.dom.window, 'mousemove', { clientX: 270, buttons: 0 });
      else await f.act(async () => f.dom.window.dispatchEvent(new f.dom.window.Event(ending, { bubbles: true })));
      assert.equal(f.byId('canvas').dataset.panning, 'false');
      assert.equal(f.state.ends.length, beforeEnds + 1);
      assert.equal(f.state.clicks.length, 0);
      await mouse(f, f.dom.window, 'mousemove', { clientX: 300, clientY: 100 });
      assert.equal(f.state.moves.length, before);
    }
  } finally { await f.close(); }
});

test('unmount removes gesture listeners and does not deliver a stale completion callback', async () => {
  const f = await fixture();
  try {
    await mouse(f, f.byId('node'), 'mousedown');
    await mouse(f, f.dom.window, 'mousemove', { clientX: 260, clientY: 100 });
    const before = f.state.moves.length;
    await f.render(null);
    assert.equal((await mouse(f, f.dom.window, 'mouseup')).defaultPrevented, false);
    await mouse(f, f.dom.window, 'mousemove', { clientX: 300, clientY: 100 });
    assert.equal(f.state.moves.length, before); assert.equal(f.state.ends.length, 0); assert.equal(f.state.clicks.length, 0);
  } finally { await f.close(); }
});
