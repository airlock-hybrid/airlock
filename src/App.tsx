import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { User } from 'firebase/auth';
import {
  cloudWriter,
  deleteReceipt,
  deviceExtractor,
  deviceWriter,
  listReceipts,
  loadPolicy,
  saveReceipt,
  sha256,
  whenSignedIn,
  type Policy,
  type Receipt,
} from './firebase';
import { detectRules } from './redact/detectors';
import { applyRedaction, locate, placeholdersIn, propagate, rehydrate, resolve } from './redact/merge';
import { deviceAvailability, seal, type DeviceState, type SealStep } from './redact/ondevice';
import { ENTITY_LABELS, ENTITY_TYPES, type EntityType, type Span } from './redact/types';
import { SAMPLES, TASKS, type TaskId } from './samples';

type Stage = 'compose' | 'sealing' | 'review' | 'sending' | 'done';
type Source = 'in_cloud' | 'on_device';

const PH_SPLIT = /(\[\s*(?:PERSON|EMAIL|PHONE|ADDRESS|DATE|ID|URL|ORG)[\s_-]*\d+\s*\])/gi;
const keyOf = (s: { start: number; end: number }) => `${s.start}:${s.end}`;
const overlaps = (a: Span, b: Span) => a.start < b.end && b.start < a.end;
const fmtMs = (ms?: number) => (ms == null ? '' : ms < 1000 ? `${Math.round(ms)} ms` : `${(ms / 1000).toFixed(1)} s`);
const fmtBytes = (n: number) => (n < 1024 ? `${n} B` : `${(n / 1024).toFixed(1)} KB`);

function buildPrompt(instruction: string, payload: string) {
  return `${instruction.trim()}\n\nMESSAGE:\n"""\n${payload}\n"""`;
}

