import { drawMeme, type DrawableSource, type RenderOptions } from './render';

export type ExportVideoOptions = {
  canvas: HTMLCanvasElement;
  ctx: CanvasRenderingContext2D;
  video: HTMLVideoElement;
  renderOptions: RenderOptions;
  fps: number;
  onProgress: (progress: number) => void;
};

export async function exportWebm({
  canvas,
  ctx,
  video,
  renderOptions,
  fps,
  onProgress,
}: ExportVideoOptions): Promise<Blob> {
  const mimeType = getSupportedMimeType();
  if (!mimeType) {
    throw new Error('這個瀏覽器不支援 WebM 影片輸出。');
  }

  const originalMuted = video.muted;
  const originalLoop = video.loop;
  const originalCurrentTime = video.currentTime;
  const chunks: BlobPart[] = [];
  const stream = canvas.captureStream(fps);
  const recorder = new MediaRecorder(stream, {
    mimeType,
    videoBitsPerSecond: 8_000_000,
  });

  recorder.ondataavailable = (event) => {
    if (event.data.size > 0) {
      chunks.push(event.data);
    }
  };

  const complete = new Promise<Blob>((resolve, reject) => {
    recorder.onerror = () => reject(recorder.error ?? new Error('影片輸出失敗。'));
    recorder.onstop = () => resolve(new Blob(chunks, { type: mimeType }));
  });

  await seek(video, 0);
  video.muted = true;
  video.loop = false;
  video.playbackRate = 1;

  let animationFrame = 0;
  const startedAt = performance.now();
  const maxDurationMs = Math.min((video.duration || 0) * 1000, 60_000);

  const renderFrame = () => {
    drawMeme(ctx, video as DrawableSource, renderOptions);
    if (video.duration) {
      onProgress(Math.min(1, video.currentTime / video.duration));
    } else if (maxDurationMs) {
      onProgress(Math.min(1, (performance.now() - startedAt) / maxDurationMs));
    }
    animationFrame = requestAnimationFrame(renderFrame);
  };

  recorder.start(250);
  renderFrame();
  await video.play();

  await new Promise<void>((resolve) => {
    const finish = () => resolve();
    video.addEventListener('ended', finish, { once: true });
    window.setTimeout(finish, Math.max(1000, maxDurationMs + 500));
  });

  cancelAnimationFrame(animationFrame);
  drawMeme(ctx, video as DrawableSource, renderOptions);
  recorder.stop();

  const blob = await complete;
  video.pause();
  video.muted = originalMuted;
  video.loop = originalLoop;
  if (Number.isFinite(originalCurrentTime)) {
    await seek(video, originalCurrentTime).catch(() => undefined);
  }
  onProgress(1);

  return blob;
}

function getSupportedMimeType() {
  const candidates = [
    'video/webm;codecs=vp9',
    'video/webm;codecs=vp8',
    'video/webm',
  ];

  return candidates.find((type) => MediaRecorder.isTypeSupported(type)) ?? '';
}

function seek(video: HTMLVideoElement, time: number) {
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
      video.removeEventListener('seeked', done);
      video.removeEventListener('error', fail);
    };

    video.addEventListener('seeked', done, { once: true });
    video.addEventListener('error', fail, { once: true });
    video.currentTime = Math.min(Math.max(time, 0), video.duration || time);
  });
}
