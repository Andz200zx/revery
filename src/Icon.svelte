<script>
  let { name, size = 20, stroke = 1.7 } = $props();
  const paths = {
    shuffle: ['M17 3h4v4', 'M3 21 21 3', 'M17 21h4v-4', 'M3 3l6 6', 'M15 15l6 6'],
    arrow: ['M4 12h16', 'm14 6 6 6-6 6'],
    heart: ['M20.8 4.6a5.5 5.5 0 0 0-7.8 0L12 5.7l-1.1-1.1a5.5 5.5 0 0 0-7.8 7.8L12 21l8.8-8.6a5.5 5.5 0 0 0 0-7.8Z'],
    undo: ['M3 8h10a6 6 0 0 1 0 12', 'm7 4-4 4 4 4'],
    info: ['M12 11v6', 'M12 7h.01'],
    external: ['M14 3h7v7', 'm10 14 11-11', 'M10 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-5'],
    expand: ['M8 3H3v5', 'M16 3h5v5', 'M3 16v5h5', 'M21 16v5h-5'],
    close: ['m6 6 12 12', 'M18 6 6 18'],
    trash: ['M3 6h18', 'M9 6V3h6v3', 'm5 6 1 15h12l1-15', 'M10 10v7', 'M14 10v7'],
    check: ['m5 12 4 4L19 6'],
    settings: ['M4 6h16', 'M4 12h16', 'M4 18h16', 'M8 3v6', 'M16 9v6', 'M10 15v6'],
    pin: ['M20 10c0 6-8 12-8 12S4 16 4 10a8 8 0 1 1 16 0Z'],
    calendar: ['M8 2v4', 'M16 2v4', 'M3 10h18', 'M5 4h14a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2Z'],
    camera: ['m3 7 4 0 2-3h6l2 3h4v13H3Z'],
    lock: ['M7 10V7a5 5 0 0 1 10 0v3', 'M5 10h14v11H5Z', 'M12 14v3'],
    spark: ['m12 3 2.3 6.7L21 12l-6.7 2.3L12 21l-2.3-6.7L3 12l6.7-2.3Z'],
    plus: ['M12 5v14', 'M5 12h14'],
    minus: ['M5 12h14'],
    back: ['M20 12H4', 'm10 6-6 6 6 6'],
  };
</script>

<svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width={stroke} stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
  {#if name === 'info'}<circle cx="12" cy="12" r="9" />{/if}
  {#if name === 'camera'}<circle cx="12" cy="13" r="3.5" />{/if}
  {#if name === 'pin'}<circle cx="12" cy="10" r="2.5" />{/if}
  {#each paths[name] || paths.spark as path}<path d={path} />{/each}
</svg>
