import { motion } from 'framer-motion';

const quickSteps = [
  {
    title: 'Open Ephera on both devices',
    short: 'One device will host. The other device will join.',
    details: [
      'Open https://ephera.onrender.com on both devices. Chrome or Edge gives the fullest folder-saving experience.',
      'Press Launch Dashboard on each device. Keep both browser tabs open, both devices awake, and both devices connected to the internet.',
      'Look at Environment Preflight. WebRTC must be available. HTTPS, folder access, and clipboard support are checked separately.'
    ]
  },
  {
    title: 'Device A hosts the room',
    short: 'The host opens a temporary private meeting place.',
    details: [
      'On Device A, press Host Secure Session. Ephera creates a Room ID and Room Auth Key when those boxes are empty.',
      'Ephera also creates a random Secure Mode passphrase when the host has not entered one. The host becomes the room owner.',
      'Creating a room sends no file. It only prepares the temporary signaling boundary and waits for Device B.'
    ]
  },
  {
    title: 'Share one trusted invitation',
    short: 'Give Device B the temporary keys needed to enter.',
    details: [
      'The easiest option is Copy Invite Package. Send that package to the intended receiver through a trusted private message.',
      'You can instead share the Join Link or show the Invite QR. A QR contains room secrets, so do not display it where strangers can scan it.',
      'A normal join link includes the Room Auth Key but not the passphrase. Share the passphrase separately unless you deliberately enable Include passphrase in join link.'
    ]
  },
  {
    title: 'Device B joins',
    short: 'The receiver uses the invitation to meet Device A.',
    details: [
      'Paste the package and press Apply + Join, open the join link, scan the QR image, or use Start Camera Scan.',
      'Apply Package fills the fields without joining. Apply + Join fills them and joins immediately. A valid scanned QR also joins immediately.',
      'Wait for the state strip to show signaling online and P2P up. This means the two browsers have opened their WebRTC lane.'
    ]
  },
  {
    title: 'Device B chooses what receiving means',
    short: 'The receiver, not the sender, decides where bytes go.',
    details: [
      'Choose Pick Receive Folder to save incoming files. Approve the browser permission and select the destination folder.',
      'Choose Ready (Discard) when you only want to verify the transfer. Ephera reads the incoming stream and throws it away instead of saving a file.',
      'The receiver must choose one of these modes before Send unlocks on Device A. The sender cannot choose or change the receiver\'s folder.'
    ]
  },
  {
    title: 'Device A chooses and sends',
    short: 'Files move only after every safety gate is green.',
    details: [
      'Use Choose Files for one or many files, Choose Folder for a folder tree, or drop files/folders into the transfer bay.',
      'Check the room, P2P, peer ready, and crypto chips. If Send is disabled, the text directly below it explains the missing step.',
      'Press Send. Watch each row for bytes, percentage, speed, completion, and the receiver\'s saved-or-discarded receipt.'
    ]
  },
  {
    title: 'Finish cleanly',
    short: 'End the temporary lane when both people are done.',
    details: [
      'Wait for a successful delivery receipt before closing either tab. Sent means streaming finished; delivered confirms what the receiver did.',
      'Press Disconnect to leave without closing the room for everyone. The owner can press Close Room to remove the room for all connected peers.',
      'Ephera keeps no cloud copy or recovery history. Refreshing, closing, disconnecting, or aborting means a failed transfer must start again from the beginning.'
    ]
  }
];

