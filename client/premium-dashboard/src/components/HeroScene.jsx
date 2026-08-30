import { motion } from 'framer-motion';

const proofPoints = [
  'Direct WebRTC lane',
  'Stateless signaling',
  'Deterministic teardown'
];

const metrics = [
  ['Retention', '0 bytes'],
  ['Route', 'Direct P2P'],
  ['Crypto', 'AES-GCM']
];

const nodes = [
  { label: 'Sender', tone: 'bg-cyan-300', x: '16%', y: '72%' },
  { label: 'Signal', tone: 'bg-amber-300', x: '46%', y: '54%' },
  { label: 'Peer', tone: 'bg-emerald-300', x: '66%', y: '70%' },
  { label: 'Crypto', tone: 'bg-indigo-300', x: '82%', y: '34%' },
  { label: 'Receiver', tone: 'bg-sky-300', x: '90%', y: '76%' }
];

const pulseBars = [34, 40, 37, 49, 46, 56, 58, 66, 70, 72];

function PacketPulse({ delay }) {
  return (
    <motion.span
      className="absolute left-[16%] top-[72%] hidden h-3 w-3 rounded-full bg-cyan-50 shadow-[0_0_18px_rgba(207,250,254,0.96)] md:block"
      animate={{
        x: [0, 120, 240, 372, 500],
        y: [0, -12, 12, -8, 8],
        opacity: [0, 1, 1, 1, 0],
        scale: [0.78, 1, 1, 0.92, 0.3]
      }}
      transition={{ duration: 3.4, repeat: Infinity, delay, ease: 'easeInOut' }}
    />
  );
}

function HeroVisual() {
  return (
    <div className="landing-panel-strong overflow-hidden p-4 sm:p-5 xl:p-6">
      <div className="landing-panel flex flex-col gap-4 px-4 py-4 sm:flex-row sm:items-center sm:justify-between sm:px-5">
        <div>
          <p className="landing-kicker">Live transfer scene</p>
          <p className="mt-1 text-sm leading-6 text-slate-300/78 sm:text-[0.95rem]">
            Session state, packet path, and transport pulse rendered as one lane.
          </p>
        </div>
        <div className="landing-status-pill shrink-0 self-start sm:self-auto">
          <motion.span
            className="h-2.5 w-2.5 rounded-full bg-emerald-300"
            animate={{ opacity: [0.42, 1, 0.42], scale: [1, 1.14, 1] }}
            transition={{ duration: 1.9, repeat: Infinity }}
          />
          <span className="landing-kicker text-cyan-100/76">No relay payload</span>
        </div>
      </div>

      <div className="mt-4 grid gap-4 xl:grid-cols-[minmax(0,1fr)_340px]">
        <div className="relative overflow-hidden rounded-[28px] border border-white/8 bg-[linear-gradient(180deg,rgba(8,15,25,0.98),rgba(6,11,19,1))] px-5 py-6 sm:px-6 sm:py-7">
          <div className="landing-grid-overlay absolute inset-0 opacity-[0.08]" />
          <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_58%_56%,rgba(22,89,191,0.24),transparent_24%),radial-gradient(circle_at_78%_76%,rgba(18,122,120,0.14),transparent_18%)]" />

          <div className="relative min-h-[320px] sm:min-h-[420px] xl:min-h-[520px]">
            <svg className="absolute inset-0 h-full w-full" viewBox="0 0 1000 620" preserveAspectRatio="none" aria-hidden="true">
              <line x1="170" y1="448" x2="456" y2="486" stroke="rgba(92,216,255,0.42)" strokeWidth="2" />
              <line x1="456" y1="294" x2="650" y2="232" stroke="rgba(189,231,255,0.34)" strokeWidth="2" />
              <line x1="652" y1="420" x2="860" y2="468" stroke="rgba(103,239,196,0.34)" strokeWidth="2" />
            </svg>

            {nodes.map((node, index) => (
              <motion.div
                key={node.label}
                className="absolute flex -translate-x-1/2 -translate-y-1/2 flex-col items-center gap-2"
                style={{ left: node.x, top: node.y }}
                animate={{ opacity: [0.58, 1, 0.58], scale: [1, 1.06, 1] }}
                transition={{ duration: 2.8, repeat: Infinity, delay: index * 0.12 }}
              >
                <div className={`h-4 w-4 rounded-full ${node.tone} shadow-[0_0_18px_rgba(103,232,249,0.24)]`} />
                <span className="landing-node-label hidden md:block">{node.label}</span>
              </motion.div>
            ))}

            {[0, 1.1, 2.2].map((delay) => (
              <PacketPulse key={delay} delay={delay} />
            ))}
          </div>
        </div>

        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-1">
          {metrics.map(([label, value]) => (
            <div key={label} className="landing-panel px-5 py-5 sm:px-6">
              <p className="landing-kicker">{label}</p>
              <p className="mt-4 text-[1.24rem] font-semibold tracking-[-0.05em] text-white sm:text-[1.5rem]">{value}</p>
            </div>
          ))}

          <div className="landing-panel px-5 py-5 sm:px-6">
            <div className="flex items-center justify-between gap-3">
              <p className="landing-kicker">Transfer pulse</p>
              <p className="landing-kicker text-cyan-100/74">Direct only</p>
            </div>
            <div className="mt-5 flex h-20 items-end gap-2 rounded-[18px] border border-white/8 bg-[#09131e] px-4 py-4">
              {pulseBars.map((height, index) => (
                <motion.span
                  key={`${height}-${index}`}
                  className="flex-1 rounded-t-full bg-gradient-to-t from-cyan-500/46 to-emerald-300/82"
                  style={{ height: `${height}%` }}
                  animate={{ opacity: [0.38, 1, 0.42], scaleY: [0.97, 1, 0.99] }}
                  transition={{ duration: 1.35, repeat: Infinity, delay: index * 0.05 }}
                />
              ))}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

