<script lang="ts">
  import { onMount, onDestroy, tick } from 'svelte';
  import { exportWebm } from './lib/exportVideo';
  import {
    DEFAULT_RENDER_OPTIONS,
    drawMeme,
    resolveOutputSize,
    type DrawableSource,
    type MediaFit,
    type RenderOptions,
  } from './lib/render';
  import bubbleTemplateUrl from '../speech_bubble_Blank.jpg';

  type MediaKind = 'none' | 'image' | 'video';

  let canvas: HTMLCanvasElement;
  let fileInput: HTMLInputElement;
  let currentUrl = '';
  let fileName = '';
  let mediaKind: MediaKind = 'none';
  let mediaSource: DrawableSource | null = null;
  let videoSource: HTMLVideoElement | null = null;
  let status = '上傳一個圖片或影片開始製作';
  let isExporting = false;
  let exportProgress = 0;
  let frameRequest = 0;

  let ratio = '4:5';
  let bubbleImage: HTMLImageElement | HTMLCanvasElement | null = null;
  let renderOptions: RenderOptions = DEFAULT_RENDER_OPTIONS;

  onMount(() => {
    const img = new Image();
    img.src = bubbleTemplateUrl;
    img.onload = () => {
      const canvasEl = document.createElement('canvas');
      canvasEl.width = img.naturalWidth;
      canvasEl.height = img.naturalHeight;
      const ctx = canvasEl.getContext('2d');
      if (ctx) {
        ctx.drawImage(img, 0, 0);
        const imgData = ctx.getImageData(0, 0, canvasEl.width, canvasEl.height);
        const data = imgData.data;
        for (let i = 0; i < data.length; i += 4) {
          const r = data[i];
          const g = data[i+1];
          const b = data[i+2];
          // If pixel is close to white (RGB > 220), force it to pure white #ffffff
          if (r > 220 && g > 220 && b > 220) {
            data[i] = 255;
            data[i+1] = 255;
            data[i+2] = 255;
          }
        }
        ctx.putImageData(imgData, 0, 0);
        bubbleImage = canvasEl;
      } else {
        bubbleImage = img;
      }
      renderPreview();
    };
  });

  // Crop state (values from 0 to 1 relative to natural size)
  let cropX = 0;
  let cropY = 0;
  let cropWidth = 1;
  let cropHeight = 1;

  // Track natural sizes and target ratio to know when to auto-init crop
  let lastNaturalWidth = 0;
  let lastNaturalHeight = 0;
  let lastTargetRatio = 0;

  // Display size state for rendering the crop box inside the panel
  let cropperContainer: HTMLDivElement;
  let cropperMedia: HTMLElement | null = null;
  let displayWidth = 0;
  let displayHeight = 0;
  let displayLeft = 0;
  let displayTop = 0;

  // Drag-and-drop state
  let isDraggingFile = false;

  $: size = resolveOutputSize(ratio);
  $: bubbleHeight = Math.round(size.width * (127 / 395));

  $: naturalWidth = mediaSource
    ? (mediaSource instanceof HTMLVideoElement ? mediaSource.videoWidth : mediaSource.naturalWidth)
    : 0;
  $: naturalHeight = mediaSource
    ? (mediaSource instanceof HTMLVideoElement ? mediaSource.videoHeight : mediaSource.naturalHeight)
    : 0;
  $: targetRatio = size.width / (size.height - bubbleHeight);

  $: if (
    naturalWidth && naturalHeight && targetRatio &&
    (naturalWidth !== lastNaturalWidth ||
     naturalHeight !== lastNaturalHeight ||
     Math.abs(targetRatio - lastTargetRatio) > 0.001)
  ) {
    lastNaturalWidth = naturalWidth;
    lastNaturalHeight = naturalHeight;
    lastTargetRatio = targetRatio;
    initCropBox();
  }

  $: renderCropX = Math.round(cropX * naturalWidth);
  $: renderCropY = Math.round(cropY * naturalHeight);
  $: renderCropWidth = Math.round(cropWidth * naturalWidth);
  $: renderCropHeight = Math.round(cropHeight * naturalHeight);

  $: renderOptions = {
    ...DEFAULT_RENDER_OPTIONS,
    width: size.width,
    height: size.height,
    bubbleHeight,
    bubbleImage,
    cropX: renderCropX,
    cropY: renderCropY,
    cropWidth: renderCropWidth,
    cropHeight: renderCropHeight,
  };

  $: if (canvas && renderOptions) {
    mediaSource;
    renderPreview();
  }

  // Interactive crop box calculations in display coordinates
  $: cropBoxLeft = displayLeft + cropX * displayWidth;
  $: cropBoxTop = displayTop + cropY * displayHeight;
  $: cropBoxWidth = cropWidth * displayWidth;
  $: cropBoxHeight = cropHeight * displayHeight;

  onDestroy(() => {
    stopPreviewLoop();
    releaseUrl();
  });

  function initCropBox() {
    if (!naturalWidth || !naturalHeight) return;

    const R_natural = naturalWidth / naturalHeight;
    const R_target = targetRatio;

    if (R_natural > R_target) {
      // Natural is wider than target. Fit height, crop width.
      const wPixels = naturalHeight * R_target;
      cropWidth = wPixels / naturalWidth;
      cropHeight = 1;
      cropX = (naturalWidth - wPixels) / 2 / naturalWidth;
      cropY = 0;
    } else {
      // Natural is taller than target. Fit width, crop height.
      const hPixels = naturalWidth / R_target;
      cropWidth = 1;
      cropHeight = hPixels / naturalHeight;
      cropX = 0;
      cropY = (naturalHeight - hPixels) / 2 / naturalHeight;
    }
  }

  function updateDisplaySize() {
    if (!cropperMedia || !cropperContainer) return;
    const rect = cropperMedia.getBoundingClientRect();
    const containerRect = cropperContainer.getBoundingClientRect();
    
    displayWidth = rect.width;
    displayHeight = rect.height;
    displayLeft = rect.left - containerRect.left;
    displayTop = rect.top - containerRect.top;
  }

  // Dragging and resizing variables
  let dragMode: 'none' | 'move' | 'resize' = 'none';
  let activeHandle: 'tl' | 'tr' | 'bl' | 'br' = 'br';
  let dragStartX = 0;
  let dragStartY = 0;
  let dragStartCropX = 0;
  let dragStartCropY = 0;
  let dragStartCropWidth = 0;
  let dragStartCropHeight = 0;

  function handleBoxMouseDown(event: MouseEvent) {
    if (event.target !== event.currentTarget && !(event.target as HTMLElement).classList.contains('crop-box-border')) {
      return;
    }
    event.preventDefault();
    startDrag(event.clientX, event.clientY, 'move');
  }

  function handleBoxTouchStart(event: TouchEvent) {
    if (event.target !== event.currentTarget && !(event.target as HTMLElement).classList.contains('crop-box-border')) {
      return;
    }
    const touch = event.touches[0];
    startDrag(touch.clientX, touch.clientY, 'move');
  }

  function handleHandleMouseDown(event: MouseEvent, handle: 'tl' | 'tr' | 'bl' | 'br') {
    event.stopPropagation();
    event.preventDefault();
    startDrag(event.clientX, event.clientY, 'resize', handle);
  }

  function handleHandleTouchStart(event: TouchEvent, handle: 'tl' | 'tr' | 'bl' | 'br') {
    event.stopPropagation();
    const touch = event.touches[0];
    startDrag(touch.clientX, touch.clientY, 'resize', handle);
  }

  function startDrag(clientX: number, clientY: number, mode: 'move' | 'resize', handle?: 'tl' | 'tr' | 'bl' | 'br') {
    updateDisplaySize();
    dragMode = mode;
    if (handle) activeHandle = handle;
    
    dragStartX = clientX;
    dragStartY = clientY;
    
    dragStartCropX = cropX;
    dragStartCropY = cropY;
    dragStartCropWidth = cropWidth;
    dragStartCropHeight = cropHeight;
  }

  function handleCropperMove(clientX: number, clientY: number) {
    if (dragMode === 'none' || !displayWidth || !displayHeight) return;

    const deltaX = (clientX - dragStartX) / displayWidth;
    const deltaY = (clientY - dragStartY) / displayHeight;

    if (dragMode === 'move') {
      let newX = dragStartCropX + deltaX;
      let newY = dragStartCropY + deltaY;

      newX = Math.max(0, Math.min(1 - dragStartCropWidth, newX));
      newY = Math.max(0, Math.min(1 - dragStartCropHeight, newY));

      cropX = newX;
      cropY = newY;
    } else if (dragMode === 'resize') {
      const ratioScale = targetRatio * (naturalHeight / naturalWidth);

      let newWidth = dragStartCropWidth;
      let newHeight = dragStartCropHeight;

      if (activeHandle === 'br') {
        newWidth = dragStartCropWidth + deltaX;
        newWidth = Math.max(0.05, Math.min(1 - dragStartCropX, newWidth));
        newHeight = newWidth / ratioScale;
        
        if (dragStartCropY + newHeight > 1) {
          newHeight = 1 - dragStartCropY;
          newWidth = newHeight * ratioScale;
        }
        
        cropWidth = newWidth;
        cropHeight = newHeight;
      } else if (activeHandle === 'bl') {
        newWidth = dragStartCropWidth - deltaX;
        if (dragStartCropX + dragStartCropWidth - newWidth < 0) {
          newWidth = dragStartCropX + dragStartCropWidth;
        }
        newWidth = Math.max(0.05, newWidth);
        newHeight = newWidth / ratioScale;

        if (dragStartCropY + newHeight > 1) {
          newHeight = 1 - dragStartCropY;
          newWidth = newHeight * ratioScale;
        }

        cropX = dragStartCropX + dragStartCropWidth - newWidth;
        cropWidth = newWidth;
        cropHeight = newHeight;
      } else if (activeHandle === 'tr') {
        newHeight = dragStartCropHeight - deltaY;
        if (dragStartCropY + dragStartCropHeight - newHeight < 0) {
          newHeight = dragStartCropY + dragStartCropHeight;
        }
        newHeight = Math.max(0.05, newHeight);
        newWidth = newHeight * ratioScale;

        if (dragStartCropX + newWidth > 1) {
          newWidth = 1 - dragStartCropX;
          newHeight = newWidth / ratioScale;
        }

        cropY = dragStartCropY + dragStartCropHeight - newHeight;
        cropWidth = newWidth;
        cropHeight = newHeight;
      } else if (activeHandle === 'tl') {
        newWidth = dragStartCropWidth - deltaX;
        if (dragStartCropX + dragStartCropWidth - newWidth < 0) {
          newWidth = dragStartCropX + dragStartCropWidth;
        }
        newWidth = Math.max(0.05, newWidth);
        newHeight = newWidth / ratioScale;

        if (dragStartCropY + dragStartCropHeight - newHeight < 0) {
          newHeight = dragStartCropY + dragStartCropHeight;
          newWidth = newHeight * ratioScale;
        }

        cropX = dragStartCropX + dragStartCropWidth - newWidth;
        cropY = dragStartCropY + dragStartCropHeight - newHeight;
        cropWidth = newWidth;
        cropHeight = newHeight;
      }
    }
    
    renderPreview();
  }

  function handleCropperMouseMove(event: MouseEvent) {
    if (dragMode === 'none') return;
    handleCropperMove(event.clientX, event.clientY);
  }

  function handleCropperTouchMove(event: TouchEvent) {
    if (dragMode === 'none') return;
    const touch = event.touches[0];
    handleCropperMove(touch.clientX, touch.clientY);
  }

  function handleCropperMouseUp() {
    dragMode = 'none';
  }

  // File Upload Handlers (including drag-and-drop)
  async function loadFile(file: File) {
    stopPreviewLoop();
    releaseUrl();
    resetPosition();

    fileName = file.name;
    currentUrl = URL.createObjectURL(file);
    status = '正在讀取媒體';

    try {
      if (file.type.startsWith('video/')) {
        await loadVideo(currentUrl);
      } else if (file.type.startsWith('image/')) {
        await loadImage(currentUrl);
      } else {
        throw new Error('請上傳圖片或影片檔案。');
      }
      status = mediaKind === 'video' ? '影片已載入，可下載 WebM' : '圖片已載入，可下載 PNG';
      await tick();
      initCropBox();
      renderPreview();
    } catch (error) {
      status = error instanceof Error ? error.message : '媒體讀取失敗。';
      mediaKind = 'none';
      mediaSource = null;
      videoSource = null;
      renderPreview();
    }
  }

  async function handleFileChange(event: Event) {
    const input = event.currentTarget as HTMLInputElement;
    const file = input.files?.[0];
    if (file) {
      await loadFile(file);
    }
  }

  function handleDragOver(event: DragEvent) {
    event.preventDefault();
    isDraggingFile = true;
  }

  function handleDragLeave() {
    isDraggingFile = false;
  }

  async function handleDrop(event: DragEvent) {
    event.preventDefault();
    isDraggingFile = false;
    const file = event.dataTransfer?.files?.[0];
    if (file) {
      await loadFile(file);
    }
  }

  async function loadImage(url: string) {
    const image = new Image();
    image.src = url;
    await image.decode();
    mediaKind = 'image';
    mediaSource = image;
    videoSource = null;
  }

  async function loadVideo(url: string) {
    const video = document.createElement('video');
    video.src = url;
    video.muted = true;
    video.loop = true;
    video.playsInline = true;
    video.preload = 'auto';

    await waitForVideoMetadata(video);
    await video.play().catch(() => undefined);

    mediaKind = 'video';
    mediaSource = video;
    videoSource = video;
    startPreviewLoop();
  }

  function waitForVideoMetadata(video: HTMLVideoElement) {
    return new Promise<void>((resolve, reject) => {
      const done = () => {
        cleanup();
        resolve();
      };
      const fail = () => {
        cleanup();
        reject(new Error('影片讀取失敗。'));
      };
      const cleanup = () => {
        video.removeEventListener('loadedmetadata', done);
        video.removeEventListener('error', fail);
      };

      if (video.readyState >= 1) {
        resolve();
        return;
      }

      video.addEventListener('loadedmetadata', done, { once: true });
      video.addEventListener('error', fail, { once: true });
    });
  }

  function startPreviewLoop() {
    stopPreviewLoop();
    const draw = () => {
      renderPreview();
      frameRequest = requestAnimationFrame(draw);
    };
    frameRequest = requestAnimationFrame(draw);
  }

  function stopPreviewLoop() {
    if (frameRequest) {
      cancelAnimationFrame(frameRequest);
      frameRequest = 0;
    }
  }

  function renderPreview() {
    if (!canvas) {
      return;
    }

    canvas.width = renderOptions.width;
    canvas.height = renderOptions.height;
    const ctx = canvas.getContext('2d');
    if (!ctx) {
      return;
    }
    drawMeme(ctx, mediaSource, renderOptions);
  }

  function resetPosition() {
    cropX = 0;
    cropY = 0;
    cropWidth = 1;
    cropHeight = 1;
    lastNaturalWidth = 0;
  }

  function releaseUrl() {
    if (currentUrl) {
      URL.revokeObjectURL(currentUrl);
      currentUrl = '';
    }
  }

  function chooseFile() {
    fileInput?.click();
  }

  async function downloadImage() {
    if (!canvas || mediaKind === 'none') {
      status = '請先上傳圖片或影片。';
      return;
    }

    renderPreview();
    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/png'));
    if (!blob) {
      status = '圖片輸出失敗。';
      return;
    }
    downloadBlob(blob, 'dialogue-meme.png');
    status = 'PNG 已產生';
  }

  async function downloadVideo() {
    if (!canvas || !videoSource) {
      status = '請先上傳影片。';
      return;
    }

    const ctx = canvas.getContext('2d');
    if (!ctx) {
      status = 'Canvas 初始化失敗。';
      return;
    }

    isExporting = true;
    exportProgress = 0;
    status = '正在產生 WebM 影片';
    stopPreviewLoop();

    try {
      const blob = await exportWebm({
        canvas,
        ctx,
        video: videoSource,
        renderOptions,
        fps: 30,
        onProgress: (progress) => {
          exportProgress = Math.round(progress * 100);
        },
      });
      downloadBlob(blob, 'dialogue-meme.webm');
      status = 'WebM 已產生';
    } catch (error) {
      status = error instanceof Error ? error.message : '影片輸出失敗。';
    } finally {
      isExporting = false;
      exportProgress = 0;
      if (videoSource) {
        await videoSource.play().catch(() => undefined);
        startPreviewLoop();
      }
    }
  }

  function downloadBlob(blob: Blob, name: string) {
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = name;
    anchor.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 500);
  }
