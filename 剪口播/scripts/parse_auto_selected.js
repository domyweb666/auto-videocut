#!/usr/bin/env node
/**
 * parse_auto_selected.js — 解析 auto_selected.json 的兩種格式
 * （純陣列 indices，或 { indices, reasons } 且 reasons key 支援 "3-7" 範圍展開）。
 *
 * 從退役的 generate_review.js（53KB 舊深色審核頁）抽出——它是該檔唯一還被
 * training_server.js 引用的函式（audit #12）。
 */
function parseAutoSelected(raw) {
  let autoSelected = [];
  let autoReasons = {};
  if (Array.isArray(raw)) {
    autoSelected = raw;
  } else if (raw && raw.indices) {
    autoSelected = raw.indices;
    if (raw.reasons) {
      for (const [key, reason] of Object.entries(raw.reasons)) {
        if (key.includes('-')) {
          const [start, end] = key.split('-').map(Number);
          for (let i = start; i <= end; i++) autoReasons[i] = reason;
        } else {
          autoReasons[key] = reason;
        }
      }
    }
  }
  return { autoSelected, autoReasons };
}

module.exports = { parseAutoSelected };