const manualChapters = [
  {
    number: '01',
    eyebrow: 'Invitations',
    title: 'Every way to bring in the second device',
    intro: 'An invitation is like a temporary ticket. It identifies the room and proves that the joining device was invited.',
    items: [
      ['Invite Package', 'Contains the Room ID, Room Auth Key, join link, and a passphrase snapshot. Copy it only after hosting a room. Ephera accepts its own text format, a supported JSON package, or a raw join link.'],
      ['Paste Package', 'Reads clipboard text when the browser allows it. If clipboard permission is blocked, click the text box and paste manually.'],
      ['Apply Package', 'Checks the package and fills Room ID, Room Auth Key, and passphrase when present. It does not connect yet.'],
      ['Apply + Join', 'Checks the package, fills its values, and immediately starts joining. Missing or invalid room credentials fail closed.'],
      ['Join Link', 'Copy Link copies the generated invitation. Share opens the device share sheet when available. Opening that link automatically joins. Secret values use the URL fragment so they are not sent in the normal HTTP request, and Ephera removes them from the address bar after reading them.'],
      ['Show Invite QR', 'Draws the invitation locally. Clear QR removes it from the screen. Scan QR Image reads a screenshot/photo. Start Camera Scan begins live scanning, and Stop Camera turns off the preview and releases the camera.'],
      ['Share buttons', 'On browsers with the system Share API, Share opens the device share sheet. Otherwise Ephera falls back to copying when possible.']
    ]
  },
  {
    number: '02',
    eyebrow: 'Rooms',
    title: 'Manual controls and room ownership',
    intro: 'The big Host and Join buttons are shortcuts. Operator Console exposes the same room controls one piece at a time.',
    items: [
      ['Room ID', 'Names the temporary room. Generate makes a random ID. Two devices must use the exact same ID.'],
      ['Room Auth Key', 'Acts like the room password. Generate Key makes a strong random key. A join is rejected when the key is missing or wrong.'],
      ['Create and Join', 'Create opens the room and makes that device the owner. Join enters an existing room with its ID and auth key. Ephera rooms are built for the two transfer peers.'],
      ['Disconnect', 'Leaves the current session and clears ephemeral local state. It does not delete a file that the receiver already saved.'],
      ['Rotate Room Key', 'Owner-only. It replaces the admission key so old invitations stop admitting new joins. Share a newly generated invitation after rotating.'],
      ['Close Room', 'Owner-only. It closes the signaling room for everyone. If an owner simply leaves while another peer remains, ownership can move to the remaining peer.'],
      ['State strip', 'Signaling tells you whether the meeting service is connected. P2P tells you whether the browser-to-browser lane is open. Peer, crypto, and role explain readiness, encryption, and ownership.']
    ]
  },
  {
    number: '03',
    eyebrow: 'Receiving',
    title: 'Save mode, discard mode, and destination tools',
    intro: 'Nothing is automatically written to disk. The receiving person must make a clear local choice.',
    items: [
      ['Pick Receive Folder', 'Uses the browser folder picker and asks for read/write permission. Incoming folders keep safe relative paths when the browser provides them. Existing names are changed safely instead of silently overwriting a file.'],
      ['Ready (Discard)', 'Opens the receive gate without creating local files. Bytes are validated as they stream and then released from memory. Use it for testing, not when you need the file later.'],
      ['Destination label', 'Always shows whether the current destination is a selected folder or discard mode, and whether this device has announced ready.'],
      ['Copy Destination', 'Copies a human-readable destination description. It does not copy or expose a file.'],
      ['Open Folder', 'Reopens the folder picker near the current destination when the browser supports that behavior. It is disabled when no usable folder handle exists.'],
      ['Receiver cancellation', 'Each live inbound row can be cancelled. Ephera asks the sender to stop and marks the partial transfer as aborted; partial work is never called successful.']
    ]
  },
  {
    number: '04',
    eyebrow: 'Sending',
    title: 'Files, folders, dropping, and scheduling',
    intro: 'You may stage payloads early, but the Send button stays locked until the room is truly safe to use.',
    items: [
      ['Choose Files', 'Selects one or many files. Multiple selected files are independent concurrent transfers, so one failure does not pretend the whole batch succeeded.'],
      ['Choose Folder', 'Selects every file inside a folder. Folder hierarchy is preserved when the browser exposes relative paths; unsupported browsers safely downgrade to ordinary file payloads.'],
      ['Drop zone', 'Click it to open the file picker, press Enter/Space with a keyboard, or drag files and supported folders onto it. A new selection becomes the staged payload set.'],
      ['Send gate', 'Send requires an open P2P channel, compatible protocol versions, receiver readiness, matching crypto mode, verified matching passphrases when encrypted, and at least one selected payload.'],
      ['Priority 1-10', 'Controls scheduling when several files are moving together. A higher value gets more early send turns, but lower-priority files are not intentionally starved. It does not make the internet connection itself faster.'],
      ['Cancel', 'Stops that transfer terminally and notifies the peer when possible. There is no resume button; select and send the file again to retry from byte zero.'],
      ['Delivery receipt', 'After receiving finishes, Device B reports saved or discarded. Device A shows delivered only after that receipt. If no receipt arrives, do not assume the receiver kept the file.']
    ]
  },
  {
    number: '05',
    eyebrow: 'Security',
    title: 'Secure Mode and the passphrase rules',
    intro: 'WebRTC encrypts its connection. Secure Mode adds Ephera\'s own AES-256-GCM encryption to every payload chunk.',
    items: [
      ['Automatic passphrase', 'Hosting generates a random in-memory passphrase when the field is empty. Generate replaces it with a new random value; Clear switches that device to plain mode.'],
      ['Both sides must match', 'Use exactly the same passphrase on both devices. Ephera performs an encrypted handshake and keeps Send locked until it proves the values match.'],
      ['Copy and Share', 'Copy places the passphrase on the clipboard. Share uses the device share sheet when available. Treat clipboard history and chat history as places where a secret may remain.'],
      ['Include in join link', 'Convenient but less separated: the passphrase travels with the invitation. Leave this off for stronger out-of-band verification and send the passphrase through a different trusted channel.'],
      ['Memory only', 'Ephera does not save the passphrase. A refresh or disconnect clears session state, so keep your own trusted communication available until the transfer completes.'],
      ['No false downgrade', 'If one peer uses Secure Mode and the other uses plain mode, Send remains disabled instead of silently sending unencrypted data.']
    ]
  },
  {
    number: '06',
    eyebrow: 'Network',
    title: 'STUN, TURN, ICE, and diagnostics',
    intro: 'Most people should leave these controls alone. They are available for operators who understand their network.',
    items: [
      ['Built-in STUN', 'Helps the two browsers discover a direct path through ordinary routers. STUN coordinates addresses; it does not store the file.'],
      ['Custom ICE servers', 'Accepts an RTCIceServer JSON array. Invalid JSON is rejected. Changes apply on the next connection or reconnect, not magically to an already-open lane.'],
      ['Force TURN relay only', 'Use only after a trusted TURN server is configured. Without TURN, relay-only mode cannot connect. TURN is not enabled on the public Ephera deployment today.'],
      ['Include ICE/TURN in link', 'Copies network configuration into the invitation. Leave it off unless the other peer truly needs the same custom setup because query values may appear in external server logs.'],
      ['Diagnostics', 'When enabled, refreshes local WebRTC state about once per second. Copy exports the visible snapshot. Candidate details are sanitized so IP addresses, ports, and ICE server URLs are not exposed.'],
      ['Signaling loss', 'Once P2P is open, a temporary signaling outage does not intentionally kill the active data lane. Ephera attempts a best-effort reconnect and can restart ICE when the transport itself becomes unhealthy.']
    ]
  },
  {
    number: '07',
    eyebrow: 'Observability',
    title: 'What every dashboard panel is telling you',
    intro: 'These panels explain the current browser session. They are not a server-side account history.',
    items: [
      ['Dashboard navigation', 'Session, Transfer, Security, Network, and Activity jump to the matching dashboard area. Back to Landing hides the cockpit and returns to this public guide without pretending the active session was saved.'],
      ['Session Phase', 'Shows whether you are onboarding, inside a room, connected by channel, or operating the transfer cockpit. What Unlocks Next explains the next action, the trust boundary, and the condition that unlocks it.'],
      ['Transfer Flow', 'Shows the order Ephera expects: room, P2P, peer ready, protocol/crypto verification, then payload selection and send. Next tells you the immediate missing action.'],
      ['Environment Preflight', 'Checks HTTPS secure context, receive-folder support, WebRTC, and clipboard access. WebRTC is essential; other unavailable tools have fallbacks such as discard mode or manual copying.'],
      ['Live Transfers', 'Shows one row per inbound or outbound payload with direction, name, bytes, progress, speed, status, result, and a Cancel action while cancellation is meaningful.'],
      ['Transfer Ledger', 'Groups current-session batches and receipts into active, complete, and attention counts. Clear removes settled entries but keeps transfers that are still in flight.'],
      ['Activity Timeline', 'Records local connection, transfer, receipt, warning, and status messages for this page session. Search narrows text; checkboxes filter kinds; All and None toggle every kind.'],
      ['Copy and download activity', 'Copy Visible copies only entries passing the current search and filters. Download TXT makes a readable log; Download JSON makes a structured local file. Clear removes the page-session timeline.'],
      ['Privacy boundary', 'Ledger, activity, diagnostics, and status UI live in the browser session. Ephera has no account, cloud transfer history, payload archive, or server-side recovery copy.']
    ]
  },
  {
    number: '08',
    eyebrow: 'End states',
    title: 'Success, failure, retry, and cleanup',
    intro: 'A clear ending is part of a safe transfer. Ephera does not blur “started” into “delivered.”',
    items: [
      ['Successful save', 'The receiver finishes writing and sends a saved receipt. The sender can then treat delivered as confirmation that the selected destination accepted the complete stream.'],
      ['Successful discard', 'The receiver consumes the complete stream without keeping a file and returns a discarded receipt. This is success for a discard test, not proof of a saved copy.'],
      ['Abort or channel death', 'Affected sessions end as failures. If the whole DataChannel dies, active transfers are aborted rather than left pretending to run.'],
      ['Retry', 'Reconnect if needed, make the receiver ready again, select the payload again, and start a fresh send. Ephera intentionally has no partial cloud upload to resume.'],
      ['Closing the page', 'Stops the browser runtime and destroys unsaved ephemeral state. Wait for receipts before closing, and keep the receiver awake until local writes finish.'],
      ['After completion', 'The receiver owns any file it explicitly saved. Ephera does not offer deletion, synchronization, download-again, or history because it never kept a server copy.']
    ]
  }
];

