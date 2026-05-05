import { motion } from 'framer-motion';

function NavButton({ label, onClick, tone = 'default' }) {
  const toneClass =
    tone === 'primary'
      ? 'border-cyan-300/40 bg-cyan-300/14 text-cyan-100 hover:border-cyan-200/60 hover:bg-cyan-300/24'
      : tone === 'warm'
        ? 'border-orange-300/30 bg-orange-300/10 text-orange-100 hover:border-orange-200/50 hover:bg-orange-300/16'
        : 'border-white/10 bg-white/[0.03] text-white/72 hover:border-white/20 hover:bg-white/[0.08]';

  return (
    <button
      type="button"
      onClick={onClick}
      className={`inline-flex items-center gap-2 rounded-full border px-4 py-2 text-[11px] font-mono uppercase tracking-[0.18em] transition duration-200 ${toneClass}`}
    >
      {label}
    </button>
  );
}

export default function LandingNav({ onLaunchDashboard, scrollToSection }) {
  const scroll = (id) => {
    if (typeof scrollToSection === 'function') scrollToSection(id);
  };

  return (
    <motion.header
      initial={{ opacity: 0, y: -18 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.5 }}
      className="fixed inset-x-0 top-0 z-50 px-4 py-4 md:px-6"
    >
      <div className="mx-auto grid max-w-[1720px] grid-cols-12 items-center gap-4 rounded-[28px] border border-white/10 bg-[linear-gradient(180deg,rgba(9,17,28,0.82),rgba(7,12,21,0.72))] px-4 py-3 shadow-[0_24px_80px_rgba(0,0,0,0.45)] backdrop-blur-2xl md:px-5">
        <div className="col-span-12 flex items-center gap-4 lg:col-span-3">
          <div className="grid h-12 w-12 place-items-center rounded-2xl border border-cyan-300/30 bg-[linear-gradient(145deg,rgba(46,151,255,0.28),rgba(23,51,86,0.84))] shadow-[0_0_0_1px_rgba(69,215,255,0.18),0_18px_40px_rgba(0,0,0,0.35)]">
            <span className="font-display text-lg font-semibold text-cyan-50">E</span>
          </div>
          <div>
            <p className="text-[10px] font-mono uppercase tracking-[0.26em] text-cyan-100/50">
              Zero-memory transport
            </p>
            <p className="font-display text-lg font-semibold tracking-tight text-white">EPHERA</p>
          </div>
        </div>

        <div className="col-span-12 flex justify-center lg:col-span-4">
          <div className="grid min-w-[320px] grid-cols-[auto_1fr_auto] items-center gap-4 rounded-full border border-white/10 bg-white/[0.025] px-4 py-2.5">
            <motion.span
              className="h-2.5 w-2.5 rounded-full bg-cyan-300 shadow-[0_0_18px_rgba(69,215,255,0.8)]"
              animate={{ opacity: [0.4, 1, 0.4], scale: [1, 1.25, 1] }}
              transition={{ duration: 2.2, repeat: Infinity }}
            />
            <div>
              <p className="text-[10px] font-mono uppercase tracking-[0.22em] text-white/46">
                System state
              </p>
              <p className="text-sm text-white/88">Server only coordinates. Payload path stays peer-bound.</p>
            </div>
            <div className="hidden items-center gap-1.5 sm:flex">
              {['room', 'signal', 'channel', 'peer', 'crypto', 'send'].map((item, index) => (
                <motion.span
                  key={item}
                  className="h-1.5 w-5 rounded-full bg-cyan-300/70"
                  animate={{ opacity: [0.25, 1, 0.25] }}
                  transition={{ duration: 1.4, repeat: Infinity, delay: index * 0.08 }}
                />
              ))}
            </div>
          </div>
        </div>

        <div className="col-span-12 flex flex-wrap items-center justify-end gap-2 lg:col-span-5">
          <NavButton label="Explore Trust Model" onClick={() => scroll('trust')} />
          <NavButton label="Launch Dashboard" onClick={onLaunchDashboard} tone="primary" />
          <NavButton label="Direct P2P" onClick={() => scroll('architecture')} tone="warm" />
        </div>
      </div>
    </motion.header>
  );
}
