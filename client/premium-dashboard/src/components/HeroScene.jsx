import { motion } from 'framer-motion';

function PacketTrail({ className, duration, delay = 0 }) {
  return (
    <motion.div
      className={`absolute h-3 w-3 rounded-full bg-cyan-200 shadow-[0_0_20px_rgba(113,240,255,0.95)] ${className}`}
      animate={{
        x: [0, 80, 188, 272, 360],
        y: [0, -24, 18, -12, 32],
        opacity: [0, 1, 1, 1, 0]
      }}
      transition={{
        duration,
        delay,
        repeat: Infinity,
        repeatDelay: 0.2,
        ease: 'easeInOut'
      }}
    />
  );
}

function Node({ x, y, label, tone, delay }) {
  return (
    <motion.div
      className="absolute"
      style={{ left: x, top: y }}
      animate={{ scale: [1, 1.15, 1], opacity: [0.72, 1, 0.72] }}
      transition={{ duration: 2.6, repeat: Infinity, delay }}
    >
      <div
        className={`h-4 w-4 rounded-full ${tone} shadow-[0_0_0_10px_rgba(69,215,255,0.08),0_0_40px_rgba(69,215,255,0.35)]`}
      />
      <p className="mt-3 whitespace-nowrap text-[10px] font-mono uppercase tracking-[0.18em] text-white/48">
        {label}
      </p>
    </motion.div>
  );
}