const fixes = [
  ['Send is grey', 'Read the message below Send. Usually the P2P lane is not open, Device B is not ready, passphrases differ, or no payload is selected.'],
  ['Folder button is unavailable', 'Use the HTTPS production site in current Chrome or Edge. If the browser still lacks folder access, choose Ready (Discard) or use a supported browser.'],
  ['The peer cannot join', 'Confirm the complete Room ID and Room Auth Key, use the newest invitation after a key rotation, and make sure the room owner has not closed or left the room.'],
  ['Crypto keeps verifying', 'Make both passphrase fields identical, including every dash and character. If one side cleared its passphrase, either restore it or clear both sides intentionally.'],
  ['QR scan does not start', 'Allow camera permission, improve lighting, keep the whole QR inside the frame, or use Scan QR Image / paste the package instead.'],
  ['P2P never comes up', 'Try without a VPN, switch networks, and reconnect. Very restrictive networks may require a trusted TURN service, which is not currently enabled on the public deployment.'],
  ['Transfer stopped', 'Keep both tabs open and devices awake, check the connection, then retry as a new transfer. An aborted partial transfer is never marked complete.'],
  ['No delivery receipt', 'The sender finished streaming but Device B did not confirm saved/discarded. Check Device B before closing or deleting the original file.']
];

