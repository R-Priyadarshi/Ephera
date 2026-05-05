import { motion } from 'framer-motion';

export default function TrustSection() {
  return (
    <section id="trust" className="px-4 py-24 md:px-8 xl:px-12">
      <div className="mx-auto grid w-full max-w-[1820px] grid-cols-12 gap-8">
        <div className="col-span-12 xl:col-span-4">
          <p className="text-[11px] font-mono uppercase tracking-[0.3em] text-cyan-100/52">Trust / Proof</p>
          <h2 className="mt-5 max-w-[9ch] font-display text-[clamp(2.8rem,5vw,5rem)] font-semibold uppercase leading-[0.92] tracking-[-0.06em] text-white">
            Technical claims need hard edges.
          </h2>
        </div>

        <div className="col-span-12 xl:col-span-8">
          <div className="grid gap-5 lg:grid-cols-[1.2fr_0.8fr]">
            <div className="rounded-[38px] border border-white/10 bg-[linear-gradient(180deg,rgba(10,18,29,0.92),rgba(4,9,15,0.96))] p-7">
              <div className="grid gap-4 md:grid-cols-2">
                {[
                  'No payload ever touches a server.',
                  'Signaling is stateless and exits the path.',
                  'Abort ends the transfer cleanly and terminally.',
                  'Session state exists only while the runtime is alive.'
                ].map((statement, index) => (
                  <motion.div
                    key={statement}
                    initial={{ opacity: 0, y: 16 }}
                    whileInView={{ opacity: 1, y: 0 }}
                    viewport={{ once: true, amount: 0.4 }}
                    transition={{ duration: 0.38, delay: index * 0.06 }}
                    className="rounded-[24px] border border-white/10 bg-white/[0.03] p-5"
                  >
                    <p className="text-[10px] font-mono uppercase tracking-[0.22em] text-cyan-100/56">
                      Proof {index + 1}
                    </p>
                    <p className="mt-4 font-display text-2xl font-medium leading-[1.08] tracking-tight text-white">
                      {statement}
                    </p>
                  </motion.div>
                ))}
              </div>
            </div>

            <div className="grid gap-5">
              <div className="rounded-[32px] border border-white/10 bg-white/[0.03] p-6">
                <p className="text-[10px] font-mono uppercase tracking-[0.22em] text-white/46">Protocol posture</p>
                <div className="mt-6 space-y-4">
                  {[
                    ['Transport', 'WebRTC DataChannel'],
                    ['Envelope', 'AES-GCM chunks'],
                    ['Path', 'Peer ↔ peer'],
                    ['Retention', 'None by design']
                  ].map(([label, value]) => (
                    <div key={label} className="flex items-center justify-between border-b border-white/10 pb-3 last:border-none">
                      <span className="text-[10px] font-mono uppercase tracking-[0.18em] text-white/42">{label}</span>
                      <span className="text-sm text-white/84">{value}</span>
                    </div>
                  ))}
                </div>
              </div>

              <div className="rounded-[32px] border border-cyan-300/24 bg-cyan-300/8 p-6">
                <p className="text-[10px] font-mono uppercase tracking-[0.22em] text-cyan-100/58">Operator stance</p>
                <p className="mt-5 font-display text-3xl font-semibold leading-[1.02] tracking-tight text-white">
                  Ephera is a transport engine, not a vault pretending to be private.
                </p>
              </div>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
