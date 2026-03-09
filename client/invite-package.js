import { sanitizePassphrase } from './crypto.js';

const INVITE_PACKAGE_ACCEPT_TEXT = 'Accepts full invite package text, JSON payload, or join link.';

function sanitizeRoomJoinKey(value) {
  if (typeof value !== 'string') return '';
  const s = value.trim();
  if (!s) return '';
  if (s.length < 16 || s.length > 128) return '';
  if (!/^[A-Za-z0-9_-]+$/.test(s)) return '';
  return s;
}

function normalizeInvitePassphrase(raw) {
  if (typeof raw !== 'string') return '';
  const s = raw.trim();
  if (!s) return '';
  const l = s.toLowerCase();
  if (
    l === 'none'
    || l === 'plain'
    || l === '(not set - plain mode)'
    || (l.includes('not set') && l.includes('plain mode'))
  ) {
    return '';
  }
  return sanitizePassphrase(s) || '';
}

function extractFirstHttpUrl(text) {
  if (typeof text !== 'string') return '';
  const m = text.match(/https?:\/\/[^\s<>"']+/i);
  if (!m) return '';
  return String(m[0] || '').replace(/[),.;\]]+$/, '').trim();
}

function getObjectString(obj, keys) {
  if (!obj || typeof obj !== 'object') return '';
  for (const k of keys) {
    const v = obj[k];
    if (typeof v === 'string' && v.trim()) return v.trim();
  }
  return '';
}

function parseInvitePackageText(rawText) {
  const text = typeof rawText === 'string' ? rawText.trim() : '';
  if (!text) {
    return {
      ok: false,
      reason: 'Invite package is empty',
      roomId: '',
      roomJoinKey: '',
      passphrase: '',
      passphraseSeen: false,
      joinLink: '',
      source: 'empty',
    };
  }

  let roomId = '';
  let roomJoinKey = '';
  let passphrase = '';
  let passphraseSeen = false;
  let joinLink = '';
  let source = 'package';

  try {
    if (text.startsWith('{') && text.endsWith('}')) {
      const obj = JSON.parse(text);
      if (obj && typeof obj === 'object') {
        roomId = getObjectString(obj, ['roomId', 'room_id', 'room']);
        roomJoinKey = getObjectString(obj, ['roomJoinKey', 'joinKey', 'roomAuthKey', 'room_auth_key']);
        joinLink = getObjectString(obj, ['joinLink', 'join_link', 'link', 'url', 'invite']);
        if (Object.prototype.hasOwnProperty.call(obj, 'passphrase')) {
          passphraseSeen = true;
          passphrase = normalizeInvitePassphrase(typeof obj.passphrase === 'string' ? obj.passphrase : '');
        } else if (Object.prototype.hasOwnProperty.call(obj, 'pass')) {
          passphraseSeen = true;
          passphrase = normalizeInvitePassphrase(typeof obj.pass === 'string' ? obj.pass : '');
        }
        source = 'json';
      }
    }
  } catch {}

  const lines = text.split(/\r?\n/);
  for (const line of lines) {
    const s = String(line || '').trim();
    if (!s) continue;

    if (!roomId) {
      const m = s.match(/^room\s*id\s*:\s*(.+)$/i);
      if (m && m[1]) roomId = m[1].trim();
    }

    if (!roomJoinKey) {
      const m = s.match(/^room\s*(?:auth|join)\s*key\s*:\s*(.+)$/i);
      if (m && m[1]) roomJoinKey = m[1].trim();
    }

    if (!joinLink) {
      const m = s.match(/^join\s*link\s*:\s*(.+)$/i);
      if (m && m[1]) joinLink = m[1].trim();
    }

    const passLine = s.match(/^passphrase\s*:\s*(.*)$/i);
    if (passLine) {
      passphraseSeen = true;
      passphrase = normalizeInvitePassphrase(passLine[1] || '');
    }
  }

  if (!joinLink) {
    const maybe = extractFirstHttpUrl(text);
    if (maybe) {
      joinLink = maybe;
      if (!roomId && !roomJoinKey) source = 'link';
    }
  }

  if (joinLink) {
    try {
      const u = new URL(joinLink);
      if (!roomId) roomId = String(u.searchParams.get('roomId') || '').trim();

      const h = new URLSearchParams(String(u.hash || '').replace(/^#/, ''));
      if (!roomJoinKey) {
        roomJoinKey = sanitizeRoomJoinKey(
          h.get('roomJoinKey')
          || h.get('joinKey')
          || u.searchParams.get('roomJoinKey')
          || u.searchParams.get('joinKey')
          || ''
        );
      }

      const passRaw = h.has('passphrase')
        ? h.get('passphrase')
        : u.searchParams.get('passphrase');
      if (passRaw != null) {
        passphraseSeen = true;
        if (!passphrase) passphrase = normalizeInvitePassphrase(passRaw);
      }
    } catch {}
  }

  roomId = roomId.trim();
  roomJoinKey = sanitizeRoomJoinKey(roomJoinKey);
  passphrase = normalizeInvitePassphrase(passphrase);

  if (!roomId) {
    return {
      ok: false,
      reason: 'Invite package missing Room ID',
      roomId,
      roomJoinKey,
      passphrase,
      passphraseSeen,
      joinLink,
      source,
    };
  }
  if (!roomJoinKey) {
    return {
      ok: false,
      reason: 'Invite package missing valid Room Auth Key',
      roomId,
      roomJoinKey,
      passphrase,
      passphraseSeen,
      joinLink,
      source,
    };
  }

  return {
    ok: true,
    reason: '',
    roomId,
    roomJoinKey,
    passphrase,
    passphraseSeen,
    joinLink,
    source,
  };
}

export {
  INVITE_PACKAGE_ACCEPT_TEXT,
  sanitizeRoomJoinKey,
  parseInvitePackageText,
};
