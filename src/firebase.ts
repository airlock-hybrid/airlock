// Firebase wiring: App Check (required for AI Logic), anonymous Auth, Firestore receipts, Remote Config,
// and the Firebase AI Logic models used for hybrid on-device / in-cloud inference.

import { initializeApp } from 'firebase/app';
import { initializeAppCheck, ReCaptchaEnterpriseProvider } from 'firebase/app-check';
import { getAI, getGenerativeModel, GoogleAIBackend, InferenceMode, type GenerativeModel } from 'firebase/ai';
import { getAuth, onAuthStateChanged, signInAnonymously, type User } from 'firebase/auth';
import { addDoc, collection, deleteDoc, doc, getDocs, getFirestore, limit, orderBy, query, serverTimestamp } from 'firebase/firestore';
import { fetchAndActivate, getRemoteConfig, getValue } from 'firebase/remote-config';
import { ENTITY_TYPES, type EntityType } from './redact/types';

const firebaseConfig = {
  apiKey: 'AIzaSyBqV1MIz9xhAQL5d8lSQtqBb6pPcdclj0Q',
  authDomain: 'airlock-hybrid.firebaseapp.com',
  projectId: 'airlock-hybrid',
  storageBucket: 'airlock-hybrid.firebasestorage.app',
  messagingSenderId: '265356933366',
  appId: '1:265356933366:web:2f68ac0924d2eb381b94d7',
};
const RECAPTCHA_ENTERPRISE_SITE_KEY = '6LdZHR8uAAAAABHg0qTeeLGn5a775ARIBQuYPCqi';

export const app = initializeApp(firebaseConfig);

// Local development uses the App Check debug provider; the hosted app uses reCAPTCHA Enterprise attestation.
if (location.hostname === 'localhost' || location.hostname === '127.0.0.1') {
  (self as unknown as { FIREBASE_APPCHECK_DEBUG_TOKEN: boolean }).FIREBASE_APPCHECK_DEBUG_TOKEN = true;
}
export const appCheck = initializeAppCheck(app, {
  provider: new ReCaptchaEnterpriseProvider(RECAPTCHA_ENTERPRISE_SITE_KEY),
  isTokenAutoRefreshEnabled: true,
});

// ---------- Remote Config: model choice and policy defaults can change without a redeploy ----------
export interface Policy {
  cloudModel: string;
  verifyPass: boolean;
  maxChars: number;
  defaultTypes: EntityType[];
}
const remoteConfig = getRemoteConfig(app);
remoteConfig.settings.minimumFetchIntervalMillis = 10 * 60 * 1000;
remoteConfig.defaultConfig = {
  cloud_model: 'gemini-3.5-flash-lite',
  verify_pass: true,
  max_chars: 12000,
  default_entity_types: JSON.stringify(ENTITY_TYPES),
};
export async function loadPolicy(): Promise<Policy> {
  try {
    await fetchAndActivate(remoteConfig);
  } catch {
    /* offline: defaults apply */
  }
  let types: EntityType[] = [...ENTITY_TYPES];
  try {
    const parsed = JSON.parse(getValue(remoteConfig, 'default_entity_types').asString());
    if (Array.isArray(parsed)) types = parsed.filter((t): t is EntityType => (ENTITY_TYPES as readonly string[]).includes(t));
  } catch {
    /* keep defaults */
  }
  return {
    cloudModel: getValue(remoteConfig, 'cloud_model').asString() || 'gemini-3.5-flash-lite',
    verifyPass: getValue(remoteConfig, 'verify_pass').asBoolean(),
    maxChars: getValue(remoteConfig, 'max_chars').asNumber() || 12000,
    defaultTypes: types,
  };
}

// ---------- Auth: anonymous, so receipts are private per browser without asking for an account ----------
const auth = getAuth(app);
export function whenSignedIn(): Promise<User> {
  return new Promise((resolve, reject) => {
    const stop = onAuthStateChanged(auth, (u) => {
      if (u) {
        stop();
        resolve(u);
      }
    });
    signInAnonymously(auth).catch((e) => {
      stop();
      reject(e);
    });
  });
}

