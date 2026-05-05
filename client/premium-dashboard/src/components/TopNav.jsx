import { motion } from 'framer-motion';

function PulseState() {
  return (
    <div className="grid min-w-[320px] grid-cols-[auto_1fr_auto] items-center gap-4 rounded-[22px] border border-cyan-300/22 bg-[linear-gradient(180deg,rgba(14,31,49,0.96),rgba(8,20,31,0.92))] px-4 py-3 shadow-[0_18px_50px_rgba(0,0,0,0.32)]">
      <div className="relative flex h-9 w-9 items-center justify-center rounded-xl border border-cyan-300/28 bg-cyan-300/10">
        <motion.span
          className="absolute h-3 w-3 rounded-full bg-emerald-300"
          animate={{ opacity: [0.35, 1, 0.35], scale: [1, 1.35, 1] }}
          transition={{ duration: 1.8, repeat: Infinity }}
        />
      </div>
      <div>
        <p className="text-[10px] font-mono uppercase tracking-[0.24em] text-cyan-200/60">System State</p>
        <p className="text-sm font-medium text-cyan-50">Direct path stable · crypto verified</p>
      </div>
      <div className="hidden gap-1.5 sm:flex">
        {['room', 'channel', 'peer', 'crypto', 'transfer'].map((item, index) => (
          <motion.span
            key={item}
            className="h-1.5 w-6 rounded-sm bg-cyan-300/60"
            animate={{ opacity: [0.25, 1, 0.25] }}
            transition={{ duration: 1.4, repeat: Infinity, delay: index * 0.08 }}
          />
        ))}
      </div>
    </div>
  );
}

function ActionButton({ label, tone = 'default' }) {
  const toneClass =
    tone === 'primary'
      ? 'border-cyan-300/40 bg-cyan-300/14 text-cyan-100 hover:bg-cyan-300/22'
      : tone === 'warm'
        ? 'border-orange-300/35 bg-orange-300/10 text-orange-100 hover:bg-orange-300/18'
        : 'border-white/12 bg-white/[0.03] text-white/82 hover:bg-white/[0.07]';

  return (
    <button
      type="button"
      className={`rounded-2xl border px-4 py-3 text-[10px] font-mono uppercase tracking-[0.2em] transition duration-200 ${toneClass}`}
    >
      {label}
    </button>
  );
}

export default function TopNav() {
  return (
    <motion.header
      initial={{ opacity: 0, y: -20 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.45 }}
      className="sticky top-0 z-50 mb-8 border-b border-white/10 bg-[rgba(5,12,20,0.7)] px-6 py-5 backdrop-blur-2xl"
    >
      <div className="mx-auto grid max-w-[1720px] grid-cols-12 items-center gap-5">
        <div className="col-span-12 flex items-center gap-4 lg:col-span-3">
          <div className="grid h-12 w-12 place-items-center rounded-2xl border border-cyan-200/22 bg-[linear-gradient(160deg,#1c5168,#0d2d46)] text-cyan-50 shadow-[0_14px_30px_rgba(13,91,129,0.4)]">
            <span className="font-display text-lg font-bold">E</span>
          </div>
          <div>
            <p className="text-[10px] font-mono uppercase tracking-[0.24em] text-cyan-200/55">Zero-memory transport system</p>
            <h1 className="font-display text-lg font-semibold tracking-tight text-white">Ephera Transfer Core</h1>
          </div>
        </div>

        <div className="col-span-12 flex justify-center lg:col-span-5">
          <PulseState />
        </div>

        <div className="col-span-12 flex flex-wrap items-center justify-end gap-2 lg:col-span-4">
          <ActionButton label="Trust Model" />
          <ActionButton label="Launch Dashboard" tone="primary" />
          <ActionButton label="Direct P2P" tone="warm" />
        </div>
      </div>
    </motion.header>
  );
}