</script>

<main class="shell">
  <section class="intro">
    <h1>對話框梗圖產生器</h1>
  </section>

  <section class="workspace">
    <aside class="panel controls-panel" aria-label="控制面板">
      <div class="panel-head">
        <div>
          <p class="eyebrow">INPUT</p>
          <h2>媒體來源</h2>
        </div>
        <button class="icon-button" type="button" aria-label="清除媒體" on:click={() => {
          stopPreviewLoop();
          releaseUrl();
          mediaKind = 'none';
          mediaSource = null;
          videoSource = null;
          fileName = '';
          status = '上傳一個圖片或影片開始製作';
          if (fileInput) fileInput.value = '';
          renderPreview();
        }}>×</button>
      </div>

      <input
        bind:this={fileInput}
        class="visually-hidden"
        type="file"
        accept="image/*,video/*"
        on:change={handleFileChange}
      />

      {#if mediaKind === 'none'}
        <button 
          class="upload-box {isDraggingFile ? 'dragging' : ''}" 
          type="button" 
          on:click={chooseFile}
          on:dragover|preventDefault={handleDragOver}
          on:dragleave={handleDragLeave}
          on:drop|preventDefault={handleDrop}
        >
          <span>選擇或拖放圖片影片</span>
          <small>PNG / JPG / GIF / MP4 / WebM</small>
        </button>
      {/if}

      <div class="control-group">
        <label for="ratio">輸出比例</label>
        <select id="ratio" bind:value={ratio}>
          <option value="4:5">4:5 社群貼文</option>
          <option value="1:1">1:1 正方形</option>
          <option value="16:9">16:9 橫式</option>
          <option value="9:16">9:16 直式</option>
        </select>
      </div>



      {#if mediaKind !== 'none'}
        <div class="crop-workspace-section">
          <p class="eyebrow" style="margin-top: 28px;">CROP</p>
          <h2>調整裁切範圍</h2>
          <p class="crop-tip">可在下方預覽中拖曳框線、調整四角大小</p>

          <div 
            class="cropper-container" 
            role="none"
            bind:this={cropperContainer}
            on:mousemove={handleCropperMouseMove}
            on:mouseup={handleCropperMouseUp}
            on:mouseleave={handleCropperMouseUp}
            on:touchmove={handleCropperTouchMove}
            on:touchend={handleCropperMouseUp}
          >
            {#if mediaKind === 'image'}
              <img 
                src={currentUrl} 
                alt="裁切預覽" 
                class="cropper-media"
                bind:this={cropperMedia}
                on:load={updateDisplaySize}
              />
            {:else if mediaKind === 'video'}
              <video 
                src={currentUrl} 
                muted 
                loop 
                autoplay
                playsinline
                class="cropper-media"
                bind:this={cropperMedia}
                on:loadedmetadata={updateDisplaySize}
              ></video>
            {/if}

            <!-- Shadow masks around the crop area -->
            <div class="cropper-overlay" style="
              clip-path: polygon(
                0% 0%, 0% 100%, 
                {cropBoxLeft}px 100%, 
                {cropBoxLeft}px {cropBoxTop}px, 
                {cropBoxLeft + cropBoxWidth}px {cropBoxTop}px, 
                {cropBoxLeft + cropBoxWidth}px {cropBoxTop + cropBoxHeight}px, 
                {cropBoxLeft}px {cropBoxTop + cropBoxHeight}px, 
                {cropBoxLeft}px 100%, 
                100% 100%, 100% 0%
              );
            "></div>

            <!-- Draggable Crop Box -->
            <div 
              class="crop-box"
              role="none"
              style="
                left: {cropBoxLeft}px; 
                top: {cropBoxTop}px; 
                width: {cropBoxWidth}px; 
                height: {cropBoxHeight}px;
              "
              on:mousedown={handleBoxMouseDown}
              on:touchstart={handleBoxTouchStart}
            >
              <div class="crop-box-border"></div>
              
              <!-- Grid lines for visual guidance -->
              <div class="crop-grid-line crop-grid-h1"></div>
              <div class="crop-grid-line crop-grid-h2"></div>
              <div class="crop-grid-line crop-grid-v1"></div>
              <div class="crop-grid-line crop-grid-v2"></div>

              <!-- Resize handles -->
              <div class="handle top-left" role="none" on:mousedown={(e) => handleHandleMouseDown(e, 'tl')} on:touchstart={(e) => handleHandleTouchStart(e, 'tl')}></div>
              <div class="handle top-right" role="none" on:mousedown={(e) => handleHandleMouseDown(e, 'tr')} on:touchstart={(e) => handleHandleTouchStart(e, 'tr')}></div>
              <div class="handle bottom-left" role="none" on:mousedown={(e) => handleHandleMouseDown(e, 'bl')} on:touchstart={(e) => handleHandleTouchStart(e, 'bl')}></div>
              <div class="handle bottom-right" role="none" on:mousedown={(e) => handleHandleMouseDown(e, 'br')} on:touchstart={(e) => handleHandleTouchStart(e, 'br')}></div>
            </div>
          </div>

          <div class="crop-actions">
            <button class="secondary" type="button" on:click={initCropBox}>重置裁切</button>
          </div>
        </div>
      {/if}
    </aside>

    <section class="panel preview-panel" aria-label="預覽">
      <div class="panel-head">
        <div>
          <p class="eyebrow">PREVIEW</p>
          <h2>{size.width} × {size.height}</h2>
        </div>
        <p class="status">{isExporting ? `輸出中 ${exportProgress}%` : status}</p>
      </div>

      <div class="canvas-wrap">
        <canvas bind:this={canvas} aria-label="梗圖預覽"></canvas>
      </div>

      <div class="actions">
        <button class="primary" type="button" disabled={mediaKind === 'none'} on:click={downloadImage}>下載 PNG</button>
        <button class="primary" type="button" disabled={mediaKind !== 'video' || isExporting} on:click={downloadVideo}>
          {isExporting ? `輸出中 ${exportProgress}%` : '下載 WebM'}
        </button>
      </div>
    </section>
  </section>
</main>
