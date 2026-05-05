import { motion } from 'framer-motion';

function FadePacket({ delay, className }) {
  return (
    <motion.div
      className={`absolute h-3 w-3 rounded-full bg-cyan-200 shadow-[0_0_22px_rgba(113,240,255,0.95)] ${className}`}
      animate={{
        x: [0, 110, 220, 300],
        opacity: [0, 1, 1, 0],
        scale: [0.8, 1, 1, 0.7]
      }}
      transition={{ duration: 2.8, repeat: Infinity, delay, ease: 'easeInOut' }}
    />
  );
}

export default function ZeroMemoryArchitecture() {
  return (
    <section id="architecture" className="px-4 py-24 md:px-8 xl:px-12">
      <div className="mx-auto grid w-full max-w-[1820px] grid-cols-12 gap-8">
        <div className="col-span-12 xl:col-span-7">
          <div className="relative overflow-hidden rounded-[40px] border border-white/10 bg-[linear-gradient(180deg,rgba(11,22,36,0.92),rgba(5,10,17,0.96))] p-8 shadow-[0_40px_120px_rgba(0,0,0,0.45)]">
            <div className="absolute inset-0 bg-[radial-gradient(circle_at_50%_35%,rgba(69,215,255,0.12),transparent_28%)]" />
            <div className="relative z-10">
              <p className="text-[11px] font-mono uppercase tracking-[0.3em] text-cyan-100/52">
                Zero Memory Architecture
              </p>
              <div className="mt-10 grid items-center gap-6 md:grid-cols-[1fr_auto_1fr]">
                <div className="rounded-[28px] border border-cyan-300/20 bg-cyan-300/8 p-6 text-center">
                  <p className="text-[10px] font-mono uppercase tracking-[0.22em] text-cyan-100/62">Sender</p>
                  <p className="mt-3 font-display text-3xl font-semibold tracking-tight text-white">Device A</p>
                </div>

                <div className="relative h-[240px] min-w-[340px]">
                  <div className="absolute inset-x-4 top-1/2 h-px -translate-y-1/2 bg-gradient-to-r from-cyan-300/60 via-sky-300/70 to-emerald-300/60" />
                  <div className="absolute left-1/2 top-[22%] -translate-x-1/2 rounded-full border border-red-300/24 bg-red-300/10 px-4 py-2">
                    <p className="text-[10px] font-mono uppercase tracking-[0.22em] text-red-100/70">No storage node</p>
                  </div>
                  <div className="absolute left-1/2 top-[36%] flex h-20 w-20 -translate-x-1/2 items-center justify-center rounded-full border border-red-300/20 bg-red-300/8">
                    <span className="font-display text-4xl text-red-100/70">∅</span>
                  </div>
                  <div className="absolute left-1/2 top-[50%] h-[170px] w-px -translate-x-1/2 rotate-45 bg-red-300/30" />
                  <div className="absolute left-1/2 top-[50%] h-[170px] w-px -translate-x-1/2 -rotate-45 bg-red-300/30" />
                  <FadePacket delay={0} className="left-[8%] top-[48%]" />
                  <FadePacket delay={0.9} className="left-[8%] top-[48%]" />
                  <FadePacket delay={1.8} className="left-[8%] top-[48%]" />
                </div>

                <div className="rounded-[28px] border border-emerald-300/20 bg-emerald-300/8 p-6 text-center">
                  <p className="text-[10px] font-mono uppercase tracking-[0.22em] text-emerald-100/62">Receiver</p>
                  <p className="mt-3 font-display text-3xl font-semibold tracking-tight text-white">Device B</p>
                </div>
              </div>

              <div className="mt-10 grid gap-4 md:grid-cols-3">
                {[
                  ['Signal only', 'Server coordinates peers and exits'],
                  ['No retention', 'Packets fade the moment transfer ends'],
                  ['Ephemeral path', 'Transport exists only while the session is alive']
                ].map(([label, value]) => (
                  <div key={label} className="rounded-[24px] border border-white/10 bg-white/[0.03] px-5 py-5">
                    <p className="text-[10px] font-mono uppercase tracking-[0.2em] text-white/44">{label}</p>
                    <p className="mt-4 text-sm leading-6 text-white/72">{value}</p>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </div>

        <div className="col-span-12 flex flex-col gap-5 xl:col-span-5">
          <div className="rounded-[32px] border border-white/10 bg-white/[0.035] px-7 py-8">
            <p className="text-[10px] font-mono uppercase tracking-[0.22em] text-cyan-100/56">What disappears</p>
            <div className="mt-8 space-y-5">
              {[
                'No payload cache',
                'No transfer archive',
                'No operator-readable copy',
                'No post-session recovery path'
              ].map((item) => (
                <div key={item} className="flex items-center gap-4">
                  <span className="grid h-9 w-9 place-items-center rounded-full border border-red-300/24 bg-red-300/8 text-red-100/76">
                    ×
                  </span>
                  <span className="font-display text-2xl font-medium tracking-tight text-white">{item}</span>
                </div>
              ))}
            </div>
          </div>

          <div className="rounded-[32px] border border-white/10 bg-[linear-gradient(180deg,rgba(16,29,47,0.76),rgba(8,15,24,0.92))] px-7 py-8">
            <p className="text-[10px] font-mono uppercase tracking-[0.22em] text-white/48">Boundary statement</p>
            <p className="mt-5 font-display text-[clamp(2rem,3.2vw,3rem)] font-semibold leading-[1.02] tracking-[-0.05em] text-white">
              Payloads cross a live channel. They do not land on infrastructure.
            </p>
          </div>
        </div>
      </div>
    </section>
  );
}
