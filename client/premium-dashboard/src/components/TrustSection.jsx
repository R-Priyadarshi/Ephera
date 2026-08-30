const claims = [
  'No payload ever touches a server.',
  'Signaling is stateless and exits the path.',
  'Abort ends the transfer cleanly and terminally.',
  'Session state exists only while the runtime is alive.'
];

const protocol = [
  ['Transport', 'WebRTC DataChannel'],
  ['Envelope', 'AES-GCM chunks'],
  ['Path', 'Peer ↔ peer'],
  ['Retention', 'None by design']
];

export default function TrustSection() {
  return (
    <section id="trust" className="landing-section landing-scroll-anchor">
      <div className="landing-container">
        <div className="grid gap-8 lg:grid-cols-12 lg:gap-10">
          <div className="lg:col-span-4">
            <p className="landing-kicker">Trust / proof</p>
            <h2 className="landing-title mt-4 max-w-[10ch]">Technical claims need hard edges.</h2>
            <p className="landing-copy-soft mt-6 max-w-[25rem]">
              The product only earns trust if the interface can explain the transport path without softening what the system actually does and does not keep.
            </p>
          </div>

          <div className="grid gap-5 lg:col-span-8 2xl:grid-cols-[minmax(0,1fr)_300px]">
            <div className="grid gap-5 md:grid-cols-2">
              {claims.map((claim, index) => (
                <article key={claim} className="landing-panel px-6 py-7 sm:px-7">
                  <p className="landing-kicker">Proof {index + 1}</p>
                  <p className="mt-5 text-[1.24rem] font-semibold leading-[1.16] tracking-[-0.04em] text-white sm:text-[1.46rem]">
                    {claim}
                  </p>
                </article>
              ))}
            </div>

            <div className="grid gap-5">
              <article className="landing-panel px-6 py-7 sm:px-7">
                <p className="landing-kicker">Protocol posture</p>
                <div className="mt-6 grid gap-4">
                  {protocol.map(([label, value]) => (
                    <div key={label} className="flex items-center justify-between gap-4 rounded-[18px] border border-white/10 bg-white/[0.03] px-4 py-4">
                      <span className="landing-kicker text-slate-400">{label}</span>
                      <span className="text-right text-base text-white">{value}</span>
                    </div>
                  ))}
                </div>
              </article>

              <article className="landing-panel-strong px-6 py-8 sm:px-7 sm:py-9">
                <p className="landing-kicker">Operator stance</p>
                <p className="mt-5 text-[clamp(1.75rem,2.1vw,2.3rem)] font-semibold leading-[1.08] tracking-[-0.05em] text-white">
                  Ephera is a transport engine, not a vault pretending to be private.
                </p>
              </article>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
