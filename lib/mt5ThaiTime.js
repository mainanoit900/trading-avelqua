'use strict';

const MT5_TH_TZ = 'Asia/Bangkok';

function parseDate(value) {
  if (!value) return null;
  const d = value instanceof Date ? value : new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

function dayKeyBangkok(value) {
  const d = parseDate(value);
  if (!d) return '';
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: MT5_TH_TZ,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).format(d);
}

function formatThaiDateTime(value, opts = {}) {
  const d = parseDate(value);
  if (!d) return '-';
  if (opts.time === false) {
    return new Intl.DateTimeFormat('th-TH', {
      timeZone: MT5_TH_TZ,
      year: 'numeric',
      month: 'short',
      day: '2-digit'
    }).format(d);
  }
  return new Intl.DateTimeFormat('th-TH', {
    timeZone: MT5_TH_TZ,
    year: 'numeric',
    month: 'short',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false
  }).format(d);
}

function formatThaiDate(value) {
  const d = parseDate(value);
  if (!d) return '-';
  return new Intl.DateTimeFormat('th-TH', {
    timeZone: MT5_TH_TZ,
    weekday: 'short',
    year: 'numeric',
    month: 'short',
    day: 'numeric'
  }).format(d);
}

function formatThaiTime(value) {
  const d = parseDate(value);
  if (!d) return '-';
  return new Intl.DateTimeFormat('th-TH', {
    timeZone: MT5_TH_TZ,
    hour: '2-digit',
    minute: '2-digit',
    hour12: false
  }).format(d);
}

function formatThaiDayLabel(dayKey) {
  if (!dayKey) return '-';
  const parts = String(dayKey).split('-').map(Number);
  if (parts.length < 3 || parts.some((n) => !Number.isFinite(n))) return dayKey;
  const noonBangkokUtc = new Date(Date.UTC(parts[0], parts[1] - 1, parts[2], 5, 0, 0));
  return formatThaiDate(noonBangkokUtc);
}

module.exports = {
  MT5_TH_TZ,
  dayKeyBangkok,
  formatThaiDateTime,
  formatThaiDate,
  formatThaiTime,
  formatThaiDayLabel
};
