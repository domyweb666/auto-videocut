/**
 * ffmpeg 編碼器偵測工具（共用模組）
 *
 * 給 review_server.js 與 training_server.js 共用，避免重複實作
 * /api/encoders 的硬體偵測邏輯。
 *
 * 用法：
 *   const { getAvailableEncoders } = require('./encoder_utils');
 *   const caps = getAvailableEncoders();  // 第二次以後讀快取
 *   // caps = { h264: {supported, encoders}, h265: {...}, av1: {supported, encoders, hardware} }
 */

const { execSync } = require('child_process');

let cached = null;

function getAvailableEncoders() {
  if (cached) return cached;

  let encoderList = '';
  try {
    encoderList = execSync('ffmpeg -hide_banner -encoders', {
      stdio: ['ignore', 'pipe', 'ignore'],
    }).toString();
  } catch (e) {
    encoderList = '';
  }

  const has = (name) =>
    encoderList.includes(' ' + name + ' ') || encoderList.includes(' ' + name + '\n');

  const h264 = ['libx264', 'h264_nvenc', 'h264_qsv', 'h264_amf', 'h264_videotoolbox', 'h264_vaapi'].filter(has);
  const h265 = ['libx265', 'hevc_nvenc', 'hevc_qsv', 'hevc_amf', 'hevc_videotoolbox'].filter(has);
  const av1  = ['av1_nvenc', 'av1_qsv', 'av1_amf', 'libsvtav1', 'libaom-av1'].filter(has);

  cached = {
    h264: { supported: h264.length > 0, encoders: h264 },
    h265: { supported: h265.length > 0, encoders: h265 },
    av1: {
      supported: av1.length > 0,
      encoders: av1,
      hardware: av1.some((e) => /nvenc|qsv|amf/.test(e)),
    },
  };
  return cached;
}

module.exports = { getAvailableEncoders };
