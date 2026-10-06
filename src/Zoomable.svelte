<script>
  import { onMount } from 'svelte';
  import { PhotoGestures } from './gestures.js';
  let { asset, src, previewSrc, disabled = false, cleanup = false, onswipe = () => {}, onzoom = () => {}, onimage = () => {} } = $props();
  let viewport;
  let width = 1, height = 1, previousId, lastTap = null, transitionTimer;
  let scale = $state(1), x = $state(0), y = $state(0), drag = $state(0);
  let fitWidth = $state(1), fitHeight = $state(1), animating = $state(false);
  const gestures = new PhotoGestures({
    onChange: (state) => { ({ scale, x, y, drag, fitWidth, fitHeight } = state); },
    onSwipe: (direction) => onswipe(direction),
    onTap: (point, time) => {
      if (lastTap && time - lastTap.time < 300 && Math.hypot(lastTap.point.x - point.x, lastTap.point.y - point.y) < 30) {
        animate();
        if (scale > 1.02) gestures.reset(); else gestures.zoomAt(3, point);
        lastTap = null;
      } else lastTap = { point, time };
    }
  });
  $effect(() => {
    const id = asset?.id;
    if (id !== previousId) {
      previousId = id; lastTap = null; gestures.reset();
      gestures.resize(width, height, asset?.width || 2400, asset?.height || 1600);
    }
  });
  $effect(() => { onzoom(scale); });
  onMount(() => {
    const observer = new ResizeObserver(([entry]) => {
      width = entry.contentRect.width; height = entry.contentRect.height; gestures.resize(width, height);
    });
    observer.observe(viewport);
    return () => { observer.disconnect(); clearTimeout(transitionTimer); };
  });
  function animate() {
    animating = true; clearTimeout(transitionTimer);
    transitionTimer = setTimeout(() => { animating = false; }, 220);
  }
  export function resetZoom() { animate(); lastTap = null; gestures.reset(); }
  export function zoomIn() { animate(); gestures.zoomAt(scale * 1.6); }
  export function zoomOut() { animate(); gestures.zoomAt(scale / 1.6); }
  function point(event) {
    const rect = viewport.getBoundingClientRect();
    return { x: event.clientX - rect.left - width / 2, y: event.clientY - rect.top - height / 2 };
  }
  function pointerDown(event) {
    if (disabled || (event.pointerType === 'mouse' && event.button !== 0)) return;
    animating = false; clearTimeout(transitionTimer);
    viewport.setPointerCapture(event.pointerId); gestures.down(event.pointerId, point(event), performance.now());
    if (gestures.points.size > 1) lastTap = null;
  }
  function pointerMove(event) { gestures.move(event.pointerId, point(event)); }
  function pointerUp(event, cancelled = false) {
    gestures.up(event.pointerId, point(event), performance.now(), cancelled);
    if (!gestures.points.size) animate();
  }
  function wheel(event) {
    if (disabled || (!event.ctrlKey && scale <= 1.02)) return;
    event.preventDefault(); animating = false;
    if (event.ctrlKey) gestures.zoomAt(scale * Math.exp(-event.deltaY * .01), point(event));
    else gestures.pan(-event.deltaX, -event.deltaY);
  }
  function keydown(event) {
    if (!disabled && ['+', '=', '-', '0'].includes(event.key)) {
      event.preventDefault();
      if (event.key === '0') resetZoom(); else if (event.key === '-') zoomOut(); else zoomIn();
    }
  }
  function loaded(event) {
    const image = event.currentTarget;
    gestures.resize(width, height, image.naturalWidth, image.naturalHeight);
    onimage({ width: image.naturalWidth, height: image.naturalHeight, full: !!src });
  }
</script>

<!-- Photo gestures need a keyboard focus target; the application role describes the interactive viewer. -->
<!-- svelte-ignore a11y_no_noninteractive_tabindex, a11y_no_noninteractive_element_interactions -->
<div class="zoom-viewport" class:zoomed={scale > 1.02} bind:this={viewport} role="application" aria-roledescription="interactive photo viewer" aria-label="Photo viewer. Pinch or double tap to zoom. Use plus, minus, and zero keys to control zoom." tabindex="0"
  onpointerdown={pointerDown} onpointermove={pointerMove} onpointerup={pointerUp} onpointercancel={(event) => pointerUp(event, true)} onwheel={wheel} onkeydown={keydown}>
  <img class="zoom-photo" class:animating src={src || previewSrc} alt={asset?.description || asset?.filename || 'Photograph'} draggable="false" onload={loaded}
    style:width={`${fitWidth}px`} style:height={`${fitHeight}px`} style:transform={`translate(-50%, -50%) translate3d(${x + drag}px, ${y}px, 0) scale(${scale}) rotate(${scale <= 1.02 ? drag / 35 : 0}deg)`} />
  {#if Math.abs(drag) > 30}
    <div class="swipe-stamp" class:danger={cleanup && drag < 0} style:opacity={Math.min(1, Math.abs(drag) / 100)}>
      {cleanup ? (drag < 0 ? 'TRASH' : 'KEEP') : 'NEXT PHOTO'}
    </div>
  {/if}
</div>