/** Light formatting for model answers: bullets and checkboxes, bold, and restored values highlighted. */
function Answer({ text, vault, showPlaceholders }: { text: string; vault?: Record<string, string>; showPlaceholders?: boolean }) {
  const lines = text.replace(/\r/g, '').split('\n');
  return (
    <div className="answer">
      {lines.map((line, i) => {
        let l = line;
        let cls = '';
        const box = /^\s*[-*]\s+\[( |x)\]\s+/i.exec(l);
        if (box) {
          l = l.slice(box[0].length);
          cls = box[1].toLowerCase() === 'x' ? 'li check done' : 'li check';
        } else if (/^\s*[-*•]\s+/.test(l)) {
          l = l.replace(/^\s*[-*•]\s+/, '');
          cls = 'li';
        } else if (/^\s*#{1,4}\s+/.test(l)) {
          l = l.replace(/^\s*#{1,4}\s+/, '');
          cls = 'h';
        }
        return (
          <p key={i} className={cls || undefined}>
            {renderInline(l, vault, showPlaceholders)}
          </p>
        );
      })}
    </div>
  );
}

function renderInline(s: string, vault?: Record<string, string>, showPlaceholders?: boolean): ReactNode[] {
  const out: ReactNode[] = [];
  s.split(/(\*\*[^*]+\*\*)/g).forEach((part, i) => {
    const bold = /^\*\*([^*]+)\*\*$/.exec(part);
    const body = bold ? bold[1] : part;
    const pieces = body.split(PH_SPLIT).map((p, j) => {
      const m = /^\[\s*(PERSON|EMAIL|PHONE|ADDRESS|DATE|ID|URL|ORG)[\s_-]*(\d+)\s*\]$/i.exec(p);
      if (!m) return p;
      const ph = `[${m[1].toUpperCase()}_${m[2]}]`;
      const type = m[1].toUpperCase();
      if (vault && ph in vault && !showPlaceholders) {
        return (
          <mark key={j} className={`restored t-${type}`} title={`${ph} restored on this device`}>
            {vault[ph]}
          </mark>
        );
      }
      return (
        <span key={j} className={`ph t-${type}`}>
          {ph}
        </span>
      );
    });
    out.push(bold ? <strong key={i}>{pieces}</strong> : <span key={i}>{pieces}</span>);
  });
  return out;
}

export default function App() {
  const [policy, setPolicy] = useState<Policy | null>(null);
  const [user, setUser] = useState<User | null>(null);
  const [device, setDevice] = useState<DeviceState>('checking');
  const [dlProgress, setDlProgress] = useState<number | null>(null);
  const [online, setOnline] = useState(navigator.onLine);

  const [text, setText] = useState(SAMPLES[0].text);
  const [sampleId, setSampleId] = useState(SAMPLES[0].id);
  const [taskId, setTaskId] = useState<TaskId>(SAMPLES[0].task);
  const [custom, setCustom] = useState('Rewrite this as a short, friendly text message.');
  const [enabled, setEnabled] = useState<Set<EntityType>>(new Set(ENTITY_TYPES));

  const [stage, setStage] = useState<Stage>('compose');
  const [steps, setSteps] = useState<SealStep[]>([]);
  const [spans, setSpans] = useState<Span[]>([]);
  const [excluded, setExcluded] = useState<Set<string>>(new Set());
  const [extraText, setExtraText] = useState('');
  const [extraType, setExtraType] = useState<EntityType>('PERSON');
  const [sealedText, setSealedText] = useState('');

  const [payloadHash, setPayloadHash] = useState('');
  const [cloudText, setCloudText] = useState('');
  const [answerSource, setAnswerSource] = useState<Source | null>(null);
  const [answerMs, setAnswerMs] = useState<number | null>(null);
  const [answerVault, setAnswerVault] = useState<Record<string, string>>({});
  const [localOnly, setLocalOnly] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showRaw, setShowRaw] = useState(false);
  const [copied, setCopied] = useState(false);
  const [outage, setOutage] = useState(false);

  const [drawer, setDrawer] = useState(false);
  const [receipts, setReceipts] = useState<Receipt[] | null>(null);
  const [savedReceipt, setSavedReceipt] = useState<'saving' | 'saved' | 'failed' | null>(null);
  const [about, setAbout] = useState(false);

  useEffect(() => {
    loadPolicy().then((p) => {
      setPolicy(p);
      setEnabled(new Set(p.defaultTypes));
    });
    deviceAvailability().then(setDevice);
    whenSignedIn().then(setUser).catch(() => setUser(null));
    const on = () => setOnline(true);
    const off = () => setOnline(false);
    window.addEventListener('online', on);
    window.addEventListener('offline', off);
    return () => {
      window.removeEventListener('online', on);
      window.removeEventListener('offline', off);
    };
  }, []);

  const task = TASKS.find((t) => t.id === taskId)!;
  const instruction = taskId === 'custom' ? custom : task.instruction;
  const deviceReady = device === 'available';

  // ----- Review: the redaction is recomputed live as the user toggles spans and types -----
  const displaySpans = useMemo(() => resolve(spans.filter((s) => enabled.has(s.type))), [spans, enabled]);
  const offSpans = useMemo(() => displaySpans.filter((s) => excluded.has(keyOf(s))), [displaySpans, excluded]);
  const redaction = useMemo(
    () => applyRedaction(sealedText, spans.filter((s) => !offSpans.some((o) => overlaps(o, s))), enabled),
    [sealedText, spans, offSpans, enabled],
  );
  const payload = useMemo(() => buildPrompt(instruction, redaction.redacted), [instruction, redaction.redacted]);
  const payloadBytes = useMemo(() => new TextEncoder().encode(payload).length, [payload]);
  useEffect(() => {
    if (stage === 'compose') return;
    sha256(payload).then(setPayloadHash);
  }, [payload, stage]);

  // A final local check of exactly what is about to leave the device.
  const preflight = useMemo(() => {
    const issues: string[] = [];
    const lower = payload.toLowerCase();
    for (const s of redaction.spans) {
      if (s.text.length >= 3 && lower.includes(s.text.toLowerCase())) issues.push(`"${s.text}" still appears`);
    }
    for (const r of detectRules(redaction.redacted)) issues.push(`${ENTITY_LABELS[r.type]}: "${r.text}"`);
    return [...new Set(issues)];
  }, [payload, redaction]);

  const placeholderCount = Object.keys(redaction.vault).length;

  const enableDevice = useCallback(async () => {
    setDevice('downloading');
    setDlProgress(0);
    try {
      await deviceExtractor.initializeDeviceModel((p) => setDlProgress(p));
      setDevice(await deviceAvailability());
    } catch (e) {
      setError(`Could not prepare Gemini Nano: ${(e as Error).message}`);
      setDevice(await deviceAvailability());
    } finally {
      setDlProgress(null);
    }
  }, []);

  const loadSample = (id: string) => {
    const s = SAMPLES.find((x) => x.id === id)!;
    setSampleId(id);
    setText(s.text);
    setTaskId(s.task);
    reset();
  };

  const reset = () => {
    setStage('compose');
    setSteps([]);
    setSpans([]);
    setExcluded(new Set());
    setCloudText('');
    setAnswerSource(null);
    setAnswerMs(null);
    setError(null);
    setSavedReceipt(null);
    setShowRaw(false);
  };

  const onSeal = async () => {
    if (!text.trim()) return;
    if (policy && text.length > policy.maxChars) {
      setError(`This demo handles up to ${policy.maxChars.toLocaleString()} characters at a time.`);
      return;
    }
    setError(null);
    setStage('sealing');
    setSealedText(text);
    setExcluded(new Set());
    let useDevice = deviceReady;
    if (useDevice) {
      try {
        await deviceExtractor.initializeDeviceModel();
      } catch {
        useDevice = false;
      }
    }
    const res = await seal(text, enabled, { device: useDevice, verifyPass: policy?.verifyPass ?? true }, setSteps);
    setSpans(res.spans);
    setSteps(res.steps);
    setStage('review');
  };

  const addExtra = () => {
    const needle = extraText.trim();
    if (!needle) return;
    const found = locate(sealedText, { text: needle, type: extraType, source: 'user' });
    if (!found.length) {
      setError(`"${needle}" does not appear in the text.`);
      return;
    }
    setError(null);
    const next = [...spans, ...found];
    setSpans(extraType === 'PERSON' ? [...next, ...propagate(sealedText, next)] : next);
    setEnabled((e) => new Set(e).add(extraType));
    setExtraText('');
  };

  const toggleSpan = (s: Span) =>
    setExcluded((ex) => {
      const n = new Set(ex);
      const k = keyOf(s);
      if (n.has(k)) n.delete(k);
      else n.add(k);
      return n;
    });

  const toggleType = (t: EntityType) =>
    setEnabled((e) => {
      const n = new Set(e);
      if (n.has(t)) n.delete(t);
      else n.add(t);
      return n;
    });

  const send = async (mode: 'cloud' | 'device') => {
    setError(null);
    setStage('sending');
    setCloudText('');
    setLocalOnly(mode === 'device');
    setSavedReceipt(null);
    const vault = redaction.vault;
    setAnswerVault(vault);
    const t0 = performance.now();
    try {
      let full = '';
      let source: Source;
      if (mode === 'device') {
        // Local-only: Gemini Nano answers from the original text. Nothing is sent anywhere.
        await deviceWriter.initializeDeviceModel();
        const r = await deviceWriter.generateContentStream(buildPrompt(instruction, sealedText));
        for await (const c of r.stream) {
          full += c.text();
          setCloudText(full);
        }
        source = 'on_device';
      } else {
        const model = cloudWriter(policy?.cloudModel ?? 'gemini-3.5-flash-lite', outage);
        if (deviceReady) model.initializeDeviceModel().catch(() => undefined); // ready for the offline fallback
        const r = await model.generateContentStream(payload);
        for await (const c of r.stream) {
          full += c.text();
          setCloudText(full);
        }
        source = ((await r.response).inferenceSource as Source | undefined) ?? 'in_cloud';
      }
      setAnswerSource(source);
      setAnswerMs(performance.now() - t0);
      setStage('done');
      if (mode === 'cloud' && user) {
        setSavedReceipt('saving');
        saveReceipt(user.uid, {
          task: taskId === 'custom' ? 'Custom' : task.label,
          payloadPreview: payload.slice(0, 4000),
          payloadBytes,
          payloadSha256: payloadHash || (await sha256(payload)),
          counts: redaction.counts,
          answeredBy: source,
          model: source === 'in_cloud' ? (policy?.cloudModel ?? 'gemini-3.5-flash-lite') : 'gemini-nano',
        })
          .then(() => {
            setSavedReceipt('saved');
            if (drawer) refreshReceipts();
          })
          .catch(() => setSavedReceipt('failed'));
      }
    } catch (e) {
      setError(friendlyError(e as Error));
      setStage('review');
    }
  };

  const refreshReceipts = useCallback(async () => {
    if (!user) return;
    try {
      setReceipts(await listReceipts(user.uid));
    } catch {
      setReceipts([]);
    }
  }, [user]);

  useEffect(() => {
    if (drawer) refreshReceipts();
  }, [drawer, refreshReceipts]);

  const unsealed = useMemo(() => (localOnly ? { text: cloudText, restored: 0, unknown: [] } : rehydrate(cloudText, answerVault)), [cloudText, answerVault, localOnly]);
  const invented = useMemo(() => {
    if (localOnly) return [];
    const sent = new Set(Object.keys(answerVault));
    return [...new Set(placeholdersIn(cloudText).filter((p) => !sent.has(p)))];
  }, [cloudText, answerVault, localOnly]);

  const copyAnswer = async () => {
    await navigator.clipboard.writeText(unsealed.text);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  const crossing = stage === 'sending' && !localOnly;
  const busy = stage === 'sealing' || stage === 'sending';

  return (
    <div className="app">
      <header className="top">
        <div className="brand">
          <svg viewBox="0 0 64 64" aria-hidden="true">
            <rect x="8" y="10" width="20" height="44" rx="5" className="logo-dev" />
            <rect x="36" y="10" width="20" height="44" rx="5" className="logo-cloud" />
            <rect x="30.5" y="4" width="3" height="56" rx="1.5" className="logo-line" />
          </svg>
          <div>
            <h1>Airlock</h1>
            <p>Cloud-grade AI on sensitive text. The cloud never learns who it is about.</p>
          </div>
        </div>
        <div className="chips">
          <DeviceChip state={device} progress={dlProgress} onEnable={enableDevice} />
          <span className={`chip ${online ? 'ok cloud' : 'warn'}`}>
            <i />
            {online ? `Cloud: ${policy?.cloudModel ?? '…'}` : 'Offline: on-device fallback'}
          </span>
          <button className="ghost" onClick={() => setDrawer(true)}>
            Privacy receipts
          </button>
          <button className="ghost" onClick={() => setAbout(true)}>
            How it works
          </button>
        </div>
      </header>

      <ol className="flow">
        <li className={stage === 'compose' || stage === 'sealing' ? 'on' : 'past'}>
          <b>1</b> Seal on device
        </li>
        <li className={stage === 'review' ? 'on' : stage === 'sending' || stage === 'done' ? 'past' : ''}>
          <b>2</b> Review what leaves
        </li>
        <li className={stage === 'sending' ? 'on' : stage === 'done' ? 'past' : ''}>
          <b>3</b> Cloud works on placeholders
        </li>
        <li className={stage === 'done' ? 'on' : ''}>
          <b>4</b> Unseal on device
        </li>
      </ol>

      {error && (
        <div className="error" role="alert">
          {error}
          <button className="link" onClick={() => setError(null)}>
            Dismiss
          </button>
        </div>
      )}

      <main className={`stage-${stage}`}>
        {/* ---------------- YOUR DEVICE ---------------- */}
        <section className="side device">
          <div className="side-head">
            <span className="tag dev">Your device</span>
            <span className="muted">Raw text and the vault never leave this side</span>
          </div>

          {stage === 'compose' && (
            <>
              <div className="samples">
                {SAMPLES.map((s) => (
                  <button key={s.id} className={`pill ${sampleId === s.id ? 'sel' : ''}`} onClick={() => loadSample(s.id)}>
                    {s.label}
                  </button>
                ))}
              </div>
              <textarea
                value={text}
                onChange={(e) => {
                  setText(e.target.value);
                  setSampleId('');
                }}
                spellCheck={false}
                aria-label="Sensitive text"
                placeholder="Paste an email, ticket, note or letter that mentions real people…"
              />
              <div className="tasks">
                {TASKS.map((t) => (
                  <button key={t.id} className={`task ${taskId === t.id ? 'sel' : ''}`} onClick={() => setTaskId(t.id)}>
                    <b>{t.label}</b>
                    <span>{t.hint}</span>
                  </button>
                ))}
              </div>
              {taskId === 'custom' && (
                <input className="custom" value={custom} onChange={(e) => setCustom(e.target.value)} aria-label="Custom instruction" />
              )}
              <details className="types">
                <summary>What to hide ({enabled.size} of {ENTITY_TYPES.length} kinds)</summary>
                <div className="typegrid">
                  {ENTITY_TYPES.map((t) => (
                    <label key={t} className={`t-${t}`}>
                      <input type="checkbox" checked={enabled.has(t)} onChange={() => toggleType(t)} />
                      {ENTITY_LABELS[t]}
                    </label>
                  ))}
                </div>
              </details>
              <div className="actions">
                <button className="primary dev" onClick={onSeal} disabled={!text.trim()}>
                  Seal on device
                </button>
                <span className="muted small">
                  {deviceReady ? 'Pattern rules + Gemini Nano run locally. No network.' : 'Pattern rules only. Open in desktop Chrome to add Gemini Nano.'}
                </span>
              </div>
            </>
          )}

          {stage !== 'compose' && (
            <>
              <Steps steps={steps} />
              {stage === 'sealing' && <div className="original scanning">{sealedText}</div>}
              {stage !== 'sealing' && (
                <>
                  <div className="label-row">
                    <h3>Original, with what will be hidden</h3>
                    <span className="muted small">Click a highlight to let it through</span>
                  </div>
                  <Highlighted text={sealedText} spans={displaySpans} off={excluded} redaction={redaction} onToggle={stage === 'review' ? toggleSpan : undefined} />
                  {stage === 'review' && (
                    <>
                      <div className="addrow">
                        <input
                          value={extraText}
                          onChange={(e) => setExtraText(e.target.value)}
                          onKeyDown={(e) => e.key === 'Enter' && addExtra()}
                          placeholder="Also hide… (type a word from the text)"
                          aria-label="Also hide"
                        />
                        <select value={extraType} onChange={(e) => setExtraType(e.target.value as EntityType)} aria-label="Kind">
                          {ENTITY_TYPES.map((t) => (
                            <option key={t} value={t}>
                              {ENTITY_LABELS[t]}
                            </option>
                          ))}
                        </select>
                        <button onClick={addExtra}>Hide</button>
                      </div>
                      <div className="typechips">
                        {ENTITY_TYPES.map((t) => (
                          <button key={t} className={`tchip t-${t} ${enabled.has(t) ? 'on' : ''}`} onClick={() => toggleType(t)}>
                            {ENTITY_LABELS[t]} <b>{redaction.counts[t] ?? 0}</b>
                          </button>
                        ))}
                      </div>
                    </>
                  )}
                  <Vault vault={redaction.vault} />
                </>
              )}

              {stage === 'review' && (
                <div className="actions">
                  <button className="primary cloud" onClick={() => send('cloud')} disabled={!online && !deviceReady}>
                    Send {fmtBytes(payloadBytes)} through the airlock →
                  </button>
                  <button onClick={() => send('device')} disabled={!deviceReady} title={deviceReady ? '' : 'Needs Gemini Nano'}>
                    Keep it all on device
                  </button>
                  <button className="link" onClick={reset}>
                    Edit text
                  </button>
                  <label className="outage small muted" title="Points the cloud request at an unreachable host, so Firebase AI Logic falls back to Gemini Nano">
                    <input type="checkbox" checked={outage} onChange={(e) => setOutage(e.target.checked)} disabled={!deviceReady} /> Simulate cloud outage
                  </label>
                </div>
              )}

              {(stage === 'done' || (stage === 'sending' && localOnly)) && (
                <div className="unsealed">
                  <div className="label-row">
                    <h3>{localOnly ? 'On-device answer' : 'Unsealed answer'}</h3>
                    {!localOnly && stage === 'done' && (
                      <span className="badge dev">
                        {unsealed.restored} value{unsealed.restored === 1 ? '' : 's'} restored locally
                      </span>
                    )}
                  </div>
                  <div className="answer-box dev">
                    <Answer text={localOnly ? cloudText : cloudText} vault={localOnly ? undefined : answerVault} />
                    {stage === 'sending' && <span className="cursor" />}
                  </div>
                  {invented.length > 0 && (
                    <p className="warnline">The model invented {invented.join(', ')}; left as is.</p>
                  )}
                  {stage === 'done' && (
                    <div className="actions">
                      <button className="primary dev" onClick={copyAnswer}>
                        {copied ? 'Copied' : 'Copy answer'}
                      </button>
                      <button onClick={() => setStage('review')}>Back to review</button>
                      <button className="link" onClick={reset}>
                        New message
                      </button>
                    </div>
                  )}
                </div>
              )}
            </>
          )}
        </section>

        {/* ---------------- BOUNDARY ---------------- */}
        <div className={`boundary ${crossing ? 'crossing' : ''} ${localOnly && stage !== 'compose' && stage !== 'review' ? 'closed' : ''}`} aria-hidden="true">
          <div className="rail" />
          <span className="boundary-label">device boundary</span>
          <div className="packet" />
        </div>

        {/* ---------------- CLOUD ---------------- */}
        <section className="side cloud">
          <div className="side-head">
            <span className="tag cloud">Cloud</span>
            <span className="muted">Sees only what crosses the boundary</span>
          </div>

          {(stage === 'compose' || stage === 'sealing') && (
            <div className="empty">
              <div className="empty-icon">∅</div>
              <h3>Nothing has left your device</h3>
              <p>
                Airlock replaces names, contact details, addresses, dates and ID numbers with placeholders <em>before</em> anything is sent. Firebase AI Logic routes the
                de-identified request to Gemini in the cloud, and the real details are put back here, on your device.
              </p>
            </div>
          )}

          {stage !== 'compose' && stage !== 'sealing' && localOnly && stage !== 'review' && (
            <div className="empty">
              <div className="empty-icon">⊘</div>
              <h3>Airlock closed</h3>
              <p>This answer came from Gemini Nano on your device. Zero bytes were sent to the cloud.</p>
            </div>
          )}

          {(stage === 'review' || ((stage === 'sending' || stage === 'done') && !localOnly)) && (
            <>
              <div className="label-row">
                <h3>{stage === 'review' ? 'Outgoing payload' : answerSource === 'on_device' ? 'Sealed payload (cloud unreachable)' : 'What the cloud received'}</h3>
                <span className="muted small mono">
                  {fmtBytes(payloadBytes)} · sha256 {payloadHash.slice(0, 12)}
                </span>
              </div>
              <pre className="payload">{renderInline(payload)}</pre>
              <div className={`preflight ${preflight.length ? 'bad' : 'good'}`}>
                {preflight.length === 0 ? (
                  <>
                    <b>Pre-flight check passed.</b> {placeholderCount} value{placeholderCount === 1 ? '' : 's'} sealed; no emails, phones, IDs or dates detected in the payload.
                  </>
                ) : (
                  <>
                    <b>Check before sending:</b> {preflight.slice(0, 4).join(' · ')}
                  </>
                )}
              </div>
            </>
          )}

          {(stage === 'sending' || stage === 'done') && !localOnly && (
            <div className="cloud-answer">
              <div className="label-row">
                <h3>{answerSource === 'on_device' ? 'Answer on placeholders' : 'Model answer, as the cloud wrote it'}</h3>
                {answerSource && (
                  <span className={`badge ${answerSource === 'in_cloud' ? 'cloud' : 'dev'}`}>
                    {answerSource === 'in_cloud' ? `in_cloud · ${policy?.cloudModel}` : 'on_device fallback · Gemini Nano'} · {fmtMs(answerMs ?? undefined)}
                  </span>
                )}
              </div>
              {answerSource === 'on_device' && (
                <p className="fallback small">
                  The cloud could not be reached, so Firebase AI Logic fell back to Gemini Nano on this device. It answered the same sealed payload, so the fallback is just as
                  private, and unsealing works the same way.
                </p>
              )}
              <div className="answer-box cloud">
                <Answer text={cloudText} showPlaceholders />
                {stage === 'sending' && <span className="cursor" />}
              </div>
              {stage === 'done' && (
                <p className="muted small">
                  {savedReceipt === 'saved' && 'Receipt saved to your private Firestore log (redacted payload only).'}
                  {savedReceipt === 'saving' && 'Saving receipt…'}
                  {savedReceipt === 'failed' && 'Receipt could not be saved.'}
                  {savedReceipt && ' '}
                  <button className="link" onClick={() => setShowRaw((v) => !v)}>
                    {showRaw ? 'Hide' : 'Show'} raw text
                  </button>
                </p>
              )}
              {showRaw && <pre className="payload">{cloudText}</pre>}
            </div>
          )}
        </section>
      </main>

      {busy && <div className="sr-only" aria-live="polite">Working…</div>}

      {drawer && <Receipts receipts={receipts} onClose={() => setDrawer(false)} onDelete={async (id) => { if (user) { await deleteReceipt(user.uid, id); refreshReceipts(); } }} />}
      {about && <About onClose={() => setAbout(false)} />}

      <footer>
        <span>Built with Firebase AI Logic hybrid inference · Gemini Nano in Chrome + Gemini in the cloud · App Check · Anonymous Auth · Firestore · Remote Config · Hosting</span>
        <span>Sample data is fictional. Airlock is a demo, not a compliance product.</span>
      </footer>
    </div>
  );
}

function friendlyError(e: Error) {
  const m = e.message || String(e);
  if (/app.?check/i.test(m)) return 'The cloud request was blocked by App Check. Reload the page and try again.';
  if (/quota|429|resource.?exhausted/i.test(m)) return 'The cloud model is busy right now (quota). Try again, or keep it all on device.';
  if (/on.?device|LanguageModel|not available/i.test(m)) return `On-device model unavailable: ${m}`;
  return m.slice(0, 300);
}

function DeviceChip({ state, progress, onEnable }: { state: DeviceState; progress: number | null; onEnable: () => void }) {
  if (state === 'available')
    return (
      <span className="chip ok dev">
        <i />
        Gemini Nano: on device
      </span>
    );
  if (state === 'downloadable')
    return (
      <button className="chip action dev" onClick={onEnable}>
        <i />
        Enable Gemini Nano
      </button>
    );
  if (state === 'downloading')
    return (
      <span className="chip warn">
        <i />
        Downloading Gemini Nano{progress != null ? ` ${Math.round(progress * 100)}%` : '…'}
      </span>
    );
  if (state === 'checking')
    return (
      <span className="chip">
        <i />
        Checking device…
      </span>
    );
  return (
    <span className="chip warn" title="Gemini Nano runs in desktop Chrome. Pattern rules still protect structured identifiers.">
      <i />
      No on-device model: rules only
    </span>
  );
}

function Steps({ steps }: { steps: SealStep[] }) {
  return (
    <ul className="steps">
      {steps.map((s) => (
        <li key={s.id} className={s.status}>
          <span className="dot" />
          <b>{s.label}</b>
          <span className="muted">
            {s.status === 'running' && 'running locally…'}
            {s.status === 'done' && `${s.found ?? 0} found · ${fmtMs(s.ms)}`}
            {s.status === 'skipped' && (s.note ?? 'skipped')}
            {s.status === 'error' && `error: ${s.note}`}
            {s.status === 'pending' && 'waiting'}
          </span>
        </li>
      ))}
    </ul>
  );
}

function Highlighted({
  text,
  spans,
  off,
  redaction,
  onToggle,
}: {
  text: string;
  spans: Span[];
  off: Set<string>;
  redaction: ReturnType<typeof applyRedaction>;
  onToggle?: (s: Span) => void;
}) {
  const phAt = new Map(redaction.spans.map((s) => [keyOf(s), s.placeholder]));
  const parts: ReactNode[] = [];
  let cur = 0;
  spans.forEach((s, i) => {
    if (s.start < cur) return;
    parts.push(text.slice(cur, s.start));
    const isOff = off.has(keyOf(s));
    const ph = phAt.get(keyOf(s));
    parts.push(
      <mark
        key={i}
        className={`hl t-${s.type} ${isOff ? 'off' : ''} ${onToggle ? 'clickable' : ''}`}
        title={isOff ? 'Will be sent as is. Click to hide again.' : `${ph ?? ''} · found by ${s.source === 'nano' ? 'Gemini Nano' : s.source === 'verify' ? 'second look' : s.source === 'propagated' ? 'name linking' : s.source}`}
        onClick={onToggle ? () => onToggle(s) : undefined}
      >
        {text.slice(s.start, s.end)}
        {ph && !isOff && <sup>{ph.slice(1, -1)}</sup>}
      </mark>,
    );
    cur = s.end;
  });
  parts.push(text.slice(cur));
  return <div className="original">{parts}</div>;
}

function Vault({ vault }: { vault: Record<string, string> }) {
  const entries = Object.entries(vault);
  if (!entries.length) return null;
  return (
    <details className="vault">
      <summary>
        Local vault · {entries.length} value{entries.length === 1 ? '' : 's'} <span className="muted">(memory only, never sent or stored)</span>
      </summary>
      <table>
        <tbody>
          {entries.map(([ph, v]) => (
            <tr key={ph}>
              <td className="mono">{ph}</td>
              <td>{v}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </details>
  );
}

function Receipts({ receipts, onClose, onDelete }: { receipts: Receipt[] | null; onClose: () => void; onDelete: (id: string) => void }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const k = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', k);
    ref.current?.focus();
    return () => window.removeEventListener('keydown', k);
  }, [onClose]);
  return (
    <div className="scrim" onClick={onClose}>
      <div className="drawer" ref={ref} tabIndex={-1} onClick={(e) => e.stopPropagation()} role="dialog" aria-label="Privacy receipts">
        <div className="drawer-head">
          <h2>Privacy receipts</h2>
          <button className="link" onClick={onClose}>
            Close
          </button>
        </div>
        <p className="muted">
          Every cloud request leaves a receipt of exactly what crossed the boundary: the de-identified payload, its size and SHA-256 hash, and who answered. Receipts live in
          Firestore under your anonymous account; security rules let only you read them. Original text and the vault are never stored.
        </p>
        {receipts === null && <p className="muted">Loading…</p>}
        {receipts?.length === 0 && <p className="muted">No receipts yet. Send something through the airlock.</p>}
        {receipts?.map((r) => (
          <article key={r.id} className="receipt">
            <header>
              <b>{r.task}</b>
              <span className="muted small">{r.createdAt?.toDate().toLocaleString() ?? 'just now'}</span>
            </header>
            <div className="small mono">
              {fmtBytes(r.payloadBytes)} · sha256 {r.payloadSha256.slice(0, 16)}… · {r.answeredBy === 'in_cloud' ? `in_cloud (${r.model})` : 'on_device fallback'}
            </div>
            <div className="typechips small">
              {Object.entries(r.counts).map(([t, n]) => (
                <span key={t} className={`tchip on t-${t}`}>
                  {ENTITY_LABELS[t as EntityType]} <b>{n}</b>
                </span>
              ))}
            </div>
            <details>
              <summary>Payload as sent</summary>
              <pre className="payload">{r.payloadPreview}</pre>
            </details>
            <button className="link danger" onClick={() => r.id && onDelete(r.id)}>
              Delete receipt
            </button>
          </article>
        ))}
      </div>
    </div>
  );
}

function About({ onClose }: { onClose: () => void }) {
  return (
    <div className="scrim" onClick={onClose}>
      <div className="drawer about" onClick={(e) => e.stopPropagation()} role="dialog" aria-label="How Airlock works">
        <div className="drawer-head">
          <h2>How Airlock works</h2>
          <button className="link" onClick={onClose}>
            Close
          </button>
        </div>
        <ol className="how">
          <li>
            <b>Seal, on device.</b> Deterministic rules catch structured identifiers (emails, phones, card numbers with a Luhn check, ID numbers, dates, street addresses).
            Then Gemini Nano, through Firebase AI Logic in <code>ONLY_ON_DEVICE</code> mode with a JSON schema, finds what rules cannot: names, nicknames, places,
            employers. Name parts are linked ("Maria" → the same placeholder as "Maria Delgado"), and Nano takes a second look at the redacted text for anything left.
          </li>
          <li>
            <b>Review.</b> You see exactly what will leave the device, byte for byte, with a SHA-256 hash and a local pre-flight scan. Click any highlight to let it through
            or add your own.
          </li>
          <li>
            <b>Cloud thinks on placeholders.</b> The de-identified request goes to Gemini in the cloud via Firebase AI Logic in <code>PREFER_IN_CLOUD</code> mode, protected by
            App Check. If you are offline, the SDK falls back to Gemini Nano automatically; since the payload is already sealed, the fallback is safe too.
          </li>
          <li>
            <b>Unseal, on device.</b> Placeholders in the answer are swapped back for the real values from a vault that only ever exists in this tab's memory.
          </li>
        </ol>
        <p className="muted">
          Why hybrid: the small model is trusted with the raw data but only has to do one narrow job (spotting identifiers). The large model does the hard writing and
          reasoning, but never sees anything identifying. Each model does what it is best at, and privacy is enforced by where the code runs, not by a policy promise.
        </p>
        <p className="muted">Limits: detection is best-effort; review before sending. Context clues (a rare job title, a unique event) can still identify someone.</p>
      </div>
    </div>
  );
}
