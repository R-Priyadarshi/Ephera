import { sanitizePassphrase } from './crypto.js';
import { sanitizeRoomJoinKey } from './invite-package.js';

function buildInviteQrPayload({ roomId = '', roomJoinKey = '', joinLink = '', passphrase = '' } = {}) {
  const rid = typeof roomId === 'string' ? roomId.trim() : '';
  const key = sanitizeRoomJoinKey(roomJoinKey);
  const link = typeof joinLink === 'string' ? joinLink.trim() : '';
  const pass = sanitizePassphrase(typeof passphrase === 'string' ? passphrase : '') || '';

  if (!rid || !key || !link) return '';

  const payload = {
    v: 1,
    roomId: rid,
    roomJoinKey: key,
    joinLink: link,
  };

  if (pass) payload.passphrase = pass;
  return JSON.stringify(payload);
}

export {
  buildInviteQrPayload,
};