const glossary = [
  ['Room', 'A temporary meeting place for the two browsers.'],
  ['Room ID', 'The temporary room name.'],
  ['Auth Key', 'The secret ticket required to join the room.'],
  ['Signaling', 'The introduction service that helps peers set up WebRTC.'],
  ['P2P', 'Peer to peer: the sender browser talks directly to the receiver browser.'],
  ['STUN', 'A helper that lets browsers discover a direct route through routers.'],
  ['TURN', 'An optional relay used when a direct route is blocked.'],
  ['Ready', 'The receiver has chosen save or discard and can accept a stream.'],
  ['Passphrase', 'The shared secret used for Ephera Secure Mode encryption.'],
  ['Receipt', 'The receiver\'s saved-or-discarded completion answer.'],
  ['Discard', 'Receive and verify the bytes without keeping a file.'],
  ['Ledger', 'A temporary summary visible only in the current page session.']
];

function QuickStep({ step, index }) {
  return (
    <motion.article
      initial={{ opacity: 0, y: 18 }}
      whileInView={{ opacity: 1, y: 0 }}
      viewport={{ once: true, amount: 0.15 }}
      transition={{ duration: 0.34, delay: Math.min(index * 0.04, 0.2) }}
      className="how-step-card"
    >
      <div className="how-step-number" aria-hidden="true">{String(index + 1).padStart(2, '0')}</div>
      <div className="how-step-content">
        <h3>{step.title}</h3>
        <p className="how-step-short">{step.short}</p>
        <ol className="how-detail-list">
          {step.details.map((detail, detailIndex) => (
            <li key={detail}>
              <span>{index + 1}.{detailIndex + 1}</span>
              <p>{detail}</p>
            </li>
          ))}
        </ol>
      </div>
    </motion.article>
  );
}

function ManualChapter({ chapter, index }) {
  return (
    <motion.details
      className="how-manual-card"
      initial={{ opacity: 0, y: 14 }}
      whileInView={{ opacity: 1, y: 0 }}
      viewport={{ once: true, amount: 0.1 }}
      transition={{ duration: 0.3, delay: Math.min(index * 0.035, 0.18) }}
      open={index < 2}
    >
      <summary>
        <span className="how-manual-index">{chapter.number}</span>
        <span className="how-manual-heading">
          <span className="landing-kicker">{chapter.eyebrow}</span>
          <strong>{chapter.title}</strong>
        </span>
        <span className="how-manual-toggle" aria-hidden="true">+</span>
      </summary>
      <div className="how-manual-body">
        <p className="how-manual-intro">{chapter.intro}</p>
        <dl>
          {chapter.items.map(([term, description]) => (
            <div key={term}>
              <dt>{term}</dt>
              <dd>{description}</dd>
            </div>
          ))}
        </dl>
      </div>
    </motion.details>
  );
}

