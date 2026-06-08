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

  // Track original video state for restoration
  let originalMuted = video.muted;
  let originalLoop = video.loop;
  let originalCurrentTime = video.currentTime;
  let originalPlaybackRate = video.playbackRate;
  let isVideoStateSaved = false;

  let encoderError: Error | null = null;
  let selectedCodec = '尚未配置';
  let videoEncoder: VideoEncoder | null = null;

  try {
    // Save video state
    originalMuted = video.muted;
    originalLoop = video.loop;
    originalCurrentTime = video.currentTime;
    originalPlaybackRate = video.playbackRate;
    isVideoStateSaved = true;

    // 3. Initialize VideoEncoder
    const errorHandler = (e: any) => {
      console.error('VideoEncoder error:', e);
      encoderError = new Error(`VideoEncoder 內部錯誤 (編碼規格: ${selectedCodec}): ${e.name || 'Error'} - ${e.message || '未知原因'}`);
    };

    videoEncoder = new VideoEncoder({
      output: (chunk, metadata) => {
        // Clone metadata to avoid modifying read-only object properties in browser
        const activeMetadata: any = {};
        if (metadata) {
          Object.assign(activeMetadata, metadata);
        }
        if (!activeMetadata.decoderConfig) {
          activeMetadata.decoderConfig = {
            codec: selectedCodec,
            description: new Uint8Array(), // Empty description fallback to avoid mp4-muxer crash
            colorSpace: {
              primaries: 'bt709',
              transfer: 'bt709',
              matrix: 'bt709',
              fullRange: false,
            }
          };
        }
        muxer.addVideoChunk(chunk, activeMetadata);
      },
      error: errorHandler,
    });

    // Explicitly set onerror callback as well for older WebKit implementations
    try {
      (videoEncoder as any).onerror = errorHandler;
    } catch (_) {}

    // Try H.264 profiles in order of preference (Main, Baseline, High)
    // We use standard '00' constraints for maximum compatibility with mobile GPUs
    const candidateCodecs = [
      'avc1.4d002a', // H.264 Main Profile, Level 4.2
      'avc1.42002a', // H.264 Baseline Profile, Level 4.2
      'avc1.64002a', // H.264 High Profile, Level 4.2
      'avc1.4d001f', // H.264 Main Profile, Level 3.1
      'avc1.42001f', // H.264 Baseline Profile, Level 3.1
      'avc1.42e01f', // H.264 Baseline Profile (legacy candidate)
    ];

    let selectedCodecConfig: any = null;

    for (const codec of candidateCodecs) {
      const config: any = {
        codec,
        width,
        height,
        bitrate: 4_000_000, // 4 Mbps
        framerate: fps,
      };
      if (codec.startsWith('avc1')) {
        config.avc = { format: 'avc' }; // Explicitly output as AVCC format
      }
      try {
        const support = await VideoEncoder.isConfigSupported(config);
        if (support.supported) {
          selectedCodecConfig = config;
          selectedCodec = codec;
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

    // Apply exporting video settings
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
    if (videoEncoder) {
      try {
        videoEncoder.close();
      } catch (_) {}
    }
    // Yield to the event loop for a slightly longer moment (150ms) to allow the asynchronous error callback to fire
    await new Promise((resolve) => setTimeout(resolve, 150));
    if (encoderError) {
      throw encoderError;
    }
    throw error;
  } finally {
    if (isVideoStateSaved) {
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