// ---------- Firestore: privacy receipts. Only the redacted payload's metadata is stored, never the original text or the vault. ----------
const db = getFirestore(app);
export interface Receipt {
  id?: string;
  createdAt?: { toDate(): Date } | null;
  task: string;
  payloadPreview: string;
  payloadBytes: number;
  payloadSha256: string;
  counts: Partial<Record<EntityType, number>>;
  answeredBy: 'in_cloud' | 'on_device';
  model: string;
  version: number;
}
export async function saveReceipt(uid: string, r: Omit<Receipt, 'id' | 'createdAt' | 'version'>) {
  return addDoc(collection(db, 'users', uid, 'receipts'), { ...r, version: 1, createdAt: serverTimestamp() });
}
export async function listReceipts(uid: string): Promise<Receipt[]> {
  const snap = await getDocs(query(collection(db, 'users', uid, 'receipts'), orderBy('createdAt', 'desc'), limit(20)));
  return snap.docs.map((d) => ({ id: d.id, ...(d.data() as Receipt) }));
}
export async function deleteReceipt(uid: string, id: string) {
  await deleteDoc(doc(db, 'users', uid, 'receipts', id));
}

// ---------- Firebase AI Logic: hybrid inference ----------
export const ai = getAI(app, { backend: new GoogleAIBackend() });

const LM_CREATE = {
  expectedInputs: [{ type: 'text' as const, languages: ['en'] }],
  expectedOutputs: [{ type: 'text' as const, languages: ['en'] }],
};

// Compact on purpose: Gemini Nano's output speed is the bottleneck, so the schema asks only for what rules cannot find,
// as three flat lists of strings (no per-item objects, no repeated keys).
const list = { type: 'array', items: { type: 'string' } };
export const ENTITY_SCHEMA = {
  type: 'object',
  properties: { people: list, orgs: list, places: list },
  required: ['people', 'orgs', 'places'],
};

/** Sensitive work: ONLY_ON_DEVICE, so the raw text can never be routed to the cloud, even by a fallback. */
export const deviceExtractor: GenerativeModel = getGenerativeModel(ai, {
  mode: InferenceMode.ONLY_ON_DEVICE,
  onDeviceParams: { createOptions: LM_CREATE, promptOptions: { responseConstraint: ENTITY_SCHEMA } },
});

/** Local-only answers (offline, or when the user keeps everything on the device). */
export const deviceWriter: GenerativeModel = getGenerativeModel(ai, {
  mode: InferenceMode.ONLY_ON_DEVICE,
  onDeviceParams: { createOptions: LM_CREATE },
});

export const AIRLOCK_SYSTEM = [
  'You are a careful assistant working on text that has been de-identified on the user\'s device.',
  'Bracketed placeholders such as [PERSON_1], [PHONE_2] or [DATE_1] stand for real values that were hidden for privacy.',
  'Rules: keep every placeholder exactly as written (same brackets, type and number) whenever you refer to that value;',
  'never guess, invent or ask for the hidden values; never invent new placeholders; do not mention that text was redacted unless asked.',
].join(' ');

/** The heavy lifting: PREFER_IN_CLOUD. The payload is already redacted, so the automatic on-device fallback (offline, quota) is also safe. */
export function cloudWriter(model: string, simulateOutage = false): GenerativeModel {
  return getGenerativeModel(ai, {
    mode: InferenceMode.PREFER_IN_CLOUD,
    inCloudParams: { model, systemInstruction: AIRLOCK_SYSTEM, generationConfig: { temperature: 0.4 } },
    onDeviceParams: { createOptions: LM_CREATE },
  }, { timeout: 45_000, ...(simulateOutage ? { baseUrl: 'https://cloud-outage.invalid' } : {}) });
}

export async function sha256(s: string): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

// Diagnostics for the console: `await airlockCloudCheck()` makes one cloud-only call with a harmless prompt.
(globalThis as unknown as { airlockCloudCheck: (model?: string) => Promise<string> }).airlockCloudCheck = async (model = 'gemini-3.5-flash-lite') => {
  const m = getGenerativeModel(ai, { mode: InferenceMode.ONLY_IN_CLOUD, inCloudParams: { model } });
  try {
    const r = await m.generateContent('Say OK.');
    return `ok: ${r.response.text()} (${r.response.inferenceSource})`;
  } catch (e) {
    return `error: ${(e as Error).message}`;
  }
};
