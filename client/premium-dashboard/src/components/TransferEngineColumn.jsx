import { motion } from 'framer-motion';
import GlassPanel from './GlassPanel';

function GateStep({ label, status, progress }) {
  const active = status === 'active';
  const done = status === 'done';

  return (
    <div className="rounded-xl border border-white/10 bg-white/[0.03] p-3">
      <div className="mb-2 flex items-center justify-between">
        <p className="text-[10px] font-mono uppercase tracking-[0.18em] text-white/60">{label}</p>
        <span className={`h-2 w-2 rounded-full ${done ? 'bg-emerald-300' : active ? 'bg-cyan-300' : 'bg-white/25'}`} />
      </div>
      <div className="h-1.5 rounded-full bg-slate-900/80">
        <motion.div
          className={`h-full rounded-full ${done ? 'bg-emerald-300' : 'bg-cyan-300'}`}
          initial={{ width: 0 }}
          animate={{ width: `${progress}%` }}
          transition={{ duration: 0.8 }}
        />
      </div>
    </div>
  );
}

function GateVisualization() {
  const steps = [
    { label: 'Room lock', status: 'done', progress: 100 },
    { label: 'Channel handshake', status: 'done', progress: 100 },
    { label: 'Peer ready', status: 'done', progress: 100 },
    { label: 'Crypto verify', status: 'active', progress: 84 },
    { label: 'Transfer arm', status: 'active', progress: 70 }
  ];

  return (
    <GlassPanel
      title="Transport Gate"
      subtitle="Pipeline lock status"
      right={<span className="rounded-lg border border-cyan-300/30 bg-cyan-300/10 px-2 py-1 text-[10px] font-mono uppercase tracking-[0.18em] text-cyan-100">Engine</span>}
      className="min-h-[260px]"
      active
      delay={0.2}
    >
      <div className="grid gap-2">
        {steps.map((step) => (
          <GateStep key={step.label} {...step} />
        ))}
      </div>
    </GlassPanel>
  );
}

function StreamPipeline() {
  return (
    <GlassPanel title="File Stream Pipeline" subtitle="Flow across direct channel" className="min-h-[260px]" delay={0.26}>
      <div className="relative rounded-2xl border border-white/10 bg-slate-950/45 p-4">
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 text-center">
          <div className="rounded-xl border border-cyan-300/30 bg-cyan-300/10 p-3">
            <p className="text-[10px] font-mono uppercase tracking-[0.16em] text-cyan-100/70">Sender</p>
            <p className="mt-1 text-sm font-medium text-cyan-50">Chunked payload</p>
          </div>
          <div className="rounded-xl border border-blue-300/30 bg-blue-300/10 p-3">
            <p className="text-[10px] font-mono uppercase tracking-[0.16em] text-blue-100/70">Channel</p>
            <p className="mt-1 text-sm font-medium text-blue-50">Encrypted stream</p>
          </div>
          <div className="rounded-xl border border-emerald-300/30 bg-emerald-300/10 p-3">
            <p className="text-[10px] font-mono uppercase tracking-[0.16em] text-emerald-100/70">Receiver</p>
            <p className="mt-1 text-sm font-medium text-emerald-50">Write / discard</p>
          </div>
        </div>

        <div className="relative mt-4 h-8 overflow-hidden rounded-full border border-white/10 bg-slate-900/80">
          <motion.div
            className="absolute inset-y-1 left-2 w-20 rounded-full bg-gradient-to-r from-cyan-300 via-blue-300 to-emerald-300"
            animate={{ x: ['0%', '520%'] }}
            transition={{ duration: 2.2, repeat: Infinity, ease: 'linear' }}
          />
        </div>
      </div>
    </GlassPanel>
  );
}

function MetricsBand() {
  const stats = [
    ['Stream rate', '2.6 Gbps'],
    ['Chunk cadence', '64 KB / frame'],
    ['Parallel transfers', '04 active'],
    ['Drop rate', '0.02%']
  ];

  return (
    <GlassPanel title="Transfer Metrics" subtitle="Real-time engine telemetry" className="min-h-[170px]" delay={0.3}>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        {stats.map(([label, value]) => (
          <div key={label} className="rounded-xl border border-white/10 bg-white/[0.03] px-3 py-2">
            <p className="text-[10px] font-mono uppercase tracking-[0.18em] text-white/55">{label}</p>
            <p className="mt-1 font-display text-2xl font-semibold text-white">{value}</p>
          </div>
        ))}
      </div>
    </GlassPanel>
  );
}

function BandwidthGraph() {
  const points = [14, 36, 22, 44, 28, 52, 34, 61, 46, 72, 55, 78, 62, 81, 69];
  const path = points
    .map((point, index) => `${index === 0 ? 'M' : 'L'} ${index * 24} ${90 - point}`)
    .join(' ');

  return (
    <GlassPanel title="Bandwidth Graph" subtitle="1-minute rolling trace" className="min-h-[200px]" delay={0.34}>
      <div className="relative h-36 rounded-xl border border-white/10 bg-slate-950/55 p-3">
        <svg viewBox="0 0 336 90" className="h-full w-full">
          <motion.path
            d={path}
            fill="none"
            stroke="rgba(69,215,255,0.95)"
            strokeWidth="2.4"
            initial={{ pathLength: 0 }}
            animate={{ pathLength: 1 }}
            transition={{ duration: 1.2 }}
          />
        </svg>
        <motion.div
          className="absolute inset-y-0 w-10 bg-gradient-to-r from-transparent via-cyan-300/20 to-transparent"
          animate={{ x: ['-20%', '950%'] }}
          transition={{ duration: 3, repeat: Infinity, ease: 'linear' }}
        />
      </div>
    </GlassPanel>
  );
}

export default function TransferEngineColumn() {
  return (
    <div className="col-span-12 space-y-5 xl:col-span-5">
      <GateVisualization />
      <StreamPipeline />
      <MetricsBand />
      <BandwidthGraph />
    </div>
  );
}
