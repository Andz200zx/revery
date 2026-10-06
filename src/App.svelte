<script>
  import { onMount } from 'svelte';
  import Icon from './Icon.svelte';
  import Zoomable from './Zoomable.svelte';
  import { createPhotoCache } from './photos.js';

  let session = $state(null), booting = $state(true), queue = $state([]), history = $state([]);
  let stats = $state({ reviewed: 0, trashed: 0 }), libraryName = $state('Your library');
  let busy = $state(false), fetching = $state(false), exhausted = $state(false), searching = $state(false);
  let error = $state(''), toast = $state(''), password = $state(''), loggingIn = $state(false);
  let mode = $state('discover'), panel = $state(null), dialog, cleanupApproved = false;
  let photo = $state(null), imageReady = $state(false), imageError = $state(''), scale = $state(1);
  let renderedSize = $state(null), immersive = $state(false), zoomView = $state(null);
  let retryRequest = $state(null), favoriteBusy = $state(false);
  let loadedId = null, toastTimer, deckVersion = 0;
  const consumed = new Set();
  const photos = createPhotoCache();
  const current = $derived(queue[0] ?? null);
  const cleanup = $derived(mode === 'cleanup');
  const qualityLabel = $derived(!photo ? (imageError ? 'Preview resolution' : 'Loading full resolution') : photo.quality === 'demo' ? 'Sample photograph' : photo.quality === 'original' ? 'Original resolution' : photo.quality === 'preview' || isReduced() ? 'Preview resolution' : 'Full resolution');

  function isReduced() {
    if (!current?.width || !current?.height || !renderedSize) return false;
    const expected = [current.width, current.height].sort((a, b) => a - b);
    const actual = [renderedSize.width, renderedSize.height].sort((a, b) => a - b);
    return actual[0] < expected[0] * .98 || actual[1] < expected[1] * .98;
  }
  function uid() {
    const bytes = crypto.getRandomValues(new Uint8Array(16)); bytes[6] = bytes[6] & 15 | 64; bytes[8] = bytes[8] & 63 | 128;
    const hex = [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('');
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  }
  async function api(path, body) {
    const response = await fetch(`/api/${path}`, { method: body === undefined ? 'GET' : 'POST', cache: 'no-store',
      headers: body === undefined ? {} : { 'content-type': 'application/json', 'x-csrf-token': session?.csrf || '' },
      body: body === undefined ? undefined : JSON.stringify(body) });
    const result = await response.json();
    if (!response.ok) {
      if (response.status === 401 && path !== 'login') { session = null; queue = []; photos.clear(); loadedId = null; photo = null; retryRequest = null; }
      const failure = new Error(result.error || 'Please try again.'); failure.status = response.status; throw failure;
    }
    return result;
  }
  function notify(message) { toast = message; clearTimeout(toastTimer); toastTimer = setTimeout(() => { toast = ''; }, 4200); }
  function dateText(asset, long = false) {
    if (!asset?.takenAt) return 'A moment from your library';
    const date = new Date(asset.takenAt);
    if (Number.isNaN(date.getTime())) return 'A moment from your library';
    return new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: long ? 'long' : 'short', year: 'numeric' }).format(date);
  }
  function yearsAgo(asset) {
    if (!asset?.takenAt) return 'FROM YOUR LIBRARY';
    const years = Math.floor((Date.now() - new Date(asset.takenAt).getTime()) / (365.25 * 86400000));
    return years >= 1 ? `${years} ${years === 1 ? 'YEAR' : 'YEARS'} AGO` : 'A RECENT MEMORY';
  }
  function fileSize(bytes) { return bytes ? `${(bytes / 1048576).toFixed(1)} MB` : 'Unavailable'; }
  async function loadLibrary() {
    const result = await api('library');
    libraryName = result.name; stats = result.stats; history = result.history;
    if (result.pending?.length) {
      const pending = result.pending[0];
      retryRequest = { id: pending.asset.id, action: pending.action, requestId: pending.id };
      if (pending.action === 'trash') { mode = 'cleanup'; cleanupApproved = true; }
      queue = [pending.asset];
      error = 'An earlier action needs a retry to check its result in Immich.';
    }
    await replenish();
  }
  async function replenish() {
    if (fetching || exhausted || !session?.authenticated) return;
    fetching = true; searching = false;
    const version = deckVersion;
    try {
      for (let attempt = 0; attempt < 8; attempt++) {
        const excluded = queue.map((asset) => asset.id).join(',');
        const result = await api(`deck?exclude=${encodeURIComponent(excluded)}`);
        if (version !== deckVersion) return;
        const ids = new Set(queue.map((asset) => asset.id));
        const fresh = result.assets.filter((asset) => !ids.has(asset.id) && !consumed.has(asset.id));
        queue = [...queue, ...fresh]; exhausted = result.exhausted;
        if (fresh.length || exhausted || result.waiting) break;
        searching = true;
        if (attempt < 7) await new Promise((resolve) => setTimeout(resolve, 150));
      }
    } catch (failure) { error = failure.message; }
    finally { if (version === deckVersion) fetching = false; }
  }
  async function bootstrap() {
    try { session = await api('session'); if (session.authenticated) await loadLibrary(); }
    catch (failure) { error = failure.message; }
    finally { booting = false; }
  }
  onMount(() => {
    bootstrap();
    if ('serviceWorker' in navigator && import.meta.env.PROD) navigator.serviceWorker.register('/sw.js').catch(() => {});
    return () => { photos.clear(); clearTimeout(toastTimer); };
  });
  $effect(() => {
    if (!current || current.id === loadedId) return;
    const asset = current;
    loadedId = asset.id; photo = null; imageReady = false; imageError = ''; renderedSize = null;
    photos.load(asset).then((result) => { if (current?.id === asset.id) photo = result; })
      .catch((failure) => { if (failure.name !== 'AbortError' && current?.id === asset.id) imageError = failure.message; });
  });
  $effect(() => {
    const ids = queue.slice(0, 2).map((asset) => asset.id); photos.retain(ids);
    const next = queue[1];
    if (next) photos.load(next).catch(() => {});
  });
  $effect(() => {
    if (panel && dialog && !dialog.open) dialog.showModal();
    else if (!panel && dialog?.open) dialog.close();
  });
  $effect(() => {
    document.documentElement.classList.toggle('photo-immersive', immersive);
    const theme = document.querySelector('meta[name="theme-color"]');
    theme?.setAttribute('content', immersive ? '#101716' : '#f6f5f0');
    return () => {
      document.documentElement.classList.remove('photo-immersive');
      theme?.setAttribute('content', '#f6f5f0');
    };
  });
  async function login(event) {
    event.preventDefault(); loggingIn = true; error = '';
    try { session = await api('login', { password }); password = ''; await loadLibrary(); }
    catch (failure) { error = failure.message; }
    finally { loggingIn = false; }
  }
  async function retryPhoto() {
    const asset = current; if (!asset) return;
    imageError = '';
    try { const result = await photos.load(asset); if (current?.id === asset.id) photo = result; }
    catch (failure) { if (current?.id === asset.id && failure.name !== 'AbortError') imageError = failure.message; }
  }
  async function review(action = 'keep') {
    if (!current || busy || scale > 1.02 || panel || favoriteBusy) return;
    if (action === 'trash' && (!session.canTrash || (!retryRequest && (!cleanup || !imageReady)))) return;
    if (retryRequest && retryRequest.action !== action) { error = 'Retry the unfinished action before continuing.'; return; }
    const asset = current;
    busy = true; error = '';
    const request = retryRequest || { id: asset.id, action, requestId: uid() };
    retryRequest = request;
    try {
      const result = await api('review', request);
      stats = result.stats; history = [{ id: result.eventId, action, asset }, ...history].slice(0, 30);
      consumed.add(asset.id); retryRequest = null;
      queue = queue.filter((item) => item.id !== asset.id);
      if (action === 'trash') notify(session.demo ? 'Moved to sample trash. Undo is available.' : 'Moved to Immich trash. Undo is available.');
      if (queue.length < 5) { exhausted = false; replenish(); }
    } catch (failure) {
      error = failure.message;
      if ([400, 403, 404].includes(failure.status)) retryRequest = null;
      if (failure.status === 409 && /already been reviewed|already in Immich trash/.test(failure.message)) {
        retryRequest = null; consumed.add(asset.id); queue = queue.filter((item) => item.id !== asset.id);
        exhausted = false; replenish();
      }
    }
    finally { busy = false; }
  }
  async function undo() {
    if (!history.length || busy || retryRequest || favoriteBusy) return;
    busy = true; error = '';
    const event = history[0];
    try {
      const result = await api('undo', { eventId: event.id });
      stats = result.stats; history = history.slice(1); consumed.delete(result.asset.id);
      queue = [result.asset, ...queue.filter((asset) => asset.id !== result.asset.id)];
      exhausted = false; notify(event.action === 'trash' ? 'Photograph restored.' : 'Back to that moment.');
    } catch (failure) { error = failure.message; }
    finally { busy = false; }
  }
  async function favorite() {
    if (!current || busy || favoriteBusy || retryRequest || !session?.canFavorite) return;
    const asset = current; favoriteBusy = true;
    try {
      const result = await api('favorite', { id: asset.id, favorite: !asset.favorite });
      queue = queue.map((item) => item.id === asset.id ? { ...item, favorite: result.favorite } : item);
      notify(result.favorite ? (session.demo ? 'A sample favourite.' : 'Added to your Immich favourites.') : 'Removed from favourites.');
    } catch (failure) { error = failure.message; }
    finally { favoriteBusy = false; }
  }
  function switchMode(next) {
    if (busy || retryRequest) return;
    if (next === 'cleanup' && !cleanupApproved) { panel = 'cleanup'; return; }
    mode = next; zoomView?.resetZoom();
  }
  async function restart() {
    busy = true; error = '';
    try {
      const result = await api('reset', {});
      deckVersion++; fetching = false; photos.clear(); loadedId = null; queue = []; consumed.clear();
      stats = result.stats; history = history.filter((event) => event.action === 'trash');
      exhausted = false; panel = null; await replenish(); notify('A fresh shuffle.');
    } catch (failure) { error = failure.message; }
    finally { busy = false; }
  }
  async function logout() {
    try { await api('logout', {}); } catch (failure) { error = failure.message; return; }
    deckVersion++; fetching = false; session = null; queue = []; history = []; photo = null; loadedId = null;
    retryRequest = null; consumed.clear(); photos.clear(); panel = null; immersive = false; mode = 'discover';
  }
  function keyboard(event) {
    if (panel || !session?.authenticated || event.target instanceof HTMLInputElement || event.metaKey || event.ctrlKey || event.altKey) return;
    if (event.key === 'Escape') { immersive = false; zoomView?.resetZoom(); }
    else if (event.key === 'ArrowRight' || event.key === ' ') { event.preventDefault(); review('keep'); }
    else if (event.key === 'ArrowLeft' && cleanup) review('trash');
    else if (event.key.toLowerCase() === 'z') undo();
    else if (event.key.toLowerCase() === 'f') favorite();
    else if (event.key.toLowerCase() === 'i') panel = 'details';
  }
