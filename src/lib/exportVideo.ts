import { drawMeme, type DrawableSource, type RenderOptions } from './render';

export type ExportVideoOptions = {
  canvas: HTMLCanvasElement;
  ctx: CanvasRenderingContext2D;
  video: HTMLVideoElement;
  renderOptions: RenderOptions;
  fps: number;
  onProgress: (progress: number) => void;
};

export type ExportVideoResult = {
  blob: Blob;
  extension: string;
};

/**
 * Detect the best supported video MIME type for MediaRecorder.
 * Prefers MP4 (iOS Safari), then WebM H.264, then WebM VP8/VP9.
 */
function getSupportedMimeType(): string {
  const candidates = [
    'video/mp4',
    'video/webm;codecs=h264',
    'video/webm;codecs=vp9',
    'video/webm;codecs=vp8',
    'video/webm',
  ];

  for (const mime of candidates) {
    if (MediaRecorder.isTypeSupported(mime)) {
      return mime;
    }
  }

  return '';
}

/**
 * Export the meme video using MediaRecorder API.
 *
 * This plays the video in real-time, renders each frame to the canvas
 * with the bubble overlay via requestAnimationFrame, and records the
 * canvas stream using MediaRecorder.
 *
 * Works on mobile Safari (iOS 14.3+) and Android Chrome without
 * relying on WebCodecs VideoEncoder.
 */
export async function exportVideo({
  canvas,
  ctx,
  video,
  renderOptions,
  fps = 30,
  onProgress,
}: ExportVideoOptions): Promise<ExportVideoResult> {
  // 1. Check MediaRecorder support
  if (typeof MediaRecorder === 'undefined') {
    throw new Error('您的瀏覽器不支援 MediaRecorder API，無法匯出影片。');
  }

  const mimeType = getSupportedMimeType();
  if (!mimeType) {
    throw new Error('您的瀏覽器不支援任何影片錄製格式（MP4/WebM），無法匯出影片。');
  }

  const extension = mimeType.startsWith('video/mp4') ? 'mp4' : 'webm';

  // 2. Save original video state
  const originalMuted = video.muted;
  const originalLoop = video.loop;
  const originalCurrentTime = video.currentTime;
  const originalPlaybackRate = video.playbackRate;

  try {
    // 3. Prepare video for recording
    video.muted = true;
    video.loop = false;
    video.playbackRate = 1;
    video.pause();

    const durationSec = video.duration || 0;
    if (durationSec <= 0 || !Number.isFinite(durationSec)) {
      throw new Error('無法取得影片的總長度。');
    }

    // Cap at 60 seconds
    const maxDurationSec = Math.min(durationSec, 60);

    // 4. Seek to the start
    await seek(video, 0);

    // 5. Set up canvas dimensions
    canvas.width = renderOptions.width;
    canvas.height = renderOptions.height;

    // 6. Create MediaRecorder from canvas stream
    const stream = canvas.captureStream(fps);

    const recorderOptions: MediaRecorderOptions = {
      mimeType,
    };

    // Try to set a reasonable bitrate (4 Mbps)
    try {
      recorderOptions.videoBitsPerSecond = 4_000_000;
    } catch (_) {
      // Some browsers may not support this option
    }

    const recorder = new MediaRecorder(stream, recorderOptions);

    const chunks: Blob[] = [];

    // Collect data chunks
    recorder.ondataavailable = (e) => {
      if (e.data && e.data.size > 0) {
        chunks.push(e.data);
      }
    };

    // 7. Wrap recording in a promise
    const recordingDone = new Promise<Blob>((resolve, reject) => {
      recorder.onstop = () => {
        const blob = new Blob(chunks, { type: mimeType });
        resolve(blob);
      };
      recorder.onerror = (event: any) => {
        reject(new Error(`錄製過程發生錯誤: ${event?.error?.message || '未知錯誤'}`));
      };
    });

    // 8. Start recording (request data every 100ms for smoother progress)
    recorder.start(100);

    // 9. Render loop: play the video and draw to canvas in real-time
    let animationId = 0;
    let stopped = false;

    const renderLoop = () => {
      if (stopped) return;

      // Draw current frame
      drawMeme(ctx, video as DrawableSource, renderOptions);

      // Check progress
      const currentTime = video.currentTime;
      const progress = Math.min(currentTime / maxDurationSec, 1);
      onProgress(progress);

      // Check if we should stop
      if (currentTime >= maxDurationSec || video.ended) {
        stopped = true;
        // Draw the last frame one more time to ensure it's captured
        drawMeme(ctx, video as DrawableSource, renderOptions);
        video.pause();
        // Give the recorder a small moment to capture the final frame, then stop
        setTimeout(() => {
          if (recorder.state === 'recording') {
            recorder.stop();
          }
        }, 100);
        return;
      }

      animationId = requestAnimationFrame(renderLoop);
    };

    // Start playing and rendering
    await video.play().catch(() => {
      throw new Error('影片播放失敗，無法開始錄製。');
    });

    animationId = requestAnimationFrame(renderLoop);

    // Also listen for the video ending naturally
    const videoEndedPromise = new Promise<void>((resolve) => {
      const onEnded = () => {
        video.removeEventListener('ended', onEnded);
        if (!stopped) {
          stopped = true;
          cancelAnimationFrame(animationId);
          drawMeme(ctx, video as DrawableSource, renderOptions);
          onProgress(1);
          setTimeout(() => {
            if (recorder.state === 'recording') {
              recorder.stop();
            }
          }, 100);
        }
        resolve();
      };
      video.addEventListener('ended', onEnded);

      // Safety timeout: stop after maxDurationSec + 2 seconds buffer
      setTimeout(() => {
        if (!stopped) {
          stopped = true;
          cancelAnimationFrame(animationId);
          video.pause();
          onProgress(1);
          if (recorder.state === 'recording') {
            recorder.stop();
          }
        }
        resolve();
      }, (maxDurationSec + 2) * 1000);
    });

    // Wait for recording to complete
    const blob = await recordingDone;

    onProgress(1);

    return { blob, extension };
  } finally {
    // Restore original video state
    video.muted = originalMuted;
    video.loop = originalLoop;
    video.playbackRate = originalPlaybackRate;
    if (Number.isFinite(originalCurrentTime)) {
      await seek(video, originalCurrentTime).catch(() => undefined);
    }
    video.play().catch(() => undefined);
  }
}

function seek(video: HTMLVideoElement, time: number) {
  return new Promise<void>((resolve, reject) => {
    const done = () => {
      cleanup();
      resolve();
    };
    const fail = () => {
      cleanup();
      reject(new Error('影片尋軌失敗。'));
    };
    const cleanup = () => {
      video.removeEventListener('seeked', done);
      video.removeEventListener('error', fail);
    };

    if (Math.abs(video.currentTime - time) < 0.01) {
      resolve();
      return;
    }

    video.addEventListener('seeked', done, { once: true });
    video.addEventListener('error', fail, { once: true });
    video.currentTime = Math.min(Math.max(time, 0), video.duration || time);
  });
}
