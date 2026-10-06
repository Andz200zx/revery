import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PhotoGestures } from '../src/gestures.js';

function viewer() {
  const swipes = [], taps = [];
  const view = new PhotoGestures({ onSwipe: (direction) => swipes.push(direction), onTap: (point) => taps.push(point) });
  view.resize(400, 400, 2400, 2400);
  return { view, swipes, taps };
}
test('pinch keeps the photograph under the moving midpoint', () => {
  const { view } = viewer();
  view.down(1, { x: -25, y: 0 }, 0); view.down(2, { x: 75, y: 0 }, 0);
  view.move(1, { x: -50, y: 20 }); view.move(2, { x: 150, y: 20 });
  assert.equal(view.scale, 2); assert.equal(view.x, 0); assert.equal(view.y, 20);
  assert.equal((50 - view.x) / view.scale, 25);
});
test('lifting a finger after pinching allows pan but never a cleanup swipe', () => {
  const { view, swipes } = viewer();
  view.down(1, { x: -50, y: 0 }, 0); view.down(2, { x: 50, y: 0 }, 0);
  view.move(2, { x: 150, y: 0 }); view.up(2, { x: 150, y: 0 }, 100);
  view.move(1, { x: -300, y: 0 }); view.up(1, { x: -300, y: 0 }, 200);
  assert.equal(view.scale, 2); assert.deepEqual(swipes, []); assert.equal(view.x, -200);
});
test('a zoomed one-finger gesture pans within bounds instead of swiping', () => {
  const { view, swipes } = viewer(); view.zoomAt(3);
  view.down(1, { x: 0, y: 0 }, 0); view.move(1, { x: 900, y: -900 });
  view.up(1, { x: 900, y: -900 }, 100);
  assert.equal(view.x, 400); assert.equal(view.y, -400); assert.deepEqual(swipes, []);
});
test('horizontal swipes in both directions only happen at fit scale', () => {
  const { view, swipes } = viewer();
  for (const x of [-150, 150]) {
    view.down(1, { x: 0, y: 0 }, 0); view.move(1, { x, y: 10 }); view.up(1, { x, y: 10 }, 150);
  }
  assert.deepEqual(swipes, ['left', 'right']); assert.equal(view.drag, 0);
});
test('vertical, short and cancelled drags do not review a photograph', () => {
  const { view, swipes } = viewer();
  for (const [x, y, cancelled] of [[30, 0, false], [100, 150, false], [-200, 0, true]]) {
    view.down(1, { x: 0, y: 0 }, 0); view.move(1, { x, y }); view.up(1, { x, y }, 100, cancelled);
  }
  assert.deepEqual(swipes, []);
});
test('pinching back to fit does not turn the remaining finger into a swipe', () => {
  const { view, swipes } = viewer(); view.zoomAt(2);
  view.down(1, { x: -100, y: 0 }, 0); view.down(2, { x: 100, y: 0 }, 0);
  view.move(1, { x: -50, y: 0 }); view.move(2, { x: 50, y: 0 });
  view.up(2, { x: 50, y: 0 }, 100); view.up(1, { x: -250, y: 0 }, 150);
  assert.equal(view.scale, 1); assert.deepEqual(swipes, []);
});
test('reset and resize return a centred photograph with cleared gesture state', () => {
  const { view } = viewer(); view.zoomAt(5); view.pan(500, 300);
  view.down(1, { x: 0, y: 0 }, 0); view.reset(); view.resize(300, 500, 3000, 2000);
  assert.equal(view.fitWidth, 300); assert.equal(view.fitHeight, 200);
  assert.equal(view.scale, 1); assert.equal(view.x, 0); assert.equal(view.points.size, 0);
});