function HeroVisual() {
  return (
    <div className="relative h-full min-h-[680px] w-full overflow-hidden rounded-[40px] border border-white/10 bg-[radial-gradient(circle_at_54%_42%,rgba(34,91,180,0.45),transparent_28%),radial-gradient(circle_at_74%_68%,rgba(35,216,255,0.18),transparent_22%),linear-gradient(180deg,rgba(12,22,36,0.95),rgba(5,11,18,0.92))] shadow-[0_40px_120px_rgba(0,0,0,0.45)] xl:min-h-[880px]">
      <div className="absolute inset-0 bg-[radial-gradient(circle_at_30%_30%,rgba(255,255,255,0.06),transparent_18%),linear-gradient(180deg,rgba(255,255,255,0.06),transparent_28%)]" />
      <div className="absolute inset-0 opacity-[0.18] [background-image:linear-gradient(rgba(255,255,255,0.08)_1px,transparent_1px),linear-gradient(90deg,rgba(255,255,255,0.08)_1px,transparent_1px)] [background-size:56px_56px]" />

      <div className="absolute inset-x-8 top-8 bottom-[190px] z-10 overflow-hidden rounded-[30px] border border-white/6 bg-[radial-gradient(circle_at_48%_42%,rgba(46,151,255,0.18),transparent_24%),linear-gradient(180deg,rgba(255,255,255,0.02),transparent_28%)]">
        <div className="absolute left-[14%] top-[66%] h-px w-[30%] rotate-[8deg] bg-gradient-to-r from-cyan-300/55 to-transparent" />
        <div className="absolute left-[40%] top-[42%] h-px w-[22%] rotate-[-16deg] bg-gradient-to-r from-white/40 to-cyan-300/55" />
        <div className="absolute left-[57%] top-[60%] h-px w-[17%] rotate-[18deg] bg-gradient-to-r from-cyan-300/55 to-emerald-300/55" />
        <div className="absolute left-[48%] top-[24%] h-px w-[14%] rotate-[42deg] bg-gradient-to-r from-indigo-300/40 to-orange-300/55" />

        <Node x="10%" y="63%" label="Sender Device" tone="bg-cyan-300" delay={0} />
        <Node x="38%" y="43%" label="Signal Relay" tone="bg-orange-300" delay={0.25} />
        <Node x="56%" y="60%" label="Peer Channel" tone="bg-emerald-300" delay={0.45} />
        <Node x="74%" y="22%" label="Crypto Handshake" tone="bg-indigo-300" delay={0.65} />
        <Node x="84%" y="64%" label="Receiver Device" tone="bg-sky-300" delay={0.85} />

        <PacketTrail className="left-[16%] top-[58%]" duration={3.8} />
        <PacketTrail className="left-[16%] top-[58%]" duration={3.8} delay={1.4} />
        <PacketTrail className="left-[16%] top-[58%]" duration={3.8} delay={2.8} />
      </div>

      <div className="absolute inset-x-8 bottom-8 z-20 rounded-[28px] border border-white/10 bg-[linear-gradient(180deg,rgba(7,16,26,0.86),rgba(7,12,21,0.92))] p-6 backdrop-blur-xl">
        <div className="grid gap-4 md:grid-cols-[1.1fr_0.9fr]">
          <div>
            <p className="text-[10px] font-mono uppercase tracking-[0.24em] text-cyan-100/58">
              Live transfer scene
            </p>
            <div className="mt-4 grid gap-3 sm:grid-cols-3">
              {[
                ['Retention', '0 bytes'],
                ['Route', 'Direct P2P'],
                ['Crypto', 'AES-GCM']
              ].map(([label, value]) => (
                <div key={label} className="rounded-2xl border border-white/10 bg-white/[0.03] px-4 py-3">
                  <p className="text-[10px] font-mono uppercase tracking-[0.18em] text-white/48">{label}</p>
                  <p className="mt-3 font-display text-2xl font-semibold tracking-tight text-white">{value}</p>
                </div>
              ))}
            </div>
          </div>

          <div className="rounded-[24px] border border-white/10 bg-white/[0.025] px-4 py-4">
            <div className="mb-3 flex items-center justify-between">
              <p className="text-[10px] font-mono uppercase tracking-[0.22em] text-white/46">Transfer pulse</p>
              <p className="text-[10px] font-mono uppercase tracking-[0.22em] text-cyan-100/62">no relay payload</p>
            </div>
            <div className="grid grid-cols-12 gap-2">
              {[42, 58, 52, 68, 61, 77, 72, 86, 78, 82, 74, 92].map((height, index) => (
                <motion.span
                  key={height + index}
                  className="rounded-t-full bg-gradient-to-t from-cyan-300/60 via-sky-300/80 to-emerald-300/80"
                  style={{ height: `${height}px` }}
                  animate={{ opacity: [0.4, 1, 0.5], scaleY: [0.88, 1, 0.92] }}
                  transition={{ duration: 1.4, repeat: Infinity, delay: index * 0.08 }}
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
    <section className="relative flex min-h-[calc(100svh-88px)] items-center px-4 pb-20 pt-44 md:px-8 md:pt-48 xl:px-12 xl:pt-52">
      <div className="mx-auto grid w-full max-w-[1760px] grid-cols-12 items-stretch gap-8 xl:gap-12">
        <div className="col-span-12 flex flex-col justify-center xl:col-span-5 xl:py-6">
          <motion.p
            initial={{ opacity: 0, y: 18 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.45 }}
            className="text-[11px] font-mono uppercase tracking-[0.32em] text-cyan-100/54"
          >
            Zero-memory peer-to-peer transport
          </motion.p>
          <motion.h1
            initial={{ opacity: 0, y: 24 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.62, delay: 0.08 }}
            className="mt-6 max-w-[8.5ch] font-display text-[clamp(4.2rem,8vw,8.4rem)] font-semibold uppercase leading-[0.88] tracking-[-0.08em] text-white text-shadow-soft"
          >
            Move Sensitive Data Peer-to-Peer. Leave No Trace.
          </motion.h1>
          <motion.p
            initial={{ opacity: 0, y: 24 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.62, delay: 0.16 }}
            className="mt-8 max-w-xl text-lg leading-8 text-white/64"
          >
            Ephera is a zero-memory transport system for direct, encrypted data movement between peers.
            No storage backend. No transfer archive. No payload ever touches a server.
          </motion.p>

          <motion.div
            initial={{ opacity: 0, y: 24 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.62, delay: 0.24 }}
            className="mt-10 flex flex-wrap items-center gap-4"
          >
            <button
              type="button"
              onClick={onLaunchDashboard}
              className="group inline-flex items-center gap-3 rounded-full border border-cyan-300/35 bg-cyan-300/14 px-6 py-3 text-[11px] font-mono uppercase tracking-[0.22em] text-cyan-100 transition duration-200 hover:border-cyan-200/60 hover:bg-cyan-300/22"
            >
              Launch Dashboard
              <span className="transition duration-200 group-hover:translate-x-1">→</span>
            </button>
            <button
              type="button"
              onClick={() => scroll('trust')}
              className="inline-flex items-center gap-3 rounded-full border border-white/12 bg-white/[0.04] px-6 py-3 text-[11px] font-mono uppercase tracking-[0.22em] text-white/78 transition duration-200 hover:border-white/20 hover:bg-white/[0.08]"
            >
              Explore Trust Model
            </button>
          </motion.div>

          <motion.div
            initial={{ opacity: 0, y: 24 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.62, delay: 0.32 }}
            className="mt-12"
          >
            <div className="flex flex-wrap gap-3">
              {[
                'Direct WebRTC DataChannel path',
                'Stateless signaling only',
                'Deterministic abort and teardown'
              ].map((item) => (
                <div
                  key={item}
                  className="inline-flex items-center gap-3 rounded-full border border-white/10 bg-white/[0.04] px-4 py-2.5 backdrop-blur-xl"
                >
                  <span className="h-2 w-2 rounded-full bg-cyan-300 shadow-[0_0_18px_rgba(69,215,255,0.6)]" />
                  <span className="text-[11px] font-mono uppercase tracking-[0.18em] text-white/74">{item}</span>
                </div>
              ))}
            </div>
          </motion.div>
        </div>

        <div className="col-span-12 xl:col-span-7 xl:min-h-[880px]">
          <HeroVisual />
        </div>
      </div>
    </section>
  );
}