export default function HeroScene({ onLaunchDashboard, scrollToSection }) {
  const scroll = (id) => {
    if (typeof scrollToSection === 'function') scrollToSection(id);
  };

  return (
    <section id="hero" className="landing-section landing-scroll-anchor pt-8 sm:pt-14 lg:pt-18">
      <div className="landing-container">
        <div className="grid items-center gap-10 lg:grid-cols-12 lg:gap-12 xl:gap-16">
          <div className="lg:col-span-5 lg:py-6">
            <p className="landing-kicker">Zero-memory peer-to-peer transport</p>
            <motion.h1
              className="landing-display mt-6 max-w-[9.6ch]"
              initial={{ opacity: 0, y: 18 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.44 }}
            >
              Move sensitive data peer-to-peer. Leave no trace.
            </motion.h1>

            <motion.p
              className="landing-body mt-8 max-w-[32rem]"
              initial={{ opacity: 0, y: 18 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.44, delay: 0.08 }}
            >
              Ephera opens a direct encrypted lane between peers, then keeps infrastructure outside the payload path. No storage backend. No transfer archive. No operator-readable copy.
            </motion.p>

            <motion.div
              className="mt-10 flex flex-col gap-4 sm:flex-row sm:flex-wrap"
              initial={{ opacity: 0, y: 18 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.44, delay: 0.14 }}
            >
              <button type="button" onClick={onLaunchDashboard} className="landing-button landing-button-primary">
                Launch Dashboard <span aria-hidden="true">→</span>
              </button>
              <button type="button" onClick={() => scroll('trust')} className="landing-button landing-button-secondary">
                Explore Trust Model
              </button>
            </motion.div>

            <motion.div
              className="mt-10 flex flex-wrap gap-3"
              initial={{ opacity: 0, y: 18 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.44, delay: 0.2 }}
            >
              {proofPoints.map((point) => (
                <div key={point} className="landing-chip">
                  <span className="landing-chip-dot" />
                  <span>{point}</span>
                </div>
              ))}
            </motion.div>
          </div>

          <motion.div
            className="lg:col-span-7"
            initial={{ opacity: 0, y: 18 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.5, delay: 0.14 }}
          >
            <HeroVisual />
          </motion.div>
        </div>
      </div>
    </section>
  );
}
