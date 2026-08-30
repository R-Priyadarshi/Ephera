import { motion } from 'framer-motion';

const disappear = [
  'No payload cache',
  'No transfer archive',
  'No operator-readable copy',
  'No post-session recovery path'
];

const notes = [
  ['Signal only', 'Server coordinates peers and exits'],
  ['No retention', 'Packets fade the moment transfer ends'],
  ['Ephemeral path', 'Transport exists only while the session is alive']
];

function Packet({ delay }) {
  return (
    <motion.span
      className="absolute left-[18%] top-1/2 hidden h-3 w-3 -translate-y-1/2 rounded-full bg-cyan-100 shadow-[0_0_18px_rgba(207,250,254,0.9)] md:block"
      animate={{ x: [0, 180, 360, 540], opacity: [0, 1, 1, 0], scale: [0.82, 1, 1, 0.3] }}
      transition={{ duration: 2.8, repeat: Infinity, delay, ease: 'easeInOut' }}
    />
  );
}

export default function ZeroMemoryArchitecture() {
  return (
    <section id="architecture" className="landing-section landing-scroll-anchor">
      <div className="landing-container">
        <div className="grid gap-8 lg:grid-cols-12 lg:gap-10">
          <div className="lg:col-span-7">
            <div className="landing-panel-strong p-6 sm:p-7 xl:p-8">
              <p className="landing-kicker">Zero-memory architecture</p>
              <h2 className="landing-title mt-4 max-w-[12ch]">The transport exists only while the session is alive.</h2>

              <div className="relative mt-7 overflow-hidden rounded-[28px] border border-white/8 bg-[linear-gradient(180deg,rgba(8,15,25,0.98),rgba(6,11,19,1))] px-5 py-7 sm:px-6 sm:py-8">
                <div className="landing-grid-overlay absolute inset-0 opacity-[0.08]" />
                <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_48%_46%,rgba(16,117,136,0.16),transparent_24%)]" />

                {[0, 1, 2].map((delay) => (
                  <Packet key={delay} delay={delay} />
                ))}

                <div className="relative grid gap-6 md:grid-cols-[minmax(0,1fr)_160px_minmax(0,1fr)] md:items-center xl:grid-cols-[minmax(0,1fr)_180px_minmax(0,1fr)]">
                  <div className="landing-panel border-cyan-300/18 bg-cyan-300/[0.05] px-6 py-8 text-center sm:py-10">
                    <p className="landing-kicker text-cyan-100/66">Sender</p>
                    <p className="mt-4 text-[clamp(1.8rem,2.4vw,2.6rem)] font-semibold tracking-[-0.05em] text-white">Device A</p>
                  </div>

                  <div className="flex flex-col items-center gap-4">
                    <span className="rounded-full border border-red-300/16 bg-red-300/[0.08] px-4 py-2 text-center font-mono text-[0.72rem] uppercase tracking-[0.18em] text-red-100/78">
                      No storage node
                    </span>
                    <div className="grid h-24 w-24 place-items-center rounded-full border border-red-300/18 bg-red-300/[0.08] sm:h-28 sm:w-28">
                      <span className="text-5xl text-red-100/82">∅</span>
                    </div>
                  </div>

                  <div className="landing-panel border-emerald-300/18 bg-emerald-300/[0.05] px-6 py-8 text-center sm:py-10">
                    <p className="landing-kicker text-emerald-100/66">Receiver</p>
                    <p className="mt-4 text-[clamp(1.8rem,2.4vw,2.6rem)] font-semibold tracking-[-0.05em] text-white">Device B</p>
                  </div>
                </div>

                <div className="relative mt-8 grid gap-4 md:grid-cols-3">
                  {notes.map(([label, copy]) => (
                    <div key={label} className="landing-panel px-5 py-5">
                      <p className="landing-kicker">{label}</p>
                      <p className="mt-4 text-[0.98rem] leading-7 text-slate-300/78">{copy}</p>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          </div>

          <div className="grid gap-6 lg:col-span-5 lg:grid-rows-[auto_auto]">
            <div className="landing-panel px-6 py-7 sm:px-7">
              <p className="landing-kicker">What disappears</p>
              <div className="mt-6 grid gap-5">
                {disappear.map((item) => (
                  <div key={item} className="flex items-center gap-4">
                    <span className="grid h-11 w-11 place-items-center rounded-full border border-red-300/12 bg-red-300/[0.08] text-red-100/70">
                      ×
                    </span>
                    <span className="text-[1.04rem] font-medium leading-7 text-white">{item}</span>
                  </div>
                ))}
              </div>
            </div>

            <div className="landing-panel-strong px-6 py-8 sm:px-7 sm:py-9">
              <p className="landing-kicker">Boundary statement</p>
              <h3 className="mt-5 max-w-[14ch] text-[clamp(2rem,2.7vw,3rem)] font-semibold leading-[1.04] tracking-[-0.055em] text-white">
                Payloads cross a live channel. They never land on infrastructure.
              </h3>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
