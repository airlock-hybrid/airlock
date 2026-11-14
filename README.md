# Airlock

**Use cloud AI on sensitive text, without the cloud ever learning who it is about.**

Live demo: https://airlock-hybrid.web.app (desktop Chrome with Gemini Nano for the full experience; any browser works with rule-based protection)

Demo video (2:47): https://youtu.be/nMh4Go0hoWo

Clinics, support desks, HR teams and tenants all have the same problem: the best AI for writing a reply or summarizing a case lives in the cloud, but the text is full of names, phone numbers, addresses and ID numbers that should never leave the device. Airlock splits the job between two models:

| Step | Where it runs | Model / mode |
| --- | --- | --- |
| 1. **Seal**: find every identifier and swap it for a placeholder such as `[PERSON_1]` | On device | Pattern rules + **Gemini Nano** via Firebase AI Logic, `ONLY_ON_DEVICE`, structured JSON output |
| 2. **Review**: see the exact bytes that will leave, with a SHA-256 hash and a local pre-flight scan | On device | — |
| 3. **Think**: draft the reply, summary or action items on placeholder text | Cloud | **Gemini** via Firebase AI Logic, `PREFER_IN_CLOUD` (falls back to Nano when offline) |
| 4. **Unseal**: put the real values back into the answer | On device | Local vault that only exists in the tab's memory |

The small model is trusted with the raw data but only does one narrow job. The large model does the hard reasoning but never sees anything identifying. Privacy comes from *where the code runs*, not from a policy promise.

## What makes the hybrid design work

- **`ONLY_ON_DEVICE` for raw text.** The extractor model is created with `InferenceMode.ONLY_ON_DEVICE`, so the SDK can never route the original text to the cloud, even as a fallback.
- **`PREFER_IN_CLOUD` for the sealed payload.** The heavy task uses the cloud model first. If the network or the cloud model is unavailable, Firebase AI Logic falls back to Gemini Nano automatically, and because the payload is already sealed, the fallback is just as private. The UI shows which model answered (`inferenceSource`), and a *Simulate cloud outage* switch demonstrates the fallback.
- **Defense in depth on device.** Deterministic detectors (emails, phones, Luhn-checked card numbers, IBANs, SSNs, labelled and unlabelled IDs, dates, street addresses) run first and work without any model. Gemini Nano then reads the rule-masked text and returns only people, organizations and places as three compact JSON lists (fast: about 5 s on a MacBook). Every string the model returns is located verbatim in the text, so hallucinations are dropped. Name parts are linked ("Maria" gets the same placeholder as "Maria Delgado"), and Nano takes a **second look** at the redacted text to catch anything missed.
- **Human in the loop.** Click any highlight to let it through, or type a word to hide. The outgoing payload updates live.
- **Keep it all on device.** One click answers with Gemini Nano from the original text, and zero bytes are sent.

## Firebase products used

- **Firebase AI Logic** (Gemini Developer API backend): hybrid inference with `ONLY_ON_DEVICE`, `PREFER_IN_CLOUD`, `initializeDeviceModel`, on-device `responseConstraint` (JSON schema), streaming, and `inferenceSource`.
- **App Check** (reCAPTCHA Enterprise): enforced for AI Logic, so only this app can spend the project's Gemini quota.
- **Anonymous Authentication**: every browser gets a private identity without a sign-up.
- **Cloud Firestore**: *privacy receipts* for every cloud request. Each receipt holds the de-identified payload as sent, its size, SHA-256 and which model answered. Security rules allow only the owner to read or delete receipts, and validate the schema, so a modified client still cannot store original text or the vault.
- **Remote Config**: the cloud model name, the second-look pass and default entity types can change without a redeploy.
- **Hosting**: static site with strict referrer and permissions headers. The page loads no third-party fonts or scripts.

## Run it yourself

```bash
npm install
npm test          # redaction unit tests
npm run dev       # http://localhost:5173 (App Check debug provider on localhost)
npm run deploy    # build + Hosting, Firestore rules, Remote Config
```

To use your own Firebase project, replace the config in `src/firebase.ts`, enable Firebase AI Logic with the Gemini Developer API, register a reCAPTCHA Enterprise key for App Check, and enable Anonymous Auth and Firestore. For local development, register the App Check debug token printed in the browser console.

Gemini Nano needs desktop Chrome on supported hardware. See https://developer.chrome.com/docs/ai/get-started. Without it, Airlock still protects structured identifiers with the pattern rules and says so in the header.

## Code map

- `src/redact/detectors.ts`: deterministic detectors
- `src/redact/ondevice.ts`: the seal pipeline (rules → Gemini Nano → name linking → second look)
- `src/redact/merge.ts`: span resolution, stable placeholders, vault and tolerant re-identification
- `src/firebase.ts`: App Check, Auth, Firestore receipts, Remote Config and the three AI Logic models
- `src/App.tsx`: the two-sided UI with the device boundary in the middle
- `firestore.rules`, `remoteconfig.template.json`

## Limits

Detection is best effort, so review the payload before sending. Context clues (a rare job title, a unique event) can still identify a person, and Airlock is a demo, not a compliance product. All sample data is fictional.

## License

Apache 2.0
