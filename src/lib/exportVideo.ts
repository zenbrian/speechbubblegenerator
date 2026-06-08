import { Muxer, ArrayBufferTarget } from 'mp4-muxer';
import { drawMeme, type DrawableSource, type RenderOptions } from './render';

export type ExportVideoOptions = {
  canvas: HTMLCanvasElement;
  ctx: CanvasRenderingContext2D;
  video: HTMLVideoElement;
  renderOptions: RenderOptions;
  fps: number;
  onProgress: (progress: number) => void;
};

export async function exportMp4({
  canvas,
  ctx,
  video,
  renderOptions,
  fps = 30,
  onProgress,
}: ExportVideoOptions): Promise<Blob> {
  const width = renderOptions.width;
  const height = renderOptions.height;

  // 1. Check if VideoEncoder is supported
  if (typeof VideoEncoder === 'undefined') {
    throw new Error('您的瀏覽器不支援 WebCodecs API (VideoEncoder)，無法匯出 MP4 影片。');
  }

  // 2. Initialize Muxer
  const muxer = new Muxer({
    target: new ArrayBufferTarget(),
    video: {
      codec: 'avc', // avc = H.264
      width,
      height,
    },
    fastStart: 'in-memory',
  });

  // 3. Initialize VideoEncoder
  let encoderError: Error | null = null;
  const videoEncoder = new VideoEncoder({
    output: (chunk, metadata) => {
      muxer.addVideoChunk(chunk, metadata);
    },
    error: (e) => {
      console.error('VideoEncoder error:', e);
      encoderError = e;
    },
  });

  // Try H.264 profiles in order of preference (Main, Baseline, High)
  const candidateCodecs = [
    'avc1.4d401f', // H.264 Main Profile, Level 3.1
    'avc1.42e01f', // H.264 Baseline Profile, Level 3.0
    'avc1.64002a', // H.264 High Profile, Level 4.2
  ];

  let selectedCodecConfig: any = null;

  for (const codec of candidateCodecs) {
    const config = {
      codec,
      width,
      height,
      bitrate: 4_000_000, // 4 Mbps
      framerate: fps,
    };
    try {
      const support = await VideoEncoder.isConfigSupported(config);
      if (support.supported) {
        selectedCodecConfig = config;
        break;
      }
    } catch (e) {
      // Unused, try next codec candidate
    }
  }

  if (!selectedCodecConfig) {
    throw new Error('當前瀏覽器不支援相容的 H.264 影片編碼規格。');
  }

  videoEncoder.configure(selectedCodecConfig);

  // 4. Save video state and pause
  const originalMuted = video.muted;
  const originalLoop = video.loop;
  const originalCurrentTime = video.currentTime;
  const originalPlaybackRate = video.playbackRate;

  video.muted = true;
  video.loop = false;
  video.playbackRate = 1;
  video.pause();

  const durationSec = video.duration || 0;
  if (durationSec <= 0) {
    throw new Error('無法取得影片的總長度。');
  }

  // Cap duration to 60 seconds max
  const maxDurationSec = Math.min(durationSec, 60);
  const totalFrames = Math.round(maxDurationSec * fps);

  try {
    for (let i = 0; i < totalFrames; i++) {
      if (encoderError) {
        throw encoderError;
      }

      const timeSec = i / fps;
      
      // Seek the video to the exact frame time
      await seek(video, timeSec);

      // Draw current video frame to the preview canvas
      drawMeme(ctx, video as DrawableSource, renderOptions);

      // Create a VideoFrame from the canvas
      // timestamp is in microseconds (1 second = 1,000,000 microseconds)
      const timestampUs = Math.round((i * 1_000_000) / fps);
      const videoFrame = new VideoFrame(canvas, { timestamp: timestampUs });

      // Encode the frame
      // H.264 requires keyframes periodically, we force a keyframe every 30 frames
      const isKeyFrame = i % 30 === 0;
      videoEncoder.encode(videoFrame, { keyFrame: isKeyFrame });

      // Close the frame to prevent GPU memory leaks
      videoFrame.close();

      // Report progress
      onProgress((i + 1) / totalFrames);
    }

    // Flush remaining frames in encoder
    await videoEncoder.flush();
    if (encoderError) {
      throw encoderError;
    }
    videoEncoder.close();

    // Finalize the muxer and get output buffer
    muxer.finalize();
    const { buffer } = muxer.target as ArrayBufferTarget;
    
    return new Blob([buffer], { type: 'video/mp4' });
  } catch (error) {
    videoEncoder.close();
    throw error;
  } finally {
    // Restore video state
    video.muted = originalMuted;
    video.loop = originalLoop;
    video.playbackRate = originalPlaybackRate;
    if (Number.isFinite(originalCurrentTime)) {
      await seek(video, originalCurrentTime).catch(() => undefined);
      video.play().catch(() => undefined);
    }
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

    video.addEventListener('seeked', done, { once: true });
    video.addEventListener('error', fail, { once: true });
    video.currentTime = Math.min(Math.max(time, 0), video.duration || time);
  });
}
