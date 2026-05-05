export const pipelineStages = [
  { key: 'room', label: 'Room', state: 'online' },
  { key: 'channel', label: 'Channel', state: 'negotiating' },
  { key: 'peer', label: 'Peer', state: 'ready' },
  { key: 'crypto', label: 'Crypto', state: 'verified' },
  { key: 'transfer', label: 'Transfer', state: 'armed' }
];

export const timelineEvents = [
  { time: '11:05:12', kind: 'Session', message: 'Owner boundary created for room eph-f0f2.' },
  { time: '11:05:31', kind: 'Peer', message: 'Peer joined through invite package channel.' },
  { time: '11:05:43', kind: 'Crypto', message: 'AES-256 stream mode verified with peer hash.' },
  { time: '11:06:02', kind: 'Transfer', message: 'Transfer stream armed, waiting for payload.' },
  { time: '11:06:17', kind: 'Telemetry', message: 'Latency stabilized to 34ms p95.' }
];

export const ledgerRows = [
  { id: 'tr-9a01', name: 'Spec_Archive.zip', size: '1.2 GB', status: 'streaming', progress: 72 },
  { id: 'tr-5b28', name: 'DesignPack_Feb.mov', size: '843 MB', status: 'verifying', progress: 94 },
  { id: 'tr-a773', name: 'Audit_Log.txt', size: '18 MB', status: 'delivered', progress: 100 }
];

export const diagnostics = [
  { label: 'Signaling', value: 'Connected', level: 'good' },
  { label: 'WebRTC', value: 'Direct P2P', level: 'good' },
  { label: 'Crypto', value: 'Passphrase Match', level: 'good' },
  { label: 'Retention', value: 'Zero-Memory Lock', level: 'good' },
  { label: 'Backpressure', value: 'Stable', level: 'good' }
];

export const readiness = [
  { label: 'Secure context', ok: true },
  { label: 'Receive folder capability', ok: true },
  { label: 'DataChannel support', ok: true },
  { label: 'Clipboard + invite sync', ok: true }
];

export const bandwidthPoints = [42, 51, 64, 58, 73, 66, 81, 76, 88, 79, 83, 91, 86];