</script>

<svelte:head>
  <link rel="manifest" href="/manifest.webmanifest" />
  <meta name="apple-mobile-web-app-capable" content="yes" />
  <meta name="apple-mobile-web-app-status-bar-style" content="black-translucent" />
  <meta name="apple-mobile-web-app-title" content="Revery" />
  <link rel="apple-touch-icon" href="/apple-touch-icon.png" />
</svelte:head>
<svelte:window onkeydown={keyboard} />

<div class="app-shell" class:immersive>
  <header class="app-header">
    <a class="brand" href="/" aria-label="Revery home"><span class="brand-mark"><Icon name="spark" size={25} /></span><span>revery<span class="brand-dot">.</span></span></a>
    {#if session?.authenticated}
      <nav class="mode-switch" aria-label="Viewing mode">
        <button class:active={!cleanup} onclick={() => switchMode('discover')} disabled={busy || !!retryRequest}><Icon name="spark" size={15} /><span>Discover</span></button>
        {#if session.canTrash}<button class:active={cleanup} onclick={() => switchMode('cleanup')} disabled={busy || !!retryRequest}><Icon name="trash" size={15} /><span>Tidy up</span></button>{/if}
      </nav>
      <div class="header-right"><span class="connection"><i></i>{session.demo ? 'Demo library' : 'Your Immich'}</span><button class="icon-button" aria-label="Settings" onclick={() => panel = 'settings'}><Icon name="settings" /></button></div>
    {:else}<span class="header-note">Your photographs. A fresh perspective.</span>{/if}
  </header>

  {#if booting}
    <main class="welcome"><div class="loading-ring"></div><p>Finding a little something to remember.</p></main>
  {:else if !session?.authenticated}
    <main class="welcome login-view">
      <div class="welcome-symbol"><Icon name="spark" size={38} stroke={1.3} /></div>
      <p class="eyebrow">THE GOOD THINGS, REDISCOVERED</p><h1>There’s a whole life<br />in your library.</h1>
      <p class="welcome-copy">Take a moment. Find a forgotten favourite.<br />See your photographs in a different light.</p>
      <form onsubmit={login} class="login-form">
        <label for="password">Your Revery password</label>
        <input id="password" type="password" autocomplete="current-password" bind:value={password} required placeholder="Enter your password" />
        {#if error}<p class="form-error" role="alert">{error}</p>{/if}
        <button class="primary-button" disabled={loggingIn}>{loggingIn ? 'Opening your library…' : 'Step inside'}<Icon name="arrow" size={18} /></button>
      </form>
      <p class="private-note"><Icon name="lock" size={13} /> A private window into your Immich library</p>
    </main>
  {:else}
    <main class="discovery">
      <div class="section-heading"><div><p class="eyebrow">{cleanup ? 'A LITTLE ROOM FOR THE GOOD STUFF' : 'THE GOOD THINGS, REDISCOVERED'}</p><h1>{cleanup ? 'Keep what matters.' : 'Look what you found.'}</h1></div><div class="library-context"><Icon name="shuffle" size={16} /><span>All photographs</span><span class="context-separator">/</span><span>{stats.reviewed.toLocaleString()} rediscovered</span></div></div>
      <div class="photo-stack">
        <div class="stack-card"></div>
        <div class="photo-frame">
          {#if current}
            <Zoomable bind:this={zoomView} asset={current} src={photo?.url} previewSrc={current.previewUrl} {cleanup} disabled={busy || !!panel}
              onswipe={(direction) => review(cleanup && direction === 'left' ? 'trash' : 'keep')}
              onzoom={(value) => scale = value} onimage={(value) => { imageReady = true; if (value.full) renderedSize = value; }} />
            <div class="frame-top"><span class="quality-badge" class:loading={!photo}><i></i>{qualityLabel}</span><div class="frame-actions">
              {#if scale > 1.02}<button class="frame-button reset-zoom" onclick={() => zoomView?.resetZoom()} aria-label="Reset photo zoom">{scale.toFixed(1)}× <Icon name="close" size={14} /></button>{/if}
              <button class="frame-button" aria-label={immersive ? 'Exit immersive view' : 'Immersive view'} onclick={() => immersive = !immersive}><Icon name={immersive ? 'close' : 'expand'} size={19} /></button>
            </div></div>
            {#if !imageReady}<div class="photo-loading"><div class="loading-ring"></div><span>Bringing your photograph into focus</span></div>{/if}
            {#if imageError}<div class="image-warning"><Icon name="info" size={15} /><span>{imageError}</span><button onclick={retryPhoto}>Retry image</button></div>{/if}
            <div class="frame-bottom"><span>{yearsAgo(current)}</span><span>{scale > 1.02 ? 'Drag to explore · double tap to reset' : 'Pinch to explore'}</span></div>
          {:else}<div class="empty-photo"><Icon name={exhausted ? 'check' : 'shuffle'} size={38} stroke={1.2} /><h2>{fetching ? 'Finding your next moment.' : exhausted ? 'A little closer to your library.' : 'Your next discovery is waiting.'}</h2><p>{fetching ? 'Looking for a photograph you haven’t seen.' : exhausted ? 'You’ve seen every available photograph in this shuffle.' : error || 'Keep looking for something new.'}</p><button class="soft-button" disabled={fetching || busy} onclick={() => exhausted ? panel = 'restart' : replenish()}>{exhausted ? 'Start a fresh shuffle' : fetching ? 'Finding photographs…' : 'Continue exploring'}<Icon name="arrow" size={17} /></button></div>{/if}
        </div>
      </div>
      <div class="photo-caption">
        <div><h2>{current?.description || dateText(current, true)}</h2><p>{#if current}<span>{dateText(current)}</span>{#if current.location}<span class="caption-dot">·</span><span><Icon name="pin" size={12} />{current.location}</span>{/if}{:else}<span>{libraryName}</span>{/if}</p></div>
        <span class="filename">{current?.filename || 'A fresh perspective, one photograph at a time.'}</span>
      </div>
      {#if error}<div class="error-banner" role="alert"><span>{error}</span><button onclick={() => retryRequest ? review(retryRequest.action) : replenish()} disabled={busy || fetching}>Retry</button><button class="icon-button" aria-label="Dismiss error" onclick={() => error = ''}><Icon name="close" size={15} /></button></div>{/if}
    </main>

    <footer class="bottom-area">
      <div class="control-dock" aria-label="Photo controls">
        <button class="dock-button" aria-label="Undo last action" disabled={!history.length || busy || !!retryRequest} onclick={undo}><Icon name="undo" size={21} /><span>Undo</span></button>
        {#if cleanup}<button class="dock-button trash-button" aria-label="Move photograph to Immich trash" disabled={!current || !imageReady || busy || scale > 1.02 || !!retryRequest} onclick={() => review('trash')}><Icon name="trash" size={21} /><span>Trash</span></button>
        {:else}<button class="dock-button favorite-button" class:hearted={current?.favorite} aria-label={current?.favorite ? 'Remove from favourites' : 'Favourite photograph'} disabled={!current || busy || favoriteBusy || !session.canFavorite || !!retryRequest} onclick={favorite}><Icon name="heart" size={22} /><span>Favourite</span></button>{/if}
        <button class="next-button" disabled={!current || busy || scale > 1.02 || !!retryRequest} onclick={() => review('keep')}><Icon name={cleanup ? 'check' : 'shuffle'} size={21} /><span>{busy ? 'One moment…' : cleanup ? 'Keep photo' : 'Next photo'}</span><Icon name="arrow" size={18} /></button>
        <button class="dock-button" aria-label="Photograph details" disabled={!current} onclick={() => panel = 'details'}><Icon name="info" size={21} /><span>Details</span></button>
        <button class="dock-button" aria-label="Open photograph in Immich" disabled={!current || session.demo} onclick={() => panel = 'open'}><Icon name="external" size={21} /><span>Immich</span></button>
      </div>
      <p class="gesture-hint">{scale > 1.02 ? 'Pinch to zoom · drag to explore · reset to continue' : cleanup ? 'Swipe left to trash · right to keep · undo anytime' : 'Swipe for a new moment. Stay a while when you find one.'}</p>
      <div class="footer-line"><span>{session.demo ? 'SAMPLE PHOTOGRAPHS · ILLUSTRATIVE METADATA' : 'CONNECTED TO YOUR IMMICH LIBRARY'}</span><span>Made for a little rediscovery <span class="tiny-star">✧</span></span></div>
    </footer>
  {/if}
</div>

{#if toast}<div class="toast" role="status"><Icon name="check" size={17} />{toast}</div>{/if}

<dialog bind:this={dialog} class="sheet" oncancel={() => panel = null} onclose={() => panel = null} onclick={(event) => { if (event.target === dialog) panel = null; }}>
  <div class="sheet-inner">
    <div class="sheet-handle"></div><button class="sheet-close icon-button" aria-label="Close panel" onclick={() => panel = null}><Icon name="close" /></button>
    {#if panel === 'details' && current}
      <p class="eyebrow">A CLOSER LOOK</p><h2>{dateText(current, true)}</h2><p class="sheet-description">{current.filename}</p>
      {#if session.demo}<p class="sample-note">Sample photograph; dates and metadata are illustrative.</p>{/if}
      <dl class="details-grid"><div><dt>Location</dt><dd>{current.location || 'Not recorded'}</dd></div><div><dt>Camera</dt><dd>{current.camera || 'Not recorded'}</dd></div><div><dt>Dimensions</dt><dd>{current.width && current.height ? `${current.width.toLocaleString()} × ${current.height.toLocaleString()}` : 'Not recorded'}</dd></div><div><dt>File size</dt><dd>{fileSize(current.size)}</dd></div><div><dt>Lens</dt><dd>{current.lens || 'Not recorded'}</dd></div><div><dt>Exposure</dt><dd>{[current.aperture ? `ƒ/${current.aperture}` : '', current.shutter ? `${current.shutter} s` : '', current.iso ? `ISO ${current.iso}` : ''].filter(Boolean).join(' · ') || 'Not recorded'}</dd></div></dl>
      <div class="detail-quality"><Icon name="expand" size={18} /><div><strong>{qualityLabel}</strong><p>{isReduced() || photo?.quality === 'preview' ? 'Enable and regenerate full-size images in Immich to inspect this photograph at full resolution.' : 'Pinch to zoom into the details. Double tap to return.'}</p></div></div>
    {:else if panel === 'open' && current}
      <p class="eyebrow">KEEP EXPLORING</p><h2>Over to Immich.</h2><p class="sheet-description">Open this photograph in your library.</p>
      <a class="primary-button" href={current.appUrl} onclick={() => panel = null}>Open in the Immich app<Icon name="arrow" size={18} /></a>
      <a class="soft-button full-width" href={current.webUrl} target="_blank" rel="noopener noreferrer" onclick={() => panel = null}>{current.alternateWebUrl ? 'Open Immich on home Wi-Fi' : 'Open Immich in your browser'}<Icon name="external" size={17} /></a>
      {#if current.alternateWebUrl}<a class="soft-button full-width" href={current.alternateWebUrl} target="_blank" rel="noopener noreferrer" onclick={() => panel = null}>Open Immich with Tailscale<Icon name="external" size={17} /></a>{/if}
      <p class="private-note">Your Immich app should be signed into the same account.</p>
    {:else if panel === 'cleanup'}
      <div class="sheet-symbol"><Icon name="trash" size={25} /></div><p class="eyebrow">A LITTLE TIDYING</p><h2>Make room for what matters.</h2><p class="sheet-description">Swipe left to move a photograph to Immich trash. Swipe right to keep it. Undo brings it back.</p>
      <p class="cleanup-note">{session?.demo ? 'This is a demo. Only sample photographs are affected.' : 'Immich can permanently delete items after its configured trash retention period. This changes your server library; photos on your iPhone stay on your iPhone.'}</p>
      <button class="primary-button" onclick={() => { cleanupApproved = true; mode = 'cleanup'; panel = null; zoomView?.resetZoom(); }}>Start tidying<Icon name="arrow" size={18} /></button>
      <button class="text-button" onclick={() => panel = null}>Keep discovering</button>
    {:else if panel === 'settings'}
      <p class="eyebrow">YOUR LITTLE PHOTO ESCAPE</p><h2>A moment for yourself.</h2><p class="sheet-description">{libraryName} · {session?.demo ? 'Demo mode' : 'Connected to Immich'}</p>
      <div class="settings-list"><button onclick={() => panel = 'homescreen'}><Icon name="plus" /><div><strong>Make yourself at home</strong><span>Add Revery to your iPhone home screen</span></div><Icon name="arrow" size={16} /></button><button disabled={busy || !!retryRequest} onclick={() => panel = 'restart'}><Icon name="shuffle" /><div><strong>Start a fresh shuffle</strong><span>Let previously seen photographs surprise you again</span></div><Icon name="arrow" size={16} /></button></div>
      <div class="settings-summary"><span><strong>{stats.reviewed}</strong> rediscovered</span><span><strong>{stats.trashed}</strong> moved to trash</span></div>
      {#if !session?.demo}<button class="text-button" disabled={busy || !!retryRequest} onclick={logout}>Sign out</button>{:else}<p class="sample-note">Demo images are bundled locally. Connect your Immich instance using the server configuration.</p>{/if}
    {:else if panel === 'homescreen'}
      <p class="eyebrow">ALWAYS A MOMENT AWAY</p><h2>Keep Revery close.</h2><p class="sheet-description">In Safari, open Share, choose “Add to Home Screen”, then tap Add. Revery opens with its own icon and a full-screen view.</p><div class="home-icon"><Icon name="spark" size={42} stroke={1.3} /></div><p class="private-note">A secure HTTPS address is recommended for your home-screen app.</p>
    {:else if panel === 'restart'}
      <p class="eyebrow">ANOTHER LOOK</p><h2>Let it surprise you again.</h2><p class="sheet-description">Previously seen photographs will return to the shuffle. Your favourites and Immich trash stay as they are.</p><button class="primary-button" disabled={busy} onclick={restart}>{busy ? 'Starting…' : 'Start a fresh shuffle'}<Icon name="shuffle" size={18} /></button><button class="text-button" onclick={() => panel = null}>Keep my place</button>
    {/if}
  </div>
</dialog>
