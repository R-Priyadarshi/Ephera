import { motion } from 'framer-motion';
import GlassPanel from './GlassPanel';
import PipelineRail from './PipelineRail';

function HeroIndicators() {
  const rows = [
    ['Session', 'Owner boundary live'],
    ['Channel', 'DataChannel encrypted'],
    ['Peer', 'Receiver acknowledged'],
    ['Crypto', 'Passphrase verified'],
    ['Transfer', 'Gate armed']
  ];

  return (
    <div className="grid gap-2.5">
      {rows.map(([label, value], idx) => (
        <motion.div
          key={label}
          initial={{ opacity: 0, x: -16 }}
          animate={{ opacity: 1, x: 0 }}
          transition={{ duration: 0.35, delay: 0.15 + idx * 0.06 }}
          className="grid grid-cols-[80px_1fr] items-center gap-4 rounded-2xl border border-white/10 bg-white/[0.035] px-4 py-3"
        >
          <span className="text-[10px] font-mono uppercase tracking-[0.22em] text-white/45">{label}</span>
          <span className="text-sm font-medium text-white/92">{value}</span>
        </motion.div>
      ))}
    </div>
  );
}

export default function HeroSection({ stages }) {
  return (
    <section className="mb-8 grid grid-cols-12 gap-5">
      <GlassPanel className="col-span-12 xl:col-span-8 min-h-[340px]" active delay={0.05}>
        <div className="grid h-full gap-6 lg:grid-cols-[1.3fr_0.7fr]">
          <div>
            <div className="inline-flex items-center gap-2 rounded-2xl border border-cyan-300/20 bg-cyan-300/8 px-3 py-2">
              <span className="h-2 w-2 bg-cyan-300" />
              <p className="text-[10px] font-mono uppercase tracking-[0.24em] text-cyan-100/72">Session state</p>
            </div>
            <h2 className="mt-5 max-w-3xl font-display text-5xl font-semibold leading-[0.95] tracking-[-0.04em] text-white">
              Direct transfer core armed for deterministic zero-retention exchange.
            </h2>
            <p className="mt-5 max-w-2xl text-sm leading-7 text-white/60">
              Ephera’s command surface keeps room setup, peer verification, encryption posture, and transfer flow inside a single live boundary. Payloads stream through the system without storage or operator visibility.
            </p>
            <div className="mt-6 grid max-w-2xl grid-cols-3 gap-3">
              {[
                ['Retention', '0 bytes persisted'],
                ['Topology', 'direct peer path'],
                ['Handshake', '5-stage verified']
              ].map(([label, value]) => (
                <div key={label} className="rounded-2xl border border-white/10 bg-white/[0.03] p-4">
                  <p className="text-[10px] font-mono uppercase tracking-[0.22em] text-white/45">{label}</p>
                  <p className="mt-3 text-sm font-medium text-white/88">{value}</p>
                </div>
              ))}
            </div>
            <PipelineRail stages={stages} />
          </div>
          <div className="flex flex-col justify-between gap-4">
            <HeroIndicators />
            <div className="rounded-[24px] border border-white/10 bg-[linear-gradient(180deg,rgba(7,24,35,0.85),rgba(5,14,22,0.95))] p-4">
              <div className="mb-4 flex items-center justify-between">
                <p className="text-[10px] font-mono uppercase tracking-[0.24em] text-white/45">Node relation</p>
                <p className="text-[10px] font-mono uppercase tracking-[0.24em] text-cyan-100/70">No relay payload</p>
              </div>
              <div className="relative h-[132px] overflow-hidden rounded-[20px] border border-white/8 bg-[#08131c]">
                <div className="absolute left-10 top-20 h-px w-[104px] rotate-[16deg] bg-gradient-to-r from-cyan-300/70 to-transparent" />
                <div className="absolute left-[132px] top-[48px] h-px w-[92px] rotate-[18deg] bg-gradient-to-r from-white/40 to-cyan-300/60" />
                {[
                  { x: '20%', y: '66%', label: 'Sender', tone: 'bg-cyan-300' },
                  { x: '52%', y: '34%', label: 'Signal', tone: 'bg-orange-300' },
                  { x: '80%', y: '64%', label: 'Receiver', tone: 'bg-emerald-300' }
                ].map((node, index) => (
                  <motion.div
                    key={node.label}
                    className="absolute"
                    style={{ left: node.x, top: node.y }}
                    animate={{ scale: [1, 1.1, 1], opacity: [0.65, 1, 0.65] }}
                    transition={{ duration: 2.2, repeat: Infinity, delay: index * 0.2 }}
                  >
                    <div className={`h-3.5 w-3.5 ${node.tone} shadow-[0_0_0_6px_rgba(69,215,255,0.08)]`} />
                    <p className="mt-2 text-[10px] font-mono uppercase tracking-[0.18em] text-white/55">{node.label}</p>
                  </motion.div>
                ))}
              </div>
            </div>
          </div>
        </div>
      </GlassPanel>

      <GlassPanel
        className="col-span-12 xl:col-span-4 min-h-[340px]"
        title="Network Motion"
        subtitle="Live bandwidth profile"
        delay={0.12}
      >
        <div className="flex h-full flex-col justify-between">
          <div className="grid grid-cols-2 gap-3">
            <div className="rounded-2xl border border-cyan-300/28 bg-cyan-300/10 p-4">
              <p className="text-[10px] font-mono uppercase tracking-[0.22em] text-cyan-100/70">Throughput</p>
              <p className="mt-3 font-display text-4xl font-semibold text-cyan-100">2.6</p>
              <p className="mt-1 text-xs text-cyan-100/58">Gbps sustained</p>
            </div>
            <div className="rounded-2xl border border-white/10 bg-white/[0.04] p-4">
              <p className="text-[10px] font-mono uppercase tracking-[0.22em] text-white/55">Latency</p>
              <p className="mt-3 font-display text-4xl font-semibold text-white">34</p>
              <p className="mt-1 text-xs text-white/52">ms p95</p>
            </div>
          </div>

          <div className="relative mt-6 h-24 overflow-hidden rounded-2xl border border-white/10 bg-gradient-to-b from-white/[0.04] to-transparent p-3">
            <svg viewBox="0 0 320 100" className="h-full w-full">
              <motion.path
                d="M0,72 C30,62 42,34 70,42 C102,52 124,70 148,58 C178,44 198,22 224,30 C248,38 262,62 288,54 C304,50 312,40 320,34"
                fill="none"
                stroke="rgba(69,215,255,0.9)"
                strokeWidth="2.5"
                initial={{ pathLength: 0 }}
                animate={{ pathLength: 1 }}
                transition={{ duration: 1.4, ease: 'easeOut' }}
              />
            </svg>
            <motion.div
              className="absolute left-0 top-0 h-full w-20 bg-gradient-to-r from-transparent via-cyan-300/20 to-transparent"
              animate={{ x: ['-30%', '420%'] }}
              transition={{ duration: 2.8, ease: 'linear', repeat: Infinity }}
            />
          </div>

          <div className="mt-6 grid gap-3">
            {[
              ['Path', 'Direct WebRTC lane'],
              ['Integrity', 'Backpressure stable'],
              ['Envelope', 'AES-GCM chunk mode']
            ].map(([label, value]) => (
              <div key={label} className="flex items-center justify-between border-b border-white/10 pb-3 last:border-b-0 last:pb-0">
                <span className="text-[10px] font-mono uppercase tracking-[0.2em] text-white/42">{label}</span>
                <span className="text-sm font-medium text-white/86">{value}</span>
              </div>
            ))}
          </div>
        </div>
      </GlassPanel>
    </section>
  );
}
