export type MediaFit = 'cover' | 'contain';

export type RenderOptions = {
  width: number;
  height: number;
  bubbleHeight: number;
  pointerX: number;
  pointerWidth: number;
  pointerDepth: number;
  lineWidth: number;
  fit: MediaFit;
  bubbleImage: HTMLImageElement | HTMLCanvasElement | null;
  cropX: number;
  cropY: number;
  cropWidth: number;
  cropHeight: number;
};

export type DrawableSource = HTMLImageElement | HTMLVideoElement;

export const DEFAULT_RENDER_OPTIONS: RenderOptions = {
  width: 1080,
  height: 1350,
  bubbleHeight: 260,
  pointerX: 0.5,
  pointerWidth: 150,
  pointerDepth: 190,
  lineWidth: 9,
  fit: 'cover',
  bubbleImage: null,
  cropX: 0,
  cropY: 0,
  cropWidth: 1080,
  cropHeight: 1080,
};

export function drawMeme(
  ctx: CanvasRenderingContext2D,
  source: DrawableSource | null,
  options: RenderOptions,
) {
  const { width, height, bubbleHeight } = options;

  ctx.save();
  ctx.clearRect(0, 0, width, height);
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, width, height);

  drawMedia(ctx, source, options);
  drawBubble(ctx, options);

  ctx.restore();
}

function drawMedia(
  ctx: CanvasRenderingContext2D,
  source: DrawableSource | null,
  options: RenderOptions,
) {
  const { width, height, bubbleHeight } = options;
  const mediaHeight = height - bubbleHeight;

  ctx.fillStyle = '#f3f3f3';
  ctx.fillRect(0, bubbleHeight, width, mediaHeight);

  if (!source) {
    drawPlaceholder(ctx, options);
    return;
  }

  const sourceWidth = source instanceof HTMLVideoElement ? source.videoWidth : source.naturalWidth;
  const sourceHeight = source instanceof HTMLVideoElement ? source.videoHeight : source.naturalHeight;

  if (!sourceWidth || !sourceHeight) {
    drawPlaceholder(ctx, options);
    return;
  }

  ctx.save();
  ctx.beginPath();
  ctx.rect(0, bubbleHeight, width, mediaHeight);
  ctx.clip();
  
  ctx.drawImage(
    source,
    options.cropX,
    options.cropY,
    options.cropWidth,
    options.cropHeight,
    0,
    bubbleHeight,
    width,
    mediaHeight
  );
  
  ctx.restore();
}

function drawPlaceholder(ctx: CanvasRenderingContext2D, options: RenderOptions) {
  const { width, height, bubbleHeight } = options;
  const mediaHeight = height - bubbleHeight;

  ctx.save();
  ctx.fillStyle = '#f7f7f7';
  ctx.fillRect(0, bubbleHeight, width, mediaHeight);
  ctx.strokeStyle = '#d5d5d5';
  ctx.lineWidth = 2;
  ctx.setLineDash([16, 16]);
  ctx.strokeRect(36, bubbleHeight + 36, width - 72, mediaHeight - 72);
  ctx.setLineDash([]);
  ctx.fillStyle = '#777777';
  ctx.font = '700 34px Arial, sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText('UPLOAD IMAGE OR VIDEO', width / 2, bubbleHeight + mediaHeight / 2);
  ctx.restore();
}

function drawBubble(ctx: CanvasRenderingContext2D, options: RenderOptions) {
  const {
    width,
    bubbleHeight,
    bubbleImage,
  } = options;

  ctx.save();

  if (bubbleImage) {
    const naturalWidth = bubbleImage.naturalWidth || 395;
    const naturalHeight = bubbleImage.naturalHeight || 127;
    const imgDrawHeight = width * (naturalHeight / naturalWidth);

    // Fill the area above the image with white
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, width, bubbleHeight - imgDrawHeight);

    // Draw the image at the bottom of the bubble area
    ctx.drawImage(bubbleImage, 0, bubbleHeight - imgDrawHeight, width, imgDrawHeight);
  } else {
    // Fallback: draw vector bubble
    const { pointerX, pointerWidth, pointerDepth, lineWidth } = options;
    const notchX = clamp(pointerX, 0.08, 0.92) * width;
    const halfNotch = pointerWidth / 2;
    const bottomY = bubbleHeight - Math.max(lineWidth, 2);
    const tipY = Math.min(bubbleHeight + pointerDepth, options.height - lineWidth);
    const leftBase = clamp(notchX - halfNotch, lineWidth, width - lineWidth);
    const rightBase = clamp(notchX + halfNotch, lineWidth, width - lineWidth);

    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, width, bubbleHeight);

    ctx.strokeStyle = '#050505';
    ctx.lineWidth = lineWidth;
    ctx.lineCap = 'square';
    ctx.lineJoin = 'miter';

    ctx.beginPath();
    ctx.moveTo(-lineWidth, lineWidth);
    ctx.lineTo(width + lineWidth, lineWidth);
    ctx.moveTo(0, bottomY);
    ctx.lineTo(leftBase, bottomY);
    ctx.lineTo(notchX, tipY);
    ctx.lineTo(rightBase, bottomY);
    ctx.lineTo(width, bottomY);
    ctx.stroke();
  }

  ctx.restore();
}

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

export function resolveOutputSize(ratio: string) {
  if (ratio === '1:1') {
    return { width: 1088, height: 1088 };
  }

  if (ratio === '16:9') {
    return { width: 1280, height: 720 };
  }

  if (ratio === '9:16') {
    return { width: 1088, height: 1936 };
  }

  return { width: 1088, height: 1360 };
}