export default function HowToUseSection({ onLaunchDashboard }) {
  return (
    <section id="how-to-use" className="landing-section landing-scroll-anchor how-to-section">
      <div className="landing-container">
        <div className="how-hero landing-panel-strong">
          <div className="how-hero-copy">
            <p className="landing-kicker">How to use / complete field manual</p>
            <h2 className="landing-title mt-4 max-w-[11ch]">Two devices. One temporary room. No guessing.</h2>
            <p className="landing-body mt-6 max-w-[43rem]">
              Think of Ephera like passing a sealed box directly to a friend. The room helps both devices meet, the receiver chooses where the box goes, and the sender moves it only when every safety light is ready.
            </p>
            <div className="mt-8 flex flex-wrap gap-3">
              <button type="button" onClick={onLaunchDashboard} className="landing-button landing-button-primary">
                Open The Dashboard
              </button>
              <a className="landing-button landing-button-secondary" href="#how-quick-start">
                Start With Step 1
              </a>
            </div>
          </div>

          <div className="how-route" aria-label="Simple Ephera route">
            <div className="how-route-device">
              <span>A</span>
              <strong>Host</strong>
              <small>chooses files</small>
            </div>
            <div className="how-route-lane" aria-hidden="true">
              <span>invite</span>
              <div><i /><i /><i /></div>
              <span>direct stream</span>
            </div>
            <div className="how-route-device how-route-device-receiver">
              <span>B</span>
              <strong>Receiver</strong>
              <small>chooses destination</small>
            </div>
            <p>Nothing moves until both devices agree on the room, readiness, protocol, and Secure Mode.</p>
          </div>
        </div>

        <div className="how-section-heading">
          <div id="how-quick-start" className="landing-scroll-anchor">
            <p className="landing-kicker">The careful first transfer</p>
            <h3>Follow these seven cards in order.</h3>
          </div>
          <p>Device A is the host and usually the sender. Device B is the joiner and usually the receiver. Ephera can transfer in either direction after both peers are ready.</p>
        </div>

        <div className="how-steps">
          {quickSteps.map((step, index) => (
            <QuickStep key={step.title} step={step} index={index} />
          ))}
        </div>

        <div className="how-section-heading how-manual-heading-block">
          <div>
            <p className="landing-kicker">Every control, explained</p>
            <h3>The complete feature manual.</h3>
          </div>
          <p>Open any chapter to learn what each button means, when to use it, and what Ephera will never do behind your back.</p>
        </div>

        <div className="how-manual-grid">
          {manualChapters.map((chapter, index) => (
            <ManualChapter key={chapter.number} chapter={chapter} index={index} />
          ))}
        </div>

        <div className="how-section-heading">
          <div>
            <p className="landing-kicker">When something says no</p>
            <h3>Read the light. Fix one small thing.</h3>
          </div>
          <p>Ephera blocks unsafe or incomplete actions on purpose. A disabled button is usually protecting the transfer, not hiding it.</p>
        </div>

        <div className="how-fix-grid">
          {fixes.map(([problem, answer], index) => (
            <motion.article
              key={problem}
              initial={{ opacity: 0, y: 12 }}
              whileInView={{ opacity: 1, y: 0 }}
              viewport={{ once: true, amount: 0.2 }}
              transition={{ duration: 0.26, delay: Math.min(index * 0.03, 0.15) }}
            >
              <span>{String(index + 1).padStart(2, '0')}</span>
              <h4>{problem}</h4>
              <p>{answer}</p>
            </motion.article>
          ))}
        </div>

        <div className="how-glossary landing-panel-strong">
          <div className="how-glossary-intro">
            <p className="landing-kicker">Tiny dictionary</p>
            <h3>Words that sound harder than they are.</h3>
            <p>If a dashboard word feels technical, use this as the plain-language translation.</p>
          </div>
          <dl>
            {glossary.map(([term, meaning]) => (
              <div key={term}>
                <dt>{term}</dt>
                <dd>{meaning}</dd>
              </div>
            ))}
          </dl>
        </div>

        <div className="how-last-note">
          <div>
            <p className="landing-kicker">The one rule to remember</p>
            <p>Do not close either device until the sender sees the receiver's saved or discarded receipt.</p>
          </div>
          <button type="button" onClick={onLaunchDashboard} className="landing-button landing-button-warm">
            Begin A Transfer
          </button>
        </div>
      </div>
    </section>
  );
}
